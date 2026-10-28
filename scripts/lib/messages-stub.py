#!/usr/bin/env python3
"""A local Anthropic Messages endpoint that asks Claude Code to run one Bash command. (#259)

    messages-stub.py <record.jsonl> <port-file> <command>

Binds 127.0.0.1 on an ephemeral port and writes the port to <port-file>. Every request body is
appended to <record.jsonl>. The first request that offers a `Bash` tool and carries no tool_result is
answered with a streamed `tool_use` running <command>; a request carrying a tool_result, and any other
request, is answered with a short `end_turn`. No credential is read, and nothing leaves 127.0.0.1.
For scripts/disk-floor-hook-reach.sh, which measures whether the committed hook reaches a session.
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RECORD, PORTFILE, COMMAND = sys.argv[1], sys.argv[2], sys.argv[3]
TOOL_USE_ID = 'toolu_disk_floor_reach_01'
lock = threading.Lock()
asked = {'done': False}


def has_tool_result(req):
    for m in req.get('messages') or []:
        content = m.get('content')
        if isinstance(content, list) and any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
            return True
    return False


def offers_bash(req):
    return any(isinstance(t, dict) and t.get('name') == 'Bash' for t in req.get('tools') or [])


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, events):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('cache-control', 'no-cache')
        self.end_headers()
        for name, data in events:
            self.wfile.write(f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode())
            self.wfile.flush()

    def do_GET(self):
        self._json(200, {'data': [], 'object': 'list'})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length') or 0))
        try:
            req = json.loads(raw or b'{}')
        except ValueError:
            req = {'_raw': raw.decode('utf8', 'replace')}
        with lock, open(RECORD, 'a') as f:
            f.write(json.dumps({'path': self.path, 'body': req}) + '\n')
        if 'count_tokens' in self.path:
            return self._json(200, {'input_tokens': 1})
        model = req.get('model', 'stub')
        usage = {'input_tokens': 1, 'output_tokens': 1}
        with lock:
            ask = offers_bash(req) and not has_tool_result(req) and not asked['done']
            if ask:
                asked['done'] = True
        if ask:
            block = {'type': 'tool_use', 'id': TOOL_USE_ID, 'name': 'Bash', 'input': {}}
            args = json.dumps({'command': COMMAND, 'description': 'Run the command the reach measures'})
            message = {'id': 'msg_reach_1', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
            if not req.get('stream'):
                return self._json(200, {**message, 'content': [{**block, 'input': json.loads(args)}], 'stop_reason': 'tool_use'})
            return self._sse([
                ('message_start', {'type': 'message_start', 'message': message}),
                ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': block}),
                ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': args}}),
                ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
                ('message_stop', {'type': 'message_stop'}),
            ])
        text = {'type': 'text', 'text': 'done'}
        message = {'id': 'msg_reach_2', 'type': 'message', 'role': 'assistant', 'model': model, 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}
        if not req.get('stream'):
            return self._json(200, {**message, 'content': [text], 'stop_reason': 'end_turn'})
        return self._sse([
            ('message_start', {'type': 'message_start', 'message': message}),
            ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'done'}}),
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}}),
            ('message_stop', {'type': 'message_stop'}),
        ])


server = ThreadingHTTPServer(('127.0.0.1', 0), H)
with open(PORTFILE, 'w') as f:
    f.write(str(server.server_address[1]))
server.serve_forever()

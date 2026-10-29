#!/usr/bin/env python3
"""The loopback page's server (#291): 127.0.0.1 only, and every file name is its own.

    server.py <run-dir> <params.json>

Binds an ephemeral port on 127.0.0.1, writes it to <run-dir>/port, and serves the page. The page
cannot name a path: it posts to fixed routes and the server decides where each byte goes.

    GET  /                 page.html
    GET  /page.js, /worklet.js
    GET  /params.json      the run's parameters (requested labels, seconds, test mutations)
    POST /devices          enumerateDevices() as the page sees it; answers the resolved ids or a
                           void reason, from runcheck.resolve, before the page opens any input
    POST /chunk/<track>    raw float32 PCM appended to <run-dir>/<track>.f32; track is pre_send
                           or side_b and nothing else
    POST /event            one JSON line appended to <run-dir>/events.jsonl (ready, stats, done)
    POST /record           the applied record, written to <run-dir>/page-record.json
"""
import http.server
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import runcheck  # noqa: E402

STATIC = {"/": ("page.html", "text/html"), "/page.js": ("page.js", "text/javascript"),
          "/worklet.js": ("worklet.js", "text/javascript")}
TRACKS = ("pre_send", "side_b")


def make_handler(run_dir, params):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            with open(os.path.join(run_dir, "server.log"), "a") as f:
                f.write((fmt % args) + "\n")

        def reply(self, code, body=b"", ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            return self.rfile.read(int(self.headers.get("Content-Length", 0)))

        def do_GET(self):
            if self.path == "/params.json":
                return self.reply(200, json.dumps(params).encode())
            if self.path in STATIC:
                name, ctype = STATIC[self.path]
                with open(os.path.join(HERE, name), "rb") as f:
                    return self.reply(200, f.read(), ctype)
            self.reply(404)

        def do_POST(self):
            data = self.body()
            if self.path == "/devices":
                devices = json.loads(data)
                with open(os.path.join(run_dir, "devices.json"), "w") as f:
                    json.dump(devices, f, indent=1)
                answer = {}
                try:
                    answer["input_device_id"] = runcheck.resolve(devices, "audioinput", params["in"])
                    answer["output_device_id"] = runcheck.resolve(devices, "audiooutput", params["out"])
                except runcheck.Void as v:
                    answer = {"void": str(v)}
                with open(os.path.join(run_dir, "resolved.json"), "w") as f:
                    json.dump(answer, f)
                return self.reply(200, json.dumps(answer).encode())
            if self.path.startswith("/chunk/"):
                track = self.path[len("/chunk/"):]
                if track not in TRACKS:
                    return self.reply(404)
                with open(os.path.join(run_dir, f"{track}.f32"), "ab") as f:
                    f.write(data)
                return self.reply(204)
            if self.path == "/event":
                with open(os.path.join(run_dir, "events.jsonl"), "ab") as f:
                    f.write(data.rstrip(b"\n") + b"\n")
                return self.reply(204)
            if self.path == "/record":
                with open(os.path.join(run_dir, "page-record.json"), "wb") as f:
                    f.write(data)
                return self.reply(204)
            self.reply(404)

    return Handler


def main():
    run_dir, params_path = sys.argv[1], sys.argv[2]
    with open(params_path) as f:
        params = json.load(f)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(run_dir, params))
    with open(os.path.join(run_dir, "port.tmp"), "w") as f:
        f.write(str(server.server_address[1]))
    os.replace(os.path.join(run_dir, "port.tmp"), os.path.join(run_dir, "port"))
    server.serve_forever()


if __name__ == "__main__":
    main()

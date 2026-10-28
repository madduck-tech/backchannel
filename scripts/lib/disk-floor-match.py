#!/usr/bin/env python3
"""Does a shell command compile? The disk-floor hook asks this of every Bash call (#259).

    disk-floor-match.py '<command>'     exits 0 when it compiles, 1 when it does not, 2 on misuse
    disk-floor-match.py --many           a JSON list of commands on stdin, a JSON list of answers out
    disk-floor-match.py --hook           a PreToolUse payload on stdin: compiles<TAB>cwd, skip, or error<TAB>why

A guard against accidents, not a boundary: it reads the command as written, so a command assembled at
run time passes it. What it matches is the table in disk-floor-hook-table.json, held both ways by
frontend/tests/lib/disk-floor-hook.test.mjs:

- `cargo` with a compiling subcommand, after `+toolchain` and global options, by any path, and through
  `rustup run <toolchain> cargo`;
- `tauri build|dev`, as `tauri`, `npx tauri`, `pnpm tauri`, `pnpm exec tauri` or by path;
- every frontend/package.json script that runs tauri, through pnpm, npm or npx pnpm;
- the shell scripts in the table that build, by any path and through bash or sh;

each behind assignments, `env`, `time`, `nice`, `nohup` or `timeout`, after any separator, inside
`( … )` and `$( … )`, and in the string of `bash -c` / `sh -c`. A heredoc's body is data, unless the
heredoc feeds bash or sh: `cat <<EOF` holding `cargo build` writes text, `bash <<EOF` runs it.
"""
import json
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = json.load(open(os.path.join(HERE, 'disk-floor-hook-table.json')))
SCRIPTS = set(TABLE['package_scripts'])
SHELL_SCRIPTS = set(os.path.basename(p) for p in TABLE['shell_scripts'])

COMPILING = {'build', 'b', 'check', 'c', 'clippy', 'test', 't', 'run', 'r', 'bench', 'doc', 'fix', 'rustc', 'nextest'}
CARGO_VALUE_OPTS = {'--color', '-Z', '--config', '-C', '--explain'}
SEPARATORS = {';', '&', '&&', '|', '||', '\n', '(', ')', ';;', '|&'}
SHELLS = {'bash', 'sh', 'dash', 'zsh'}


def tokens(text):
    lex = shlex.shlex(text, posix=True, punctuation_chars=';&|()\n')
    lex.whitespace = ' \t\r'
    lex.commenters = ''
    # Without these a word breaks at them: `tauri:dev` would read as `tauri : dev`, `pnpm@11` as
    # `pnpm @ 11`, `+stable` as `+ stable`, and `${HOME}/.cargo/bin/cargo` in four pieces.
    lex.wordchars += '+@%:,^!${}[]#'
    try:
        return list(lex)
    except ValueError:              # an unbalanced quote: read what can be read
        return text.replace('\n', ' ; ').split()


def substitutions(word):
    """The commands inside `$( … )` and backticks in a word, outermost first."""
    found = []
    i = 0
    while True:
        i = word.find('$(', i)
        if i < 0:
            break
        depth, j = 1, i + 2
        while j < len(word) and depth:
            depth += {'(': 1, ')': -1}.get(word[j], 0)
            j += 1
        found.append(word[i + 2:j - 1])
        i = j
    return found


def drop_heredocs(text):
    """A heredoc's body is data, unless it feeds a shell: then it is kept, as a script."""
    out, lines, i = [], text.split('\n'), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r'<<-?\s*([\'"]?)(\w+)\1', line)
        if m and not re.search(r'<<<', line):
            delim = m.group(2)
            body = []
            i += 1
            while i < len(lines) and lines[i].strip() != delim:
                body.append(lines[i])
                i += 1
            head = tokens(line[:m.start()])
            words = [t for t in head if t not in SEPARATORS]
            if words and os.path.basename(strip_prefix(words)[0] if strip_prefix(words) else '') in SHELLS:
                out.extend(body)
            out.append('')
        i += 1
    return '\n'.join(out)


def strip_prefix(words):
    """Drop assignments and the wrappers that run a command: env, time, nice, nohup, timeout."""
    w = list(words)
    while w:
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w[0]):
            w = w[1:]
        elif w[0] in ('time', 'nohup', 'command', 'exec'):
            w = w[1:]
        elif w[0] == 'env':
            w = w[1:]
            while w and (w[0].startswith('-') or re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w[0])):
                w = w[2:] if w[0] in ('-u', '-C', '--unset', '--chdir', '-S') else w[1:]
        elif w[0] == 'nice':
            w = w[1:]
            if w and w[0] in ('-n', '--adjustment'):
                w = w[2:]
            elif w and re.match(r'^(-\d+|--adjustment=.*|-n\d+)$', w[0]):
                w = w[1:]
        elif w[0] == 'timeout':
            w = w[1:]
            while w and w[0].startswith('-'):
                w = w[2:] if w[0] in ('-s', '-k', '--signal', '--kill-after') else w[1:]
            w = w[1:]                       # the duration
        else:
            break
    return w


def cargo_compiles(args):
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('+'):
            i += 1
        elif a.startswith('-'):
            i += 2 if a in CARGO_VALUE_OPTS else 1
        else:
            return a in COMPILING
    return False


def tauri_builds(args):
    rest = [a for a in args if not a.startswith('-')]
    return bool(rest) and rest[0] in ('build', 'dev')


def simple_compiles(words):
    w = strip_prefix(words)
    if not w:
        return False
    cmd, args = os.path.basename(w[0]), w[1:]
    if cmd == 'cargo':
        return cargo_compiles(args)
    if cmd == 'rustup':
        if len(args) >= 2 and args[0] == 'run':
            return simple_compiles(args[2:])
        return False
    if cmd == 'tauri':
        return tauri_builds(args)
    if cmd == 'node':
        return bool(args) and args[0].endswith('tauri-auto.js') and len(args) > 1 and args[1] in ('build', 'dev')
    if cmd == 'npx':
        while args and args[0].startswith('-'):
            args = args[2:] if args[0] in ('-p', '--package') else args[1:]
        if not args:
            return False
        if os.path.basename(args[0]) == 'tauri':
            return tauri_builds(args[1:])
        if re.match(r'^pnpm(@.*)?$', args[0]):
            return pnpm_compiles(args[1:])
        return False
    if re.match(r'^pnpm(@.*)?$', cmd):
        return pnpm_compiles(args)
    if cmd == 'npm':
        while args and args[0].startswith('-'):
            args = args[2:] if args[0] in ('--prefix', '-C', '-w', '--workspace') else args[1:]
        return len(args) >= 2 and args[0] in ('run', 'run-script', 'rum', 'urn') and args[1] in SCRIPTS
    if cmd in SHELLS:
        if '-c' in args:
            i = args.index('-c')
            return i + 1 < len(args) and compiles(args[i + 1])
        script = next((a for a in args if not a.startswith('-')), None)
        return script is not None and os.path.basename(script) in SHELL_SCRIPTS
    return cmd in SHELL_SCRIPTS


def pnpm_compiles(args):
    while args and args[0].startswith('-'):
        args = args[2:] if args[0] in ('-C', '--dir', '--filter', '-F', '--workspace-root', '--reporter') and '=' not in args[0] else args[1:]
    if not args:
        return False
    if args[0] == 'exec':
        return simple_compiles(args[1:])
    if args[0] in ('run', 'run-script'):
        return len(args) >= 2 and args[1] in SCRIPTS
    return args[0] in SCRIPTS


def compiles(text):
    # A line that starts with `#` is a comment, and runs nothing. (A comment after a command is left in:
    # its words follow the command's and do not change what the command is.)
    text = '\n'.join(l for l in text.split('\n') if not l.lstrip().startswith('#'))
    text = drop_heredocs(text)
    # Backticks, read in the text: the tokenizer splits their contents across words.
    for inner in re.findall(r'`([^`]*)`', text):
        if compiles(inner):
            return True
    words, found = [], False
    for t in tokens(text) + [';']:
        if t in SEPARATORS:
            if words and simple_compiles(words):
                return True
            words = []
            continue
        for inner in substitutions(t):
            if compiles(inner):
                return True
        if t != '$':
            words.append(t)
    return found


if __name__ == '__main__':
    if sys.argv[1:] == ['--hook']:      # a PreToolUse payload on stdin: "compiles<TAB>cwd", "skip", or "error<TAB>why"
        try:
            d = json.load(sys.stdin)
            command, cwd = (d.get('tool_input') or {}).get('command'), d.get('cwd')
            if not isinstance(command, str) or not isinstance(cwd, str):
                raise ValueError('no command or cwd')
        except Exception as e:  # noqa: BLE001 - any unreadable payload is reported, never raised
            print('error\t' + str(e).replace('\n', ' '))
            sys.exit(0)
        print('compiles\t' + cwd if compiles(command) else 'skip')
        sys.exit(0)
    if sys.argv[1:] == ['--many']:      # a JSON list of commands on stdin; a JSON list of answers out
        print(json.dumps([compiles(c) for c in json.load(sys.stdin)]))
        sys.exit(0)
    if len(sys.argv) != 2:
        print(__doc__.split('\n\n')[1], file=sys.stderr)
        sys.exit(2)
    sys.exit(0 if compiles(sys.argv[1]) else 1)

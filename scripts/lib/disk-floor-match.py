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

each behind assignments, `env`, `time`, `nice`, `nohup`, `timeout`, `xargs` or a reserved word (`if`,
`then`, `do`, `{`, `!`, …), after any separator, inside `( … )`, and in the string of `bash -c` /
`sh -lc`. Quotes are read as bash reads them: `$( … )` and backticks run outside single quotes, and are
text inside them; a `#` that starts a word starts a comment; a backslash-newline joins two lines.

A heredoc's body is data, unless bash runs it: it is a script when the heredoc feeds bash or sh
(`bash <<EOF`, `cat <<EOF | bash`), and with an unquoted delimiter its `$( … )` and backticks run
(`cat <<EOF` holding `` `cargo build` ``). `cat <<'EOF'` holding either is text.
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

COMPILING = {'build', 'b', 'check', 'c', 'clippy', 'test', 't', 'run', 'r', 'bench', 'doc', 'fix', 'rustc', 'nextest',
             'install', 'miri', 'rustdoc'}
CARGO_VALUE_OPTS = {'--color', '-Z', '--config', '-C', '--explain'}
SEPARATORS = {';', '&', '&&', '|', '||', '\n', '(', ')', ';;', '|&'}
SHELLS = {'bash', 'sh', 'dash', 'zsh'}
# Words in front of a command that run it: `if cargo test; then`, `do cargo build`, `{ cargo b; }`.
RESERVED = {'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc'}
HEREDOC = re.compile(r'<<(-?)\s*(\\?)([\'"]?)([^\s\'"<>;|&()`]+)\3')


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


def scan(text, quotes=True):
    """Read `text` as bash reads quotes. Returns it with comments removed and every substitution
    blanked, and the commands those substitutions run: `$( … )` and backticks, outside single quotes.

    With quotes=False it reads a heredoc body, where quotes are characters and `#` starts nothing."""
    out, subs, i, n, state, word_start = [], [], 0, len(text), None, True
    while i < n:
        ch = text[i]
        if state == "'":
            out.append(ch)
            state = None if ch == "'" else state
            i += 1
            continue
        if ch == '\\' and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            word_start = False
            continue
        if quotes and ch == "'" and state is None:
            state = "'"
        elif quotes and ch == '"':
            state = None if state == '"' else '"'
        elif quotes and ch == '#' and state is None and word_start:
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        elif ch == '`':
            j = i + 1
            while j < n and text[j] != '`':
                j += 2 if text[j] == '\\' else 1
            subs.append(text[i + 1:j])
            out.append(' ')
            i = j + 1
            word_start = False
            continue
        elif text.startswith('$(', i) and not text.startswith('$((', i):
            depth, j, q = 1, i + 2, None
            while j < n and depth:
                c = text[j]
                if q:
                    q = None if c == q else q
                elif c in '\'"':
                    q = c
                elif c == '\\':
                    j += 1
                else:
                    depth += {'(': 1, ')': -1}.get(c, 0)
                j += 1
            subs.append(text[i + 2:j - 1])
            out.append(' ')
            i = j
            word_start = False
            continue
        out.append(ch)
        word_start = state is None and ch in ' \t\n;&|()'
        i += 1
    return ''.join(out), subs


def first_command(words):
    """The words of the last simple command in `words`, after its separators."""
    seg = []
    for w in words:
        seg = [] if w in SEPARATORS else seg + [w]
    return seg


def is_shell(words):
    w = strip_prefix(words)
    return bool(w) and os.path.basename(w[0]) in SHELLS and shell_c_index(w[1:]) is None


def drop_heredocs(text):
    """Heredoc bodies out of the text. Returns the text and the commands bash runs from them: the whole
    body when the heredoc feeds a shell, else, with an unquoted delimiter, its substitutions."""
    out, subs, lines, i = [], [], text.split('\n'), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = HEREDOC.search(line)
        if m and '<<<' not in line:
            delim, literal = m.group(4), bool(m.group(2) or m.group(3))
            body = []
            i += 1
            while i < len(lines) and lines[i].strip() != delim:
                body.append(lines[i])
                i += 1
            # Fed to a shell: the command it belongs to is one, or the line pipes into one.
            fed = is_shell(first_command(tokens(line[:m.start()])))
            rest, cur = tokens(line[m.end():]) + [';'], None
            for w in rest:
                if w in ('|', '|&'):
                    cur = []
                elif w in SEPARATORS:
                    fed = fed or (cur is not None and is_shell(cur))
                    cur = None
                elif cur is not None:
                    cur.append(w)
            if fed:
                out.extend(body)
            elif not literal:
                subs.extend(scan('\n'.join(body), quotes=False)[1])
            out.append('')
        i += 1
    return '\n'.join(out), subs


def strip_prefix(words):
    """Drop assignments and the wrappers that run a command: env, time, nice, nohup, timeout."""
    w = list(words)
    while w:
        base = os.path.basename(w[0])
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w[0]) or w[0] in RESERVED:
            w = w[1:]
        elif base in ('nohup', 'command', 'exec'):
            w = w[1:]
        elif base == 'time':
            w = w[1:]
            while w and w[0].startswith('-'):
                w = w[2:] if w[0] in ('-f', '-o', '--format', '--output') else w[1:]
        elif base == 'xargs':
            w = w[1:]
            while w and w[0].startswith('-'):
                w = w[2:] if w[0] in ('-n', '-P', '-I', '-L', '-d', '-E', '-s', '-a', '--max-args', '--max-procs',
                                      '--delimiter', '--arg-file') else w[1:]
        elif base == 'env':
            w = w[1:]
            while w and (w[0].startswith('-') or re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', w[0])):
                w = w[2:] if w[0] in ('-u', '-C', '--unset', '--chdir', '-S') else w[1:]
        elif base == 'nice':
            w = w[1:]
            if w and w[0] in ('-n', '--adjustment'):
                w = w[2:]
            elif w and re.match(r'^(-\d+|--adjustment=.*|-n\d+)$', w[0]):
                w = w[1:]
        elif base == 'timeout':
            w = w[1:]
            while w and w[0].startswith('-'):
                w = w[2:] if w[0] in ('-s', '-k', '--signal', '--kill-after') else w[1:]
            w = w[1:]                       # the duration
        else:
            break
    return w


def cargo_compiles(args):
    # `--help` and `--version` print and exit, wherever they stand before `--`; after it they go to the
    # binary `cargo run` or `cargo test` has compiled.
    own = args[:args.index('--')] if '--' in args else args
    if any(a in ('--help', '-h', '--version', '-V') for a in own):
        return False
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


def shell_c_index(args):
    """Where a shell's command string flag is: `-c`, or `-c` among short flags (`-lc`, `-ec`)."""
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('-o', '+o', '-O', '+O', '--rcfile', '--init-file'):
            i += 2
        elif re.match(r'^-[A-Za-z]*c[A-Za-z]*$', a):
            return i
        elif a.startswith(('-', '+')):
            i += 1
        else:
            return None
    return None


def tauri_cli(word):
    return os.path.basename(word) == 'tauri' or re.match(r'^@tauri-apps/cli(@.*)?$', word) is not None


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
        if tauri_cli(args[0]):
            return tauri_builds(args[1:])
        if re.match(r'^pnpm(@.*)?$', args[0]):
            return pnpm_compiles(args[1:])
        return False
    if re.match(r'^pnpm(@.*)?$', cmd):
        return pnpm_compiles(args)
    if cmd == 'npm':
        while args and args[0].startswith('-'):
            args = args[2:] if args[0] in ('--prefix', '-C', '-w', '--workspace') else args[1:]
        if args and args[0] in ('exec', 'x'):
            rest = [a for a in args[1:] if not a.startswith('-')]
            return bool(rest) and (tauri_builds(rest[1:]) if tauri_cli(rest[0]) else simple_compiles(rest))
        rest = [a for a in args[1:] if not a.startswith('-')]
        return bool(args) and args[0] in ('run', 'run-script', 'rum', 'urn') and bool(rest) and rest[0] in SCRIPTS
    if cmd in SHELLS:
        i = shell_c_index(args)
        if i is not None:
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
        rest = [a for a in args[1:] if not a.startswith('-')]
        return bool(rest) and rest[0] in SCRIPTS
    return args[0] in SCRIPTS


def compiles(text):
    # A line that starts with `#` is a comment, and runs nothing; so is the rest of a line from a `#`
    # that starts a word, which scan() drops. A backslash-newline joins two lines into one.
    text = '\n'.join(l for l in text.split('\n') if not l.lstrip().startswith('#')).replace('\\\n', '')
    text, ran = drop_heredocs(text)
    text, subs = scan(text)
    if any(compiles(inner) for inner in ran + subs):
        return True
    words = []
    for t in tokens(text) + [';']:
        if t in SEPARATORS:
            if words and simple_compiles(words):
                return True
            words = []
            continue
        if t != '$':
            words.append(t)
    return False


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

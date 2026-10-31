"""Run a command with its output on a pipe, and read that pipe at RATE bytes a second, as a slow reader
on the far side of `| …` does, passing on what it reads. A signal this process receives is passed to the
command. Exits with the command's status. A helper for test-runner-bounds-each-file.test.mjs: on a
pipe, Node hands queued writes over as one, so a reader that is slow but steady shows no progress to
`writableLength` until the whole of it is out.

    read-slowly-on-a-pipe.py RATE COMMAND...
"""
import signal, subprocess, sys, time

rate, command = int(sys.argv[1]), sys.argv[2:]
p = subprocess.Popen(command, stdout=subprocess.PIPE, bufsize=0)
for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGUSR2):
    signal.signal(sig, lambda s, _frame: p.send_signal(s))
# Each 50 ms tick takes at most its share, in one read, then waits out the rest of the tick.
share = max(1, rate // 20)
while True:
    tick = time.time()
    data = p.stdout.read(share)
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    time.sleep(max(0.0, 0.05 - (time.time() - tick)))
code = p.wait()
sys.exit(128 - code if code < 0 else code)

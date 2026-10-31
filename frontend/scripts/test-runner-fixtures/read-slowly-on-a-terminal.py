"""Run a command on a new pseudo-terminal and read what it writes at no more than RATE bytes a second, as
a slow terminal drains, until the command has ended, passing on what it reads. A pty hands over a few KiB
a read, so the rate reached is lower: about 1.8 MiB/s at a RATE of 4 MiB/s (#268's gate adversary,
round 10). Exits with the command's status.
A helper for test-runner-bounds-each-file.test.mjs: Node writes to a terminal synchronously, so a slow
one holds the runner's event loop for as long as a large report takes.

    read-slowly-on-a-terminal.py RATE COMMAND...
"""
import os, pty, select, sys, time

rate, command = int(sys.argv[1]), sys.argv[2:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
# A pty hands over a few KiB a read, so each 50 ms tick reads until its share is in, then waits out
# the rest of the tick.
share = max(1, rate // 20)
while True:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(128 - code if code < 0 else code)
    tick, got = time.time(), 0
    while got < share:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            break
        try:
            data = os.read(master, share - got)
        except OSError:
            break
        got += len(data)
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    time.sleep(max(0.0, 0.05 - (time.time() - tick)))

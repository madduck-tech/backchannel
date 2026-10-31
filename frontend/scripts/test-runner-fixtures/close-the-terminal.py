"""Run a command on a new pseudo-terminal, as its controlling terminal, and close the terminal when
this process receives SIGUSR1, as a closed terminal window or a dropped SSH session does. Exits with
the command's status once it has ended, or 99 if it has not 20 s later. A helper for
test-runner-bounds-each-file.test.mjs, which sends the signal half a second after it samples the run.

    close-the-terminal.py COMMAND...
"""
import os, pty, select, signal, sys, time

closing = []
signal.signal(signal.SIGUSR1, lambda *_: closing.append(True))
command = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
while not closing:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            os.read(master, 65536)
        except OSError:
            break
os.close(master)
for _ in range(400):
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(128 - code if code < 0 else code)
    time.sleep(0.05)
os.kill(pid, 9)
sys.exit(99)

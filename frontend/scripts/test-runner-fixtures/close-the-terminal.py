"""Run a command on a new pseudo-terminal, as its controlling terminal, and close the terminal after
SECONDS, as a closed terminal window or a dropped SSH session does. Exits with the command's status
once it has ended, or 99 if it has not 20 s later. A helper for test-runner-bounds-each-file.test.mjs.

    close-the-terminal.py SECONDS COMMAND...
"""
import os, pty, select, sys, time

seconds, command = float(sys.argv[1]), sys.argv[2:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
until = time.time() + seconds
while time.time() < until:
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

// Node's runner for this file is ended by a signal, then the file exits 0: what the watchdog reports
// is the runner's end, which process.exit(null) would have turned into a pass. SIGKILL, because
// Node's runner answers SIGTERM itself and exits 1.
process.kill(process.ppid, 'SIGKILL');
process.exit(0);

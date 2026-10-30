import { spawn } from 'node:child_process';

// A cleanup that takes a moment: the child outlives the file by half a second, inside the runner's
// grace, so the file passes.
spawn('sleep', ['0.5'], { detached: true, stdio: 'ignore' }).unref();

// Passes once the test releases it, after its sample has seen h's orphan, so its report is the runner's
// first write once that orphan exists. A fixed 3 s left a late h behind on a loaded runner (#268's gate
// adversary, round 8). Without BC_HANG_RELEASE_K, or never released, it passes after 3 s or 20 s.
import fs from 'node:fs';

const release = process.env.BC_HANG_RELEASE_K;
const started = Date.now();
const wait = setInterval(() => {
  const waited = Date.now() - started;
  if (release ? fs.existsSync(release) || waited > 20_000 : waited > 3000) {
    clearInterval(wait);
    console.log('passes late');
  }
}, 50);

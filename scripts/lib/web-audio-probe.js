// What Web Audio does in the running application, sent by `execute/async`. (#173)
//
// Until #173 the AppImage had no GStreamer plugins, so WebKit could not build an audio sink and every
// context stayed `suspended`. A probe that records only `.then()` cannot tell a rejected `resume()`
// from a pending one, and the two mean different things: a rejection is the missing sink WebKit's
// source predicts (`InvalidStateError`, "Failed to start the audio device"); a pending promise points
// at a second blocker. So all three outcomes are recorded, and the context is closed on every path.
const done = arguments[arguments.length - 1];
let ctx;
try {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
} catch (e) {
  done(JSON.stringify({ constructed: false, error: String(e && e.message || e) }));
  return;
}
const initial = ctx.state;
let resume = 'pending';
ctx.resume().then(() => { resume = 'resolved'; }, (e) => { resume = 'rejected: ' + String(e && (e.name + ': ' + e.message) || e); });
setTimeout(() => {
  const final = ctx.state;
  const report = () => done(JSON.stringify({ constructed: true, initial, final, resume }));
  ctx.close().then(report, report);
}, 3000);

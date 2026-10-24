// What the first-run audio check's microphone row shows, read and classified. (#167, #168)
//
// One definition, loaded by every place that judges this screen. `scripts/lib/audio-check.sh`
// sends this file as the body of a WebDriver `execute/sync` script, and
// `frontend/tests/lib/audio-check-oracle.test.mjs` runs the same text against the component rendered
// in jsdom. So the control on the matcher exercises the matcher the gate uses, not a copy. A copy is
// how a control here last did nothing.
//
// **A function body, not a module.** WebDriver runs a script as the body of a function, so the file
// ends in a top-level `return`. The test wraps it in `new Function` for the same reason.
//
// It returns a JSON string, so both callers parse one shape:
//   { found, button, disabled, device, outcome, decoded, kind, sampleWords }
//
// **The decoded text is read alone.** `Heard: <b>{text}</b>` is the only place the decoder's words
// appear. The step's fixed copy already contains four words of the sample (`and`, `not`, `you`,
// `your`), so a match over `document.body.innerText` passes on any decode at all. The step strip also
// uses `<b>` for its numbers, which is why the `<b>` is found inside the outcome and nowhere else.
var SAMPLE = ['and', 'so', 'my', 'fellow', 'americans', 'ask', 'not', 'what', 'your', 'country', 'can', 'do', 'for', 'you'];
// Every error `check_capture_device` itself returns (`device_check.rs`). Anything else on the row is
// not the command's body answering: `Command check_capture_device not found` (#167), a Tauri argument
// error, or a model load that failed.
var BODY_ERRORS = [
  'A recording is in progress',
  'No transcription model is loaded',
  'Could not list audio devices',
  'No input device called',
  'No output device called',
  'Could not open',
  'Could not transcribe what',
];
// Which row: its picker's `aria-label`, passed as the script's first argument. The microphone row by
// default; the system row is `The other side is heard through`.
var label = (typeof arguments !== 'undefined' && arguments[0]) || 'Microphone';
var trigger = Array.prototype.find.call(document.querySelectorAll('button[aria-label]'), function (b) {
  return b.getAttribute('aria-label') === label;
});
var row = trigger && trigger.parentElement;
var actions = row && row.lastElementChild;
var button = actions && actions.querySelector('button');
if (!button) return JSON.stringify({ found: false });
var outcome = Array.prototype.filter
  .call(actions.childNodes, function (n) { return n !== button; })
  .map(function (n) { return n.textContent; })
  .join('')
  .trim();
var bold = actions.querySelector('span b');
var decoded = outcome.indexOf('Heard:') === 0 && bold ? bold.textContent.trim() : '';
var kind = 'NONE';
if (outcome) {
  if (outcome.indexOf('Heard:') === 0) kind = 'HEARD';
  else if (outcome.indexOf('Nothing arrived.') === 0) kind = 'SILENT';
  else if (outcome === 'Audio arrived, but nothing came back as words.') kind = 'NO_WORDS';
  else if (BODY_ERRORS.some(function (p) { return outcome.indexOf(p) === 0; })) kind = 'BODY_ERROR';
  else kind = 'OTHER';
}
var seen = {};
decoded.toLowerCase().split(/\s+/).forEach(function (w) {
  w = w.replace(/[^a-z0-9]/g, '');
  if (SAMPLE.indexOf(w) >= 0) seen[w] = true;
});
return JSON.stringify({
  found: true,
  button: button.textContent.trim(),
  disabled: button.disabled === true,
  device: trigger.textContent.trim(),
  outcome: outcome,
  decoded: decoded,
  kind: kind,
  sampleWords: Object.keys(seen).length,
});

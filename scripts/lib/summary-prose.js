// What the summary panel says in prose, as the core pass judges it. (#171)
//
// One definition, loaded by both places that judge it. `scripts/stage2-core-check.sh` sends this file as
// the body of a WebDriver `execute/sync` script, and `frontend/tests/lib/summary-prose-oracle.test.mjs`
// runs the same text over editor DOMs in jsdom. A function body, not a module: WebDriver runs a script as
// the body of a function, so the file ends in a top-level `return`.
//
// Prose is the text of the editor's blocks, without:
//   - headings;
//   - blocks whose whole text is bold. The template's section titles are bold paragraphs, in whatever
//     language the summary was written: the `unscored` mode's summary is translated, titles included,
//     so a list of English titles let four Russian ones through as prose (#171's gate, round 2);
//   - a block's text a second time. "None noted in this section", in whatever language, repeats once
//     per empty section, and prose does not.
//
// Characters are counted as the string's length without whitespace, not bytes: `wc -c` counted a
// Cyrillic letter twice.
//
// Returns a JSON string: { prose, chars, titles, repeats, blocks }.
var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-content-type]'));
var seen = {};
var out = [];
var titles = 0;
var repeats = 0;
blocks.forEach(function (b) {
  if (b.getAttribute('data-content-type') === 'heading') return;
  var t = (b.textContent || '').trim();
  if (!t) return;
  var bold = Array.prototype.slice.call(b.querySelectorAll('strong, b'))
    .map(function (e) { return e.textContent; }).join('').trim();
  if (bold === t) { titles++; return; }
  if (seen[t]) { repeats++; return; }
  seen[t] = true;
  out.push(t);
});
var prose = out.join(' ');
return JSON.stringify({
  prose: prose,
  chars: prose.replace(/\s/g, '').length,
  titles: titles,
  repeats: repeats,
  blocks: blocks.length,
});

// How many action items the summary panel shows, as the core pass counts them. (#171)
//
// The cross-check beside `summary::due_slots`: the counter reads the stored markdown, this reads the
// editor, and the two counts must agree on the same summary. One definition, loaded by
// `scripts/stage2-core-check.sh` as a WebDriver script body and by
// `frontend/tests/lib/summary-prose-oracle.test.mjs` over BlockNote's own HTML. A function body: the
// file ends in a top-level `return`.
//
// Counted: list blocks (`checkListItem`, `bulletListItem`, `numberedListItem`, BlockNote 0.53) after the
// `Action Items` title and before the next title, a paragraph whose whole text is bold. Only top-level
// ones: BlockNote renders a nested line as a block of its own, where the counter reads it as part of
// the item above (#171's gate, round 2).
//
// Returns a JSON string: { items, nested }.
var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-content-type]'));
var inside = false;
var items = 0;
var nested = 0;
blocks.forEach(function (b) {
  var type = b.getAttribute('data-content-type');
  var t = (b.textContent || '').trim();
  var list = /^(checkListItem|bulletListItem|numberedListItem)$/.test(type);
  var bold = Array.prototype.slice.call(b.querySelectorAll('strong, b'))
    .map(function (e) { return e.textContent; }).join('').trim();
  if (!list && (type === 'heading' || (t && bold === t))) {
    inside = t.replace(/:$/, '') === 'Action Items';
    return;
  }
  if (!inside || !list) return;
  var container = b.closest('[data-node-type=blockContainer]');
  var parent = container && container.parentElement && container.parentElement.closest('[data-node-type=blockContainer]');
  if (parent) { nested++; return; }
  items++;
});
return JSON.stringify({ items: items, nested: nested });

// The meeting page's action bar, measured in the running application. (#165)
//
// A function body, run by `stage2-core-check.sh` through WebDriver's `execute/sync`. It returns a JSON
// string: the room the bar has (its wrapper's content width), the bar's box, the height one row
// allows, how many rendered controls lie outside its content box, which of the three wide controls
// are rendered, and whether `•••` is. The same quantities `the-action-bar-is-one-row.test.mjs` reads in
// Chrome; here they are read in WebKitGTK, at the window the pass runs.
var bar = document.querySelector('[role="toolbar"][aria-label="Meeting actions"]');
if (!bar) return JSON.stringify({ found: false });
var cs = getComputedStyle(bar), px = function (k) { return parseFloat(cs[k]); };
var rendered = function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
var items = [];
Array.prototype.forEach.call(bar.children, function (c) {
  if (getComputedStyle(c).display === 'contents') items.push.apply(items, c.children); else items.push(c);
});
var boxes = items.filter(rendered).map(function (e) { return e.getBoundingClientRect(); });
var br = bar.getBoundingClientRect(), wrap = bar.parentElement, ws = getComputedStyle(wrap);
var room = wrap.getBoundingClientRect().width - parseFloat(ws.paddingLeft) - parseFloat(ws.paddingRight) - parseFloat(ws.borderLeftWidth) - parseFloat(ws.borderRightWidth);
var content = { l: br.left + px('borderLeftWidth') + px('paddingLeft'), r: br.right - px('borderRightWidth') - px('paddingRight'),
  t: br.top + px('borderTopWidth') + px('paddingTop'), b: br.bottom - px('borderBottomWidth') - px('paddingBottom') };
var words = function (w) { return Array.prototype.some.call(bar.querySelectorAll('button'), function (b) { return b.textContent.trim() === w && rendered(b); }); };
return JSON.stringify({
  found: true, room: room, width: br.width, height: br.height, innerWidth: innerWidth,
  oneRowMax: Math.max.apply(null, boxes.map(function (b) { return b.height; })) + px('paddingTop') + px('paddingBottom') + px('borderTopWidth') + px('borderBottomWidth') + 1,
  outside: boxes.filter(function (b) { return b.left < content.l - 0.5 || b.right > content.r + 0.5 || b.top < content.t - 0.5 || b.bottom > content.b + 0.5; }).length,
  three: ['Retranscribe', 'Speakers', 'Open folder'].filter(words),
  trigger: rendered(bar.querySelector('[aria-label="More actions"]'))
});

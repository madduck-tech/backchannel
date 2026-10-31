// Which of fonts.css's faces WebKit would draw a text with, sent by `execute/async`. (#264)
//
// The fonts were chosen from headless Chrome renders, and the application draws with WebKitGTK here
// (WKWebView and WebView2 elsewhere). `document.fonts.load(font, text)` is the engine's own answer to
// "which faces would draw this text": it loads them and returns those whose unicode-range covers the
// text. So for each of the ten faces it asks twice: for 'a0ж→', which must be that face, loaded at its
// weight and style; and for each symbol the product owner left to the system, which must match no face.
// It reads no element of the application, so it does not see whether the application's text uses these
// faces, and it does not see which file a face came from: fonts-ship-in-the-repository.test.mjs reads
// that from fonts.css. fonts-verdict.py holds the answer to FACES and SYMBOLS, so the loops below
// cannot drop a face or a symbol from it unnoticed; it cannot see whether they asked WebKit.
const done = arguments[arguments.length - 1];
const FACES = [
  ['IBM Plex Sans', '400', 'normal'], ['IBM Plex Sans', '500', 'normal'], ['IBM Plex Sans', '600', 'normal'],
  ['IBM Plex Sans', '700', 'normal'], ['IBM Plex Serif', '400', 'normal'], ['IBM Plex Serif', '400', 'italic'],
  ['IBM Plex Serif', '600', 'normal'], ['IBM Plex Serif', '600', 'italic'], ['IBM Plex Mono', '400', 'normal'],
  ['IBM Plex Mono', '500', 'normal'],
];
const SYMBOLS = ['✓', '❌', '◊', '⬎'];
const name = (f) => [f.family.replace(/^["']|["']$/g, ''), String(f.weight), f.style, f.status].join('|');
(async () => {
  await document.fonts.ready;
  const faces = [];
  for (const [family, weight, style] of FACES) {
    const spec = `${style} ${weight} 16px "${family}"`;
    const text = (await document.fonts.load(spec, 'a0ж→')).map(name);
    const symbols = {};
    for (const s of SYMBOLS) symbols[s] = (await document.fonts.load(spec, s)).map(name);
    faces.push({ face: `${family} ${weight} ${style}`, text, symbols });
  }
  done(JSON.stringify({ faces }));
})().catch((e) => done(JSON.stringify({ error: String(e && e.message || e) })));

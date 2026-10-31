# 0035 — IBM Plex ships in the repository as IBM's own files, loaded by plain `@font-face`, with the symbols left to the system

Date: 2026-10-28
Status: accepted

## Context

Every build fetched IBM Plex from Google through Next's font loader, and on 2026-10-27 a CI build failed when Google answered in a form the loader did not parse (#264). Shipping the fonts in the repository raised three questions that someone would otherwise have to rediscover from the code.

- **Whose files.** IBM Plex is under the SIL Open Font License 1.1 with the Reserved Font Name "Plex". OFL §3 forbids a Modified Version from using that name without IBM's written permission, and a Modified Version includes a subset and a converted copy. Google's files are per-script subsets, so committing them would ship a "Plex" that IBM did not make. #222's prototype fixtures face the same question.
- **How they load.** `next/font/local` resolves each file through webpack, but under `@storybook/nextjs` 10.6 it renames the family to `font-<hash>`. The Storybook calibration test asserts that the face is `IBM Plex Sans`, and that test is what keeps the catalogue's geometry honest (#124).
- **What changes on screen.** IBM's complete files are not Google's subsets.
  - They carry the OpenType `zero` feature, which `globals.css` has always asked for on `.readout`. Google's files lacked it, so the zero was dotted.
  - They kern a Cyrillic letter against ASCII punctuation, which Google's split files never did: "Т." sets 1.0–1.7 px tighter.
  - They draw the arrows, the maths and, in the pictographic blocks, ◊ ✓ ❌ and ⬎⬏⬐⬑, where Google's subsets left those characters to the system.

  The gate adversary measured all three in headless Chrome. The product owner saw both renders on 2026-10-28.

## Decision

1. **The ten faces are IBM's `complete/woff2` files, unmodified,** at each family's release tag: `@ibm/plex-sans@1.1.0`, `@ibm/plex-serif@2.0.0` and `@ibm/plex-mono@2.5.0`.
   - `frontend/src/app/fonts/SOURCES.md` records each file's URL and sha256.
   - IBM's `LICENSE.txt` sits beside them, and a byte-identical copy under `frontend/public/` ships inside the app.
   - `.gitattributes` marks them `-text`, so no checkout rewrites a byte.
   - No subset, conversion or rename of a Plex file is ever committed.
2. **They load through plain `@font-face` rules** in `frontend/src/app/fonts.css`, imported by `globals.css`.
   - The `--font-*` variables live on `:root`.
   - The three metric-adjusted fallback faces are copied verbatim from what Next's loader generated, so text drawn before the files load keeps the box it had. Once they load, Plex's own metrics govern, as before. Line metrics on Windows (Serif's `usWinAscent`/`usWinDescent` differ from Google's) are not measured.
3. **Each face leaves the pictographic blocks to the system** through `unicode-range`: Miscellaneous Technical, Enclosed Alphanumerics, Geometric Shapes, Miscellaneous Symbols, Dingbats, Miscellaneous Symbols and Arrows, and everything from U+10000.
   - This was the product owner's choice of 2026-10-28, from three options. The slashed zero, the arrows, the maths and the kerning come from IBM's files.
   - The symbols draw as they did before, so a summary's ❌ keeps its colour beside its ✅.
4. **No build reaches Google's font service.**
   - A test reads every frontend file git sees for the four strings that would bring it back.
   - CI reads the built `frontend/out` after the AppImage build, which covers a dependency's stylesheet. That step is in `stage2-artifact.yml`, which is not a required check: what fails a pull request is the test.
5. **WebKit is asked which faces it would draw with.** Stage 2's `stage2-ui-check.sh` runs `scripts/lib/fonts-probe.js` in the built app. For each of the ten faces, `document.fonts.load` must return exactly that face, loaded, for a text, and no face for ✓ ❌ ◊ ⬎. `fonts-verdict.py` holds the answer to the probe's own lists of faces and symbols. The probe reads no element of the app: that the text resolves to these faces is held in Chrome, by `storybook-calibration.test.mjs` on a story's element. Which file each face names is read from `fonts.css` by `fonts-ship-in-the-repository.test.mjs`: the probe sees that a face loaded, not which file it came from. The fonts were chosen from Chrome renders; this is the engine Linux ships.

## Consequences

- **A font upgrade** is a new IBM tag: new files, new rows in `SOURCES.md`, the tag in `fonts-ship-in-the-repository.test.mjs`, and Stage 2's font probe, rerun. The widths the product owner compared were measured in Chrome and are not a committed check.
- **#222's fixtures** follow decision 1: IBM's files, never Google's.
- **Showing the licence inside the app** is #269.
- **`--webpack`** was kept because of Turbopack's Google font loader. That reason is gone; dropping the flag is its own change.

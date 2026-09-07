// The design system package holds to OpenDesign's authoring contract.
//
// #115. This repository had **no check on the design contour at all** --
// `grep -rl "tokens.css\|design/backchannel\|opendesign" tests/` returned nothing. The design system
// was a document nobody verified, feeding an agent nobody constrained.
//
// **Why this reimplements criteria instead of calling OpenDesign's guard.** Three reasons, each
// sufficient on its own: `open-design` and `@open-design/contracts` are `"private": true` and
// unpublished; all three upstream check scripts hardcode
// `path.join(import.meta.dirname, "..", "design-systems")` and accept no arguments; and `pnpm test`
// runs on a GitHub runner where `~/.local/opt/open-design` does not exist. A check that only runs on
// the maintainer's laptop is what `.claude/rules/testing.md` calls "a test nothing runs".
//
// **Why the package is deliberately invisible to the upstream guard.** It is registered by symlink,
// and `discoverManifestBrandRoots` filters on `entry.isDirectory()`, which is false for one. Replacing
// the symlink with a directory would make it a *copy that drifts* -- the defect this file exists to
// prevent, since today the repository **is** the registration -- and it would turn the upstream guard
// red, because four `preview` checks are ungated (`previewPages = manifest.preview?.pages ?? []`, then
// `recordMinimum` unconditionally) and `preview/` is out of scope. Green-because-unseen and
// red-because-incomplete are both worse than checking it here.
//
// **What this does not hold.** Token *equality* between the design system and the application. The two
// use different vocabularies on purpose (`--surface-warm` is the app's `--panel`), and measured at
// #115 every mapped pair agreed -- so the hand-sync ADR 0011 decision 2 describes is working. It is
// simply unenforced, and enforcing it needs the generated-config change that issue cut from scope.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..', '..', '..', 'design', 'backchannel');
const read = (name) => fs.readFileSync(path.join(pkg, name), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const tokensCss = read('tokens.css');
const designMd = read('DESIGN.md');
const usageMd = read('USAGE.md');
const fixtureHtml = read('components.html');

/** Declared custom properties, by name. */
const declaredTokens = new Set(
  [...tokensCss.matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1])
);

// --- 1: the manifest parses under the contract the package claims -------------------------------
//
// It did not, for as long as the package existed. `source.type: "local"` carried `origin`, which
// belongs to `bundled` -- `ALLOWED_SOURCE_KEYS` is `local: {type, path, importedAt}`. The upstream
// parser rejected it and the walk did `continue`, so the package was skipped in silence. Silence is
// the failure mode this whole file is about.
{
  assert.equal(
    manifest.schemaVersion,
    'od-design-system-project/v1',
    'the package declares a schema version this check does not know; the criteria below were written ' +
      'against od-design-system-project/v1 and may no longer match.'
  );

  const ALLOWED_SOURCE_KEYS = {
    bundled: new Set(['type', 'origin']),
    local: new Set(['type', 'path', 'importedAt']),
    github: new Set(['type', 'repository', 'ref', 'path', 'importedAt']),
    shadcn: new Set(['type', 'registry', 'importedAt']),
  };
  const allowed = ALLOWED_SOURCE_KEYS[manifest.source?.type];
  assert.ok(allowed, `manifest.source.type is ${JSON.stringify(manifest.source?.type)}, not a known kind`);
  const stray = Object.keys(manifest.source).filter((k) => !allowed.has(k));
  assert.deepEqual(
    stray,
    [],
    `manifest.source declares ${stray.join(', ')}, which ${manifest.source.type} does not allow.\n` +
      `  allowed for ${manifest.source.type}: ${[...allowed].join(', ')}\n\n` +
      '  A manifest that does not parse is not rejected loudly upstream — the package is skipped and ' +
      'nothing says so.'
  );

  assert.equal(manifest.id, 'backchannel', 'manifest.id must match the folder slug');
  for (const [key, file] of Object.entries(manifest.files ?? {})) {
    assert.ok(
      fs.existsSync(path.join(pkg, file)),
      `manifest.files.${key} points at ${file}, which does not exist`
    );
  }
  assert.ok(
    fs.existsSync(path.join(pkg, manifest.componentsManifest)),
    'manifest.componentsManifest is declared but the file is missing'
  );
}

// --- 2: the prose files meet the contract's minima ------------------------------------------------
//
// The USAGE.md headings are matched case-sensitively upstream (`new RegExp(..., "m")`, no `i`), and
// ours read `## Read order` / `## Design highlights` until #115. Two capital letters, invisible for as
// long as nothing checked.
{
  const h2 = (md) => md.split(/\r?\n/).filter((l) => /^##\s+\S/.test(l)).length;
  assert.ok(h2(designMd) >= 7, `DESIGN.md has ${h2(designMd)} H2 sections; the contract wants at least 7`);
  assert.ok(
    declaredTokens.size >= 26,
    `tokens.css declares ${declaredTokens.size} tokens; the contract wants at least 26`
  );
  for (const heading of ['Read Order', 'Design Highlights', 'Do', 'Avoid']) {
    assert.match(
      usageMd,
      new RegExp(`^##\\s+${heading}\\s*$`, 'm'),
      `USAGE.md is missing the "## ${heading}" section. The match is case-sensitive upstream, so ` +
        '"## Read order" does not satisfy "## Read Order".'
    );
  }
}

// --- 3: the fixture is proof, not decoration -----------------------------------------------------
//
// `components.html` is what OpenDesign's own authoring guide calls "the executable proof that the
// tokens compose into real controls". The count minima are the contract's; the **last** assertion is
// ours and is the one that carries meaning — a fixture referring to tokens the system does not declare
// proves nothing about the system.
{
  const style = fixtureHtml.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(style, 'components.html has no <style> block');
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleCount = (css.match(/\{/g) ?? []).length;
  assert.ok(ruleCount >= 10, `the fixture has ${ruleCount} style rules; the contract wants at least 10`);

  const referenced = [...fixtureHtml.matchAll(/var\((--[A-Za-z0-9_-]+)\)/g)].map((m) => m[1]);
  const unique = new Set(referenced);
  assert.ok(unique.size >= 8, `the fixture references ${unique.size} distinct tokens; at least 8 are wanted`);

  const undeclared = [...unique].filter((t) => !declaredTokens.has(t)).sort();
  assert.deepEqual(
    undeclared,
    [],
    'the fixture references tokens this design system does not declare:\n    ' +
      undeclared.join('\n    ') +
      '\n\n  A fixture is only proof if every value in it comes from tokens.css. One invented name and ' +
      'it is a drawing.'
  );
}

// --- 4: the generated cache is not stale ----------------------------------------------------------
//
// `components.manifest.json` is generated, never written: upstream compares it with
// `isDeepStrictEqual` against a fresh extraction and reports `is stale; regenerate it`. Our extractor
// is not available here (private package, absent in CI), so this checks the parts that would drift
// first — counts and token references — rather than pretending to re-derive it.
{
  const cm = JSON.parse(read('components.manifest.json'));
  const referenced = new Set([...fixtureHtml.matchAll(/var\((--[A-Za-z0-9_-]+)\)/g)].map((m) => m[1]));
  assert.equal(
    cm.tokens?.referenced?.length,
    referenced.size,
    `components.manifest.json records ${cm.tokens?.referenced?.length} referenced tokens but the ` +
      `fixture references ${referenced.size}. The cache is stale — regenerate it with OpenDesign's ` +
      'extractComponentsManifest.'
  );
  const groupsPresent = (cm.groups ?? []).filter((g) => g.present).length;
  assert.ok(
    groupsPresent >= 4,
    `the fixture covers ${groupsPresent} component groups; the contract wants at least 4`
  );
  assert.deepEqual(cm.tokens?.undeclared ?? [], [], 'the cached manifest records undeclared tokens');
}

console.log(
  `ok - design system: manifest valid for source.type=${manifest.source.type}, ` +
    `${declaredTokens.size} tokens, USAGE.md complete, fixture ` +
    `${(fixtureHtml.match(/<style>([\s\S]*?)<\/style>/)[1].match(/\{/g) ?? []).length} rules / ` +
    `${new Set([...fixtureHtml.matchAll(/var\((--[A-Za-z0-9_-]+)\)/g)].map((m) => m[1])).size} tokens, ` +
    'none undeclared'
);

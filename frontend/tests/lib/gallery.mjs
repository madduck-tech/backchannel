// Draw every component in the denominator, so a person can look at one instead of reading it.
//
// #107. `stage2-artifact.yml` already publishes a runnable AppImage on every pull request, so this
// is NOT "the product owner cannot see the components" -- #100 was blocked on exactly that false
// premise. What the AppImage cannot cheaply show is a component in a state you cannot navigate to:
// the onboarding steps without re-onboarding, dialogs, error and empty states.
//
// **Mounted inside the application's own provider stack, not bare.** v1 of #107 mounted with no
// props and drew 21 of 78 -- measured, that is the always-on-screen chrome the AppImage shows best,
// and *zero* onboarding steps, *zero* dialogs. Wrapping in the stack `src/app/layout.tsx` mounts
// unconditionally takes it to **38**, all four onboarding steps included, at **no per-component
// fixtures**. `WelcomeStep` renders 2083 characters of the real screen; bare it dies with
// "useOnboarding must be used within OnboardingProvider".
//
// **One subprocess per component, and that is not tidiness.** Three components throw from a passive
// effect, where no error boundary can see it. Node's default is `--unhandled-rejections=throw`, so a
// single-process builder exits 1 after the first one -- measured: `CARD 1 About.tsx 2467` then
// `exit=1`, never reaching card 3. Isolation is also what lets kind 4 exist: without it those cards
// are silently mislabelled as drawn.
//
// **A synthetic entry, because of how `loadTsx` resolves.** Its cache is per call and its overrides
// key on the raw specifier string, so a provider loaded by a second call is a *different React
// context* -- `SidebarProvider` alone is imported under four distinct strings. Providers and
// component are therefore loaded through one entry file so they share one cache.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, componentFiles } from './reachability-shared.mjs';
import { kernelCapAvailable } from './control-runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The providers `src/app/layout.tsx` mounts around every page. Hand-listed, because deriving an
 * order from JSX nested inside a conditional is more fragile than the drift check that holds it:
 * `providersMountedInLayout()` reads the file and `gallery-is-complete.test.mjs` compares. Adding a
 * provider to the application without adding it here is red, which is condition 4.
 */
export const PROVIDERS = [
  ['RecordingStateProvider', '@/contexts/RecordingStateContext'],
  ['TranscriptProvider', '@/contexts/TranscriptContext'],
  ['ConfigProvider', '@/contexts/ConfigContext'],
  ['OllamaDownloadProvider', '@/contexts/OllamaDownloadContext'],
  ['OnboardingProvider', '@/contexts/OnboardingContext'],
  ['UpdateCheckProvider', '@/components/UpdateCheckProvider'],
  ['SidebarProvider', '@/components/Sidebar/SidebarProvider'],
  ['TooltipProvider', '@/components/ui/tooltip'],
  ['RecordingPostProcessingProvider', '@/contexts/RecordingPostProcessingProvider'],
  ['ImportDialogProvider', '@/contexts/ImportDialogContext'],
];

/**
 * The providers the application **wraps its tree in**, read from the file rather than trusted.
 *
 * Self-closing occurrences are excluded, and that distinction is load-bearing rather than pedantic.
 * `layout.tsx:251` renders `<DownloadProgressToastProvider />` -- a sibling with no `children` prop
 * at all, despite the name. A first version of this matched any `<XProvider`, reported it as drift,
 * and I "fixed" the wrapper by adding a component that wraps nothing. Caught by reading the file, not
 * by the check. A name ending in Provider is not the property that matters; taking children is.
 */
export function providersMountedInLayout() {
  const src = fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8');
  return [...src.matchAll(/<([A-Z][A-Za-z]*Provider)\b([^>]*?)(\/?)>/g)]
    .filter((m) => m[3] !== '/')
    .map((m) => m[1]);
}

/**
 * The components that draw today. **Pinned one-sided: every entry here must still draw, and new ones
 * may appear freely.** A bare integer floor was the first design and it self-heals -- add five
 * trivial components and a regression of five is invisible with no diff in this file at all, which is
 * weaker than the constant #98 replaced. A named set makes a regression say *which* component.
 */
export const DRAWN_PIN = [
  'src/app/_components/TranscriptPanel.tsx',
  'src/components/AISummary/index.tsx',
  'src/components/About.tsx',
  'src/components/AppToaster.tsx',
  'src/components/AudioLevelMeter.tsx',
  'src/components/BuiltInModelManager.tsx',
  'src/components/ConfidenceIndicator.tsx',
  'src/components/EditableTitle.tsx',
  'src/components/EmptyStateSummary.tsx',
  'src/components/Info.tsx',
  'src/components/LanguagePickerPopover.tsx',
  'src/components/LanguageSelection.tsx',
  'src/components/Logo.tsx',
  'src/components/MainContent/index.tsx',
  'src/components/MainNav/index.tsx',
  'src/components/MeetingDetails/SummaryUpdaterButtonGroup.tsx',
  'src/components/MeetingDetails/TranscriptButtonGroup.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/PreferenceSettings.tsx',
  'src/components/RecordingControls.tsx',
  'src/components/RecordingSettings.tsx',
  'src/components/RecordingStatusBar.tsx',
  'src/components/Sidebar/index.tsx',
  'src/components/SpeakerLabelSettings.tsx',
  'src/components/SummaryLanguageSettings.tsx',
  'src/components/SummaryModelSettings.tsx',
  'src/components/SummaryTemplateSettings.tsx',
  'src/components/ThemeToggle.tsx',
  'src/components/TranscriptionModelManager.tsx',
  'src/components/onboarding/OnboardingContainer.tsx',
  'src/components/onboarding/OnboardingFlow.tsx',
  'src/components/onboarding/shared/PermissionRow.tsx',
  'src/components/onboarding/shared/ProgressIndicator.tsx',
  'src/components/onboarding/shared/StatusIndicator.tsx',
  'src/components/onboarding/steps/DownloadProgressStep.tsx',
  'src/components/onboarding/steps/PermissionsStep.tsx',
  'src/components/onboarding/steps/SetupOverviewStep.tsx',
  'src/components/onboarding/steps/WelcomeStep.tsx',
];

/** The five kinds a card can be. A component always gets one; a missing card is the failure mode. */
export const KIND = {
  drawn: 'drawn',
  blank: 'blank',
  failedOnMount: 'failed-on-mount',
  failedAsync: 'failed-asynchronously',
  noComponentExport: 'no-component-export',
  noCard: 'will-not-load',
};

/** Render one component in this process. Called in a child; see `buildCards`. */
export async function renderOne(file) {
  const { loadTsx } = await import('./render-tsx.mjs');
  const { boundaryStubs } = await import('./boundary-stubs.mjs');
  const { tauriStubs } = await import('./tauri-stubs.mjs');
  const { setupDom } = await import('./dom-harness.mjs');

  let asyncFailure = null;
  process.on('unhandledRejection', (e) => { asyncFailure = String(e?.message ?? e).split('\n')[0]; });
  await setupDom();
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  console.error = () => {};

  const entry = path.join(root, 'src/__gallery_entry.tsx');
  const spec = file.replace(/^src\//, '@/').replace(/\.tsx$/, '');
  fs.writeFileSync(
    entry,
    PROVIDERS.map(([n, p]) => `import { ${n} } from '${p}';`).join('\n') +
      `\nimport * as T from '${spec}';\nexport const Target = T;\n` +
      `export const P = [${PROVIDERS.map(([n]) => n).join(',')}];\n`
  );

  // `tauriStubs` throws on an unstubbed command -- deliberately, so a *test* fails rather than
  // quietly pulling half the application in. It is used **unsoftened** here. A first attempt passed a
  // Proxy as `extra` to answer every command; that was dead code, because `tauriStubs` tests
  // membership with `hasOwnProperty`, which fires `getOwnPropertyDescriptor` and not the Proxy's
  // `has` trap. It looked like it worked. Removed rather than fixed: where the throw propagates it
  // becomes the card's reason, and "invoked an unstubbed command: X" is the component's real
  // dependency surface, which is worth showing rather than hiding behind a stub that answers
  // everything.
  const t = tauriStubs();
  const nav = {
    useRouter: () => ({ push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} }),
    usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useParams: () => ({}),
    redirect() {}, notFound() {},
  };
  const modules = {
    ...boundaryStubs().modules,
    'next/navigation': nav,
    '@tauri-apps/api/core': t.core,
    '@tauri-apps/api/event': t.event,
    '@tauri-apps/plugin-dialog': { open: async () => null, save: async () => null },
    '@tauri-apps/plugin-updater': { check: async () => null },
    '@tauri-apps/plugin-process': { relaunch: async () => {} },
    '@tauri-apps/api/app': { getVersion: async () => '0.0.0' },
    '@tauri-apps/api/webviewWindow': {
      getCurrentWebviewWindow: () => ({ listen: async () => () => {}, emit: async () => {} }),
    },
  };

  try {
    let mod;
    try {
      mod = loadTsx('src/__gallery_entry.tsx', modules);
    } catch (e) {
      return { file, kind: KIND.noCard, reason: String(e.message).split('\n')[0], html: '' };
    }
    const exported = Object.entries(mod.Target).filter(
      ([, v]) => typeof v === 'function' || (v && v.$$typeof)
    );
    const picked =
      exported.find(([k]) => k === 'default') ?? exported.find(([k]) => /^[A-Z]/.test(k));
    if (!picked) {
      return {
        file, kind: KIND.noComponentExport, html: '',
        reason: `exports nothing component-shaped: ${exported.map((e) => e[0]).join(', ') || '(none)'}`,
      };
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    let html = '';
    try {
      const element = mod.P.reduceRight(
        (child, P) => React.createElement(P, null, child),
        React.createElement(picked[1])
      );
      const rootNode = createRoot(host);
      await act(async () => { rootNode.render(element); });
      await new Promise((r) => setTimeout(r, 0));
      html = host.innerHTML;
      await act(async () => { rootNode.unmount(); });
    } catch (e) {
      return { file, kind: KIND.failedOnMount, reason: String(e.message).split('\n')[0], html: '' };
    } finally {
      host.remove();
    }

    if (asyncFailure) return { file, kind: KIND.failedAsync, reason: asyncFailure, html };
    if (!html.trim()) return { file, kind: KIND.blank, name: picked[0], html: '' };
    return { file, kind: KIND.drawn, name: picked[0], html };
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

/**
 * One card per component in the denominator. A child process each, so an asynchronous throw ends one
 * card rather than the run.
 */
export function buildCards(files = componentFiles(), { timeoutMs = 60_000, memoryMb = 640 } = {}) {
  // A **kernel** cap, not just `--max-old-space-size`. Measured 2026-09-06, after two OOM kills of
  // the machine: under a 64 MB heap cap a node process still reached 1.58 GB peak RSS, because the
  // flag bounds the V8 heap and jsdom allocates outside it. And `MemoryMax` alone is not enough
  // either -- with 7 GB of swap present it let the same program take 1536 MB, because the kernel
  // swapped instead of killing. `MemorySwapMax=0` is what makes it hard. A runaway child then dies
  // in 0.3 s with exit 137 instead of taking the desktop with it.
  //
  // This matters here specifically: a component mounted inside ten real providers is exactly the
  // shape that loops. Three of this application's contexts mint a fresh object per render.
  const cap = kernelCapAvailable()
    ? ['systemd-run', '--user', '--scope', '-q',
       '-p', `MemoryMax=${memoryMb * 2}M`, '-p', 'MemorySwapMax=0', '--']
    : [];
  return files.map((file) => {
    try {
      const argv = [...cap, process.execPath, `--max-old-space-size=${memoryMb}`, path.join(here, 'gallery.mjs')];
      const out = execFileSync(
        argv[0], argv.slice(1),
        { env: { ...process.env, GALLERY_TARGET: file }, encoding: 'utf8', timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return JSON.parse(out.trim().split('\n').at(-1));
    } catch (e) {
      const line = String(e.stdout ?? '').trim().split('\n').at(-1);
      if (line?.startsWith('{')) { try { return JSON.parse(line); } catch { /* fall through */ } }
      return { file, kind: KIND.failedAsync, html: '',
        reason: `the child process died: ${String(e.message).split('\n')[0]}` };
    }
  });
}

/**
 * The components that draw today, pinned **one-sided**: every name here must still draw, and new
 * names may appear freely. Not an integer floor -- #107 v1 proposed `>= 38` and a bare integer
 * *self-heals*: add five trivial components and a genuine regression of five is invisible, with no
 * diff in this file at all. That is weaker than the constant #98 replaced, where at least a number
 * had to be edited under a reviewer's eye. A pinned set makes a regression **name the component**.
 *
 * The floor beside it catches the other direction: deleting a drawn component together with its
 * pin entry is green under one-sided containment alone.
 */
export const DRAWN = [
  'src/app/_components/TranscriptPanel.tsx',
  'src/components/AISummary/index.tsx',
  'src/components/About.tsx',
  'src/components/AppToaster.tsx',
  'src/components/AudioLevelMeter.tsx',
  'src/components/BuiltInModelManager.tsx',
  'src/components/ConfidenceIndicator.tsx',
  'src/components/EditableTitle.tsx',
  'src/components/EmptyStateSummary.tsx',
  'src/components/Info.tsx',
  'src/components/LanguagePickerPopover.tsx',
  'src/components/LanguageSelection.tsx',
  'src/components/Logo.tsx',
  'src/components/MainContent/index.tsx',
  'src/components/MainNav/index.tsx',
  'src/components/MeetingDetails/SummaryUpdaterButtonGroup.tsx',
  'src/components/MeetingDetails/TranscriptButtonGroup.tsx',
  'src/components/ModelSettingsModal.tsx',
  'src/components/PreferenceSettings.tsx',
  'src/components/RecordingControls.tsx',
  'src/components/RecordingSettings.tsx',
  'src/components/RecordingStatusBar.tsx',
  'src/components/Sidebar/index.tsx',
  'src/components/SpeakerLabelSettings.tsx',
  'src/components/SummaryLanguageSettings.tsx',
  'src/components/SummaryModelSettings.tsx',
  'src/components/SummaryTemplateSettings.tsx',
  'src/components/ThemeToggle.tsx',
  'src/components/TranscriptionModelManager.tsx',
  'src/components/onboarding/OnboardingContainer.tsx',
  'src/components/onboarding/OnboardingFlow.tsx',
  'src/components/onboarding/shared/PermissionRow.tsx',
  'src/components/onboarding/shared/ProgressIndicator.tsx',
  'src/components/onboarding/shared/StatusIndicator.tsx',
  'src/components/onboarding/steps/DownloadProgressStep.tsx',
  'src/components/onboarding/steps/PermissionsStep.tsx',
  'src/components/onboarding/steps/SetupOverviewStep.tsx',
  'src/components/onboarding/steps/WelcomeStep.tsx',
];
export const DRAWN_FLOOR = 38;

/** Every stylesheet a `pnpm build` produced. Empty means the page would lie about the product. */
export function compiledStylesheets() {
  const dir = path.join(root, 'out/_next/static/css');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page. Structure only -- the CSS applies in the reader's browser, not here. */
export function galleryHtml(cards, css = compiledStylesheets()) {
  const counts = Object.fromEntries(
    Object.values(KIND).map((k) => [k, cards.filter((c) => c.kind === k).length])
  );
  const summary = Object.entries(counts).filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`).join(' &middot; ');
  const card = (c) => {
    const head = `<h3 style="font:11px ui-monospace,monospace;color:#666;margin:0 0 6px">` +
      `${escape(c.file)} <b style="color:#111">${escape(c.name ?? c.kind)}</b></h3>`;
    const body = c.kind === KIND.drawn
      ? c.html
      : `<p style="font:12px ui-monospace,monospace;color:#a00;margin:0">` +
        `${escape(c.kind)}${c.reason ? ': ' + escape(c.reason) : ''}</p>`;
    return `<section style="border:1px solid #d0d0d0;border-radius:6px;margin:14px;padding:10px">${head}${body}</section>`;
  };
  return '<!doctype html><meta charset="utf-8"><title>Backchannel components</title>' +
    `<style>${css.join('\n')}</style>` +
    `<body><header style="font:13px system-ui;padding:10px 14px;color:#333">` +
    `${cards.length} components &mdash; ${summary}</header>` +
    cards.map(card).join('') + '</body>';
}

// Two entries, both env-gated, so this file is a helper first and a command second.
//
// `GALLERY_TARGET` -- one card, in a child of `buildCards`.
// `GALLERY_OUT`    -- the whole page, for CI. It is the half that renders, and it lives here rather
//                     than in `pnpm test` because building 78 cards takes 96 s against that suite's
//                     12 s, and `test.yml` is the only required status check on `main`.
if (process.env.GALLERY_TARGET) {
  const card = await renderOne(process.env.GALLERY_TARGET);
  process.stdout.write(JSON.stringify(card) + '\n');
} else if (process.env.GALLERY_OUT) {
  const css = compiledStylesheets();
  if (css.length === 0) {
    console.error(
      'gallery: no stylesheets under out/_next/static/css/. Run `pnpm build` first.\n' +
        '  Publishing an unstyled page would show a broken-looking product and read as a regression\n' +
        '  in the components rather than a missing build step.'
    );
    process.exit(1);
  }

  const cards = buildCards();
  if (cards.length === 0) {
    console.error('gallery: zero cards. An empty page is not a gallery.');
    process.exit(1);
  }

  const drawn = new Set(cards.filter((c) => c.kind === KIND.drawn).map((c) => c.file));
  const lost = DRAWN_PIN.filter((f) => !drawn.has(f));
  if (lost.length) {
    console.error(
      'gallery: components that used to draw no longer do:\n    ' +
        lost.map((f) => `${f} -> ${cards.find((c) => c.file === f)?.kind ?? 'missing'}`).join('\n    ') +
        '\n\n  Either fix it, or update DRAWN_PIN in gallery.mjs deliberately.'
    );
    process.exit(1);
  }

  fs.writeFileSync(process.env.GALLERY_OUT, galleryHtml(cards, css));
  const counts = Object.values(KIND)
    .map((k) => [k, cards.filter((c) => c.kind === k).length])
    .filter(([, n]) => n);
  console.log(
    `gallery: ${cards.length} cards (${counts.map(([k, n]) => `${n} ${k}`).join(', ')}), ` +
      `${css.length} stylesheet(s), ${drawn.size - DRAWN_PIN.length >= 0 ? '+' : ''}` +
      `${drawn.size - DRAWN_PIN.length} against the pin -> ${process.env.GALLERY_OUT}`
  );
}

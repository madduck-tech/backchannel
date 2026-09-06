// A DOM for component tests, and nothing more.
//
// jsdom is the only new dependency this needs. No second test runner: these run under
// `node --test` like everything else in tests/lib. No @testing-library: React 19 exports
// `act`, and the assertions here read the DOM directly.
//
// The expensive route was never needed. Radix `Select` requires `hasPointerCapture`,
// `scrollIntoView` and `ResizeObserver` to *open its popover* — but closed, it portals its
// items into a detached fragment and renders a real hidden `<select>` carrying one
// `<option>` per item, whose change event drives `onValueChange`. Measured: option values,
// option labels and the change round trip all work with **none** of those three defined.
//
// The one piece of scaffolding to know about: that hidden `<select>` only renders when the
// trigger is inside a form, and this application contains no `<form>` at all. Tests here
// wrap the component in one. The option values still come from the same `SelectItem value=`
// props the application ships, so it is a faithful mirror — but it is a Radix branch
// production never takes, and that is stated rather than discovered.
import { JSDOM } from 'jsdom';

let dom;

export async function setupDom() {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    // Without a URL, jsdom serves an *opaque* origin and every `localStorage` access throws
    // `SecurityError: localStorage is not available for opaque origins`. The theme toggle in the
    // sidebar's tree reads it, so the component died on a line that has nothing to do with the
    // component. A real origin is also the more faithful mirror: the application always has one.
    url: 'http://localhost/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // `navigator` is getter-only on the Node 24 global; define it rather than assign.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  // Node 24 defines Event, EventTarget and friends itself (undici). Leaving those in place
  // makes Radix construct a *Node* Event and dispatch it at a *jsdom* node, which throws
  // "parameter 1 is not of type 'Event'" from inside a passive effect. Override them.
  const FORCE = ['Event', 'CustomEvent', 'EventTarget', 'MessageEvent', 'MouseEvent',
                 'KeyboardEvent', 'PointerEvent', 'InputEvent', 'FocusEvent', 'Node',
                 'Element', 'HTMLElement', 'DocumentFragment'];
  for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (k in globalThis && !FORCE.includes(k)) continue;
    try { globalThis[k] = dom.window[k]; } catch { /* getter-only, skip */ }
  }
  // jsdom declares `alert`/`confirm`/`prompt` and then throws "not implemented" when called.
  // `RecordingControls.tsx:62` calls `alert()` on its initialisation-failure path, so a component
  // test reaches it and dies inside a passive effect, where the real error is three frames of
  // React internals away from the cause. Recorded here rather than swallowed: the calls are
  // captured so a test can assert one happened, and a component that starts alerting on a path it
  // should not will show up as a captured call rather than as a crash.
  globalThis.__alerts = [];
  const capture = (kind) => (message) => { globalThis.__alerts.push({ kind, message: String(message) }); };
  globalThis.alert = capture('alert');
  globalThis.confirm = (m) => { capture('confirm')(m); return false; };
  globalThis.prompt = (m) => { capture('prompt')(m); return null; };
  dom.window.alert = globalThis.alert;
  dom.window.confirm = globalThis.confirm;
  dom.window.prompt = globalThis.prompt;

  // jsdom implements no `matchMedia` at all, and the theme hook calls it during render through
  // `useSyncExternalStore`. This returns a permanently non-matching query with working listener
  // methods, which is the light-theme branch — enough for a component that only asks, and honest
  // about what it is: a test cannot change the OS colour scheme, so no test may assert on the dark
  // branch through this. A component whose behaviour depends on the media query needs its own stub.
  if (typeof dom.window.matchMedia !== 'function') {
    const mql = (media) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    });
    dom.window.matchMedia = mql;
    globalThis.matchMedia = mql;
  }

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // Imported only after the globals exist: react-dom/client reads them at module scope.
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  return { React, createRoot, act: React.act, window: dom.window, document: dom.window.document };
}

/** Fire a native change on a <select>, the way the hidden Radix input is driven. */
export function changeSelect(select, value, act) {
  return act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

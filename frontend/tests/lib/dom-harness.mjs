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

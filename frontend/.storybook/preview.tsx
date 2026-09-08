import * as React from 'react'
import type { Decorator, Preview } from '@storybook/nextjs'
import '../src/app/globals.css'
import { fontVars } from '../src/app/fonts'

/**
 * The application's typefaces, on every story.
 *
 * This is the single most load-bearing line in the Storybook config, and #124 exists partly because
 * its first draft did not have it. `--font-sans` is never declared in `globals.css` — that file
 * consumes it. It lives only inside the content-hashed class `next/font` generates, which
 * `layout.tsx:245` puts on `<body>`. A story renders a component, not `layout.tsx`.
 *
 * Without this decorator, measured in headless Chrome over this project's compiled CSS: a `60ch` box
 * at 14px is **480.469px** instead of **503.984px** — 4.8% small, because `ch` resolves against the
 * fallback face. The failure produces plausible numbers rather than an error, so the natural repair
 * would be to write the wrong number into the assertion and canonise it in the gate.
 *
 * `fontVars` is imported from the same module `layout.tsx` uses. A second copy of those three
 * `next/font` calls would generate a second hash and reintroduce the gap silently.
 */
const withApplicationChrome: Decorator = (Story) => (
  <div className={`${fontVars} font-sans`} data-storybook-chrome="">
    <Story />
  </div>
)

const preview: Preview = {
  decorators: [withApplicationChrome],
  parameters: { layout: 'fullscreen' },
}
export default preview

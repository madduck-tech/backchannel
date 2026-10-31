import * as React from 'react'
import type { Decorator, Preview } from '@storybook/nextjs'
import '../src/app/globals.css'

/**
 * The application's typefaces, on every story.
 *
 * `globals.css`, imported above, brings `fonts.css`: the IBM Plex @font-face rules and the
 * `--font-*` variables on :root (#264). A story renders a component, not `layout.tsx`, and before
 * #264 the variables lived only inside a class `next/font` generated, so this decorator had to put
 * that class on the story's root: without it, measured in headless Chrome over this project's
 * compiled CSS, a `60ch` box at 14px was **480.469px** instead of **503.984px** (#124). The variables
 * are on :root now, so the decorator keeps only `font-sans` and the chrome marker.
 */
const withApplicationChrome: Decorator = (Story) => (
  <div className="font-sans" data-storybook-chrome="">
    <Story />
  </div>
)

const preview: Preview = {
  decorators: [withApplicationChrome],
  parameters: { layout: 'fullscreen' },
}
export default preview

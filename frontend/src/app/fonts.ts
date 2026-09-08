/**
 * The application's typefaces, in one place.
 *
 * `layout.tsx` and `.storybook/preview.tsx` both import `fontVars` from here, and that is the point:
 * `--font-sans` is not declared in `globals.css` — that file *consumes* it. It exists only inside the
 * content-hashed class `next/font` generates, which `layout.tsx` puts on `<body>`. A Storybook story
 * renders a component, not `layout.tsx`, so without this the variable is undefined and every `ch`
 * resolves against the fallback face.
 *
 * Measured in headless Chrome over this project's compiled CSS (#124): a `60ch` box at 14px is
 * 480.469px without the class and 503.984px with it — 4.8%, the same error
 * `transcript-matches-the-prototype.test.mjs` was written about. A second copy of these three calls
 * would produce a second hash and reintroduce it silently, which is why there is one module rather
 * than a duplicated block.
 */
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google'

export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
})

export const plexSerif = IBM_Plex_Serif({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
})

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

/** The three class names `layout.tsx` puts on `<body>`, and a story decorator puts on its root. */
export const fontVars = `${plexSans.variable} ${plexSerif.variable} ${plexMono.variable}`

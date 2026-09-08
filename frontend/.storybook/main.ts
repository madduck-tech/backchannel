import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/nextjs'

/**
 * The catalogue's build. It exists to render this application's components the way the application
 * does — see `preview.tsx` for the part that is easy to get wrong and expensive when it is wrong.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [],
  framework: { name: '@storybook/nextjs', options: {} },
  // Nothing here may reach the network at render time: the boundary is `tauri-stubs.mjs`, and a
  // story that gets past it is a story measuring something other than this product (#124).
  core: { disableTelemetry: true },
  webpackFinal: async (cfg) => {
    // The boundary. A story that reaches the real Tauri bridge would hang on a `window.__TAURI__`
    // that is not there; aliased, it throws the same sentence the jsdom tests throw (#124 cond. 4).
    cfg.resolve = cfg.resolve || {}
    cfg.resolve.alias = {
      ...(cfg.resolve.alias || {}),
      '@tauri-apps/api/core': fileURLToPath(new URL('./tauri-boundary.ts', import.meta.url)),
    }
    return cfg
  },
}
export default config

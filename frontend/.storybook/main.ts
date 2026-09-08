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
}
export default config

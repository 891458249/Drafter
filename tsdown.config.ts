import { defineConfig } from './vendor/deepseek-harness/node_modules/tsdown/dist/index.mjs'
import { createRequire } from 'node:module'

const require_ = createRequire(new URL('./vendor/deepseek-harness/packages/host/apiproxy/package.json', import.meta.url))
const apiproxyClient = require_.resolve('@deepseek-ai/dsh-host-apiproxy/client')

export default defineConfig({
  entry: ['src/harness/ipc-client-entry.js'],
  format: ['esm'],
  outDir: 'src/harness/dist',
  platform: 'browser',
  minify: false,
  sourcemap: false,
  deps: { alwaysBundle: [/.*/] },
  alias: {
    '@deepseek-ai/dsh-host-apiproxy/client': apiproxyClient,
  },
})

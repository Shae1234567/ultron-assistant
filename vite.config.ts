import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';
import path from 'node:path';

// package.json deliberately has no "type": "module". That makes
// vite-plugin-electron emit main/preload as CommonJS, which keeps __dirname
// working and loads identically in dev and in a packaged build.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // transformers.js normally relies on its package.json "browser" field to
      // stub out fs/path/onnxruntime-node. vite-plugin-electron-renderer turns
      // the browser field off so the renderer can use Node, which makes the
      // library take its Node branch and blow up on `require("fs")` inside the
      // worker. Pointing at the prebuilt web bundle sidesteps that entirely.
      '@xenova/transformers': path.resolve(
        __dirname,
        'node_modules/@xenova/transformers/dist/transformers.js',
      ),
    },
  },
  optimizeDeps: { exclude: ['@xenova/transformers'] },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              // playwright-core probes for optional native drivers (kerberos,
              // mongodb-client-encryption, ...) it never actually needs unless
              // that specific proxy/auth path is used - none of them are
              // installed, and none need to be. Node resolves 'playwright'
              // itself from node_modules fine at runtime in the main process,
              // so there's no reason for Rollup to bundle any of this tree.
              // @composio/core is ESM-only: kept external and loaded with a
              // dynamic import() from this CommonJS bundle at runtime.
              // The MCP SDK (Composio Connect) is loaded the same way, by subpath.
              external: [
                'playwright', 'playwright-core',
                'kerberos', 'mongodb-client-encryption', 'aws4', 'snappy', 'saslprep', 'socks-proxy-agent',
                '@google/genai', '@composio/core',
                /^@modelcontextprotocol\/sdk(\/.*)?$/,
              ],
            },
          },
        },
      },
      preload: { input: path.join(__dirname, 'electron/preload.ts') },
    }),
    renderer(),
  ],
  server: { port: 5199, strictPort: false },
  build: { outDir: 'dist', emptyOutDir: true },
});

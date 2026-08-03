import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        'better-sqlite3': 'better-sqlite3-electron',
      },
    },
    build: {
      externalizeDeps: {
        exclude: ['@memory-manager/core'],
      },
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL('./main/index.ts', import.meta.url)),
          'scan-worker': fileURLToPath(new URL('./main/scan-worker.ts', import.meta.url)),
          'generation-worker': fileURLToPath(
            new URL('./main/generation-worker.ts', import.meta.url),
          ),
          'provider-worker': fileURLToPath(new URL('./main/provider-worker.ts', import.meta.url)),
          'session-preview-worker': fileURLToPath(
            new URL('./main/session-preview-worker.ts', import.meta.url),
          ),
          'project-sessions-worker': fileURLToPath(
            new URL('./main/project-sessions-worker.ts', import.meta.url),
          ),
          'codex-memory-targets-worker': fileURLToPath(
            new URL('./main/codex-memory-targets-worker.ts', import.meta.url),
          ),
          'project-memory-status-worker': fileURLToPath(
            new URL('./main/project-memory-status-worker.ts', import.meta.url),
          ),
        },
        external: ['better-sqlite3-electron'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: fileURLToPath(new URL('./preload/index.ts', import.meta.url)),
      },
    },
  },
  renderer: {
    root: resolve(process.cwd(), 'renderer'),
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        input: fileURLToPath(new URL('./renderer/index.html', import.meta.url)),
      },
    },
  },
})

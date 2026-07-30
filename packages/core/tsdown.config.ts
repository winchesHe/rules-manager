import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: false,
  external: ['better-sqlite3'],
})

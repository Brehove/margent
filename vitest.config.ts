import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: [
      {
        find: '@tauri-apps/api/core',
        replacement: fileURLToPath(new URL('./tests/mocks/tauri-api.ts', import.meta.url)),
      },
      {
        find: '@tauri-apps/api/event',
        replacement: fileURLToPath(new URL('./tests/mocks/tauri-event.ts', import.meta.url)),
      },
      {
        find: '@tauri-apps/plugin-dialog',
        replacement: fileURLToPath(new URL('./tests/mocks/tauri-dialog.ts', import.meta.url)),
      },
      {
        find: '@tauri-apps/plugin-fs',
        replacement: fileURLToPath(new URL('./tests/mocks/tauri-fs.ts', import.meta.url)),
      },
    ],
  },
})

import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// A separate local port keeps focused specialist checks away from all instances.
export default defineConfig({
  ...base,
  testMatch: 'binder-layout.spec.js',
  outputDir: './test-results/binder-layout',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4178' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
})

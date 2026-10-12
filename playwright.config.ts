import { defineConfig, devices } from '@playwright/test';

// E2E 与兼容性测试（T29、T30）；浏览器矩阵见 docs/decisions/Q1-scale.md
export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});

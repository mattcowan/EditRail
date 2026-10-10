// TEMP (QA session 2026-10-10): adds firefox and webkit projects. Delete after use.
const base = require('./playwright.config.js');
const { devices } = require('@playwright/test');
module.exports = {
  ...base,
  projects: [
    ...base.projects,
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, dependencies: ['setup'] },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, dependencies: ['setup'] },
  ],
};

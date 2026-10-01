/**
 * Put the developer's own EditRail settings back after the NVDA journeys.
 * global-setup.js saved them right after login. See
 * tests/e2e/prefs-account.js for why this writes through the REST API and
 * confirms the server copy.
 */
const path = require('path');
const { restoreRailPrefs } = require('../e2e/prefs-account');

module.exports = async () => {
  // The same runner process ran global-setup.js, which saved its ID.
  await restoreRailPrefs(path.join(__dirname, 'auth.json'), process.pid, '[editrail test:sr]');
};

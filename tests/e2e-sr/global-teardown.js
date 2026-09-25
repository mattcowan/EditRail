/**
 * Put the developer's own EditRail settings back after the NVDA journeys.
 * global-setup.js saved them right after login. See
 * tests/e2e/prefs-account.js for why this writes through the REST API and
 * confirms the server copy.
 */
const path = require('path');
const { restoreRailPrefs } = require('../e2e/prefs-account');

module.exports = async () => {
  await restoreRailPrefs(path.join(__dirname, 'rail-prefs-snapshot.json'), path.join(__dirname, 'auth.json'), '[editrail test:sr]');
};

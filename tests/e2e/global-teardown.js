/**
 * Put the developer's own EditRail settings back once the whole run is done.
 * auth.setup.js saved them right after login. See prefs-account.js for why
 * this writes through the REST API and confirms the server copy.
 */
const path = require('path');
const { SNAPSHOT_FILE, restoreRailPrefs } = require('./prefs-account');

module.exports = async () => {
  await restoreRailPrefs(SNAPSHOT_FILE, path.join(__dirname, '.auth', 'admin.json'), '[editrail e2e]');
};

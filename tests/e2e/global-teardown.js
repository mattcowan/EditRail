/**
 * Put the developer's own EditRail settings back once the whole run is done.
 * auth.setup.js saved them right after login. See prefs-account.js for why
 * this writes through the REST API and confirms the server copy.
 */
const path = require('path');
const { restoreRailPrefs } = require('./prefs-account');

module.exports = async () => {
  // The teardown runs in the runner process, whose ID auth.setup.js saved.
  await restoreRailPrefs(path.join(__dirname, '.auth', 'admin.json'), process.pid, '[editrail e2e]');
};

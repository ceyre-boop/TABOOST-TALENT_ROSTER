// ============================================================================
// TABOOST ROSTER SYNC - Roster tab -> ceyre-boop/TABOOST-TALENT_ROSTER
// Pushes ONLY the "Roster" tab (20 creators, column G = Sales Level)
// to data/roster.csv. The live roster page reads column G and shows a
// Sales Level badge on each creator box, matched by TikTok handle or name.
// Paste into Apps Script on the ROSTER spreadsheet (not the live-hosts one).
// ============================================================================

var ROSTER_TAB = 'Roster';
var ROSTER_OUTPUT_PATH = 'data/roster.csv';

// -- MAIN SYNC ---------------------------------------------------------------
function syncRosterToGitHub() {
  var config = loadRosterConfig_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ROSTER_TAB);
  if (!sheet) {
    throw new Error('Tab "' + ROSTER_TAB + '" not found. Tabs in this spreadsheet: ' +
      ss.getSheets().map(function(s) { return s.getName(); }).join(', '));
  }

  Logger.log('Using tab: "' + sheet.getName() + '"');
  var csv = exportRosterCSV_(config.SHEET_ID, sheet.getSheetId().toString());
  Logger.log('Exported ' + csv.length + ' chars');

  var result = pushRosterToGitHub_(csv, config);
  Logger.log('Pushed to ' + ROSTER_OUTPUT_PATH + ' @ ' + result.commit.sha.substring(0, 7));
  return result;
}

function testRosterSync() { return syncRosterToGitHub(); }

// -- EXPORT CSV --------------------------------------------------------------
function exportRosterCSV_(sheetId, gid) {
  var url = 'https://docs.google.com/spreadsheets/d/' + sheetId +
            '/export?format=csv&gid=' + gid + '&t=' + new Date().getTime();
  var response = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Export failed (HTTP ' + response.getResponseCode() + '): ' +
      response.getContentText().substring(0, 200));
  }
  return response.getContentText();
}

// -- GITHUB PUSH -------------------------------------------------------------
function pushRosterToGitHub_(content, config) {
  if (!config.GITHUB_TOKEN) throw new Error('No GitHub token - run setupRosterSync() first');
  var apiUrl = 'https://api.github.com/repos/' + config.GITHUB_OWNER + '/' +
               config.GITHUB_REPO + '/contents/' + ROSTER_OUTPUT_PATH;

  var sha = null;
  var check = UrlFetchApp.fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Authorization': 'token ' + config.GITHUB_TOKEN,
      'Accept': 'application/vnd.github.v3+json'
    },
    muteHttpExceptions: true
  });
  if (check.getResponseCode() === 200) {
    sha = JSON.parse(check.getContentText()).sha;
  }

  var payload = {
    message: 'Auto-sync: Roster @ ' + new Date().toISOString(),
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: 'main'
  };
  if (sha) payload.sha = sha;

  var upload = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + config.GITHUB_TOKEN,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = upload.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('GitHub PUT error ' + code + ': ' + upload.getContentText().substring(0, 300));
  }
  return JSON.parse(upload.getContentText());
}

// -- CONFIG ------------------------------------------------------------------
function loadRosterConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    GITHUB_TOKEN: props.getProperty('ROSTER_GITHUB_TOKEN') || props.getProperty('GITHUB_TOKEN'),
    GITHUB_OWNER: 'ceyre-boop',
    GITHUB_REPO: 'TABOOST-TALENT_ROSTER',
    SHEET_ID: SpreadsheetApp.getActiveSpreadsheet().getId()
  };
}

function setupRosterSync() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  if (!props.getProperty('GITHUB_TOKEN') && !props.getProperty('ROSTER_GITHUB_TOKEN')) {
    var token = ui.prompt('GitHub Token', 'Enter your GitHub Personal Access Token:', ui.ButtonSet.OK_CANCEL);
    if (token.getSelectedButton() !== ui.Button.OK) return;
    props.setProperty('ROSTER_GITHUB_TOKEN', token.getResponseText().trim());
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(ROSTER_TAB)) {
    ui.alert('Tab "' + ROSTER_TAB + '" not found.\n\nFound tabs: ' +
      ss.getSheets().map(function(s) { return s.getName(); }).join(', '));
    return;
  }
  ui.alert('Setup complete! Run testRosterSync() to verify.');
}

// -- TRIGGERS - 10 AM and 10 PM PT daily -------------------------------------
function createRosterTriggers() {
  deleteRosterTriggers_();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(22).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  SpreadsheetApp.getUi().alert('Roster sync enabled: 10 AM PT + 10 PM PT');
}

function stopRosterSync() {
  deleteRosterTriggers_();
  SpreadsheetApp.getUi().alert('Roster sync stopped');
}

function deleteRosterTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncRosterToGitHub') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// -- MENU --------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ROSTER SYNC')
    .addItem('Sync Now', 'syncRosterToGitHub')
    .addItem('First Time Setup', 'setupRosterSync')
    .addSeparator()
    .addItem('Twice Daily (10 AM + 10 PM PT)', 'createRosterTriggers')
    .addItem('Stop Auto-Sync', 'stopRosterSync')
    .addToUi();
}

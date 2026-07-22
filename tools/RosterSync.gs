// ============================================================================
// TABOOST ROSTER SYNC - FINAL
// Pushes the "Roster" tab (20 creators, column G = Sales Level) from the
// roster spreadsheet to ceyre-boop/TABOOST-TALENT_ROSTER -> data/roster.csv.
// The live page reads column G and shows a Sales Level badge on each box.
//
// SETUP: put your GitHub token on the line below. That is the ONLY edit.
// Then select syncRosterToGitHub in the toolbar dropdown and press Run.
// (Approve the Google permission popup on first run, then Run again.)
// NEVER commit this file anywhere with a real token in it.
// ============================================================================

var GITHUB_TOKEN = 'PASTE_TOKEN_HERE';

var SPREADSHEET_ID = '1Fl1yKACk6Wmqc9z8CCmgsgBv-zUEW9mqB-2UQvTCGOE';
var ROSTER_TAB = 'Roster';
var OUTPUT_PATH = 'data/roster.csv';
var GITHUB_OWNER = 'ceyre-boop';
var GITHUB_REPO = 'TABOOST-TALENT_ROSTER';

function syncRosterToGitHub() {
  if (!GITHUB_TOKEN || GITHUB_TOKEN === 'PASTE_TOKEN_HERE') {
    throw new Error('Put your GitHub token in the GITHUB_TOKEN line at the top of the script.');
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(ROSTER_TAB);
  if (!sheet) {
    throw new Error('Tab "' + ROSTER_TAB + '" not found. Tabs: ' +
      ss.getSheets().map(function(s) { return s.getName(); }).join(', '));
  }
  Logger.log('Using tab: "' + sheet.getName() + '"');

  var url = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID +
            '/export?format=csv&gid=' + sheet.getSheetId() + '&t=' + new Date().getTime();
  var response = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Export failed (HTTP ' + response.getResponseCode() + '): ' +
      response.getContentText().substring(0, 200));
  }
  var csv = response.getContentText();
  Logger.log('Exported ' + csv.length + ' chars');

  var apiUrl = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
               '/contents/' + OUTPUT_PATH;
  var ghHeaders = {
    'Authorization': 'token ' + GITHUB_TOKEN,
    'Accept': 'application/vnd.github.v3+json'
  };

  var sha = null;
  var check = UrlFetchApp.fetch(apiUrl, {
    method: 'GET', headers: ghHeaders, muteHttpExceptions: true
  });
  if (check.getResponseCode() === 200) {
    sha = JSON.parse(check.getContentText()).sha;
  }

  var payload = {
    message: 'Auto-sync: Roster @ ' + new Date().toISOString(),
    content: Utilities.base64Encode(csv, Utilities.Charset.UTF_8),
    branch: 'main'
  };
  if (sha) payload.sha = sha;

  var upload = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
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
  var result = JSON.parse(upload.getContentText());
  Logger.log('Pushed to ' + OUTPUT_PATH + ' @ ' + result.commit.sha.substring(0, 7));
  return result;
}

// Twice-daily auto-sync: 10 AM + 10 PM PT. Run once to enable.
function createRosterTriggers() {
  deleteRosterTriggers_();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(22).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  Logger.log('Roster sync triggers enabled: 10 AM + 10 PM PT');
}

function stopRosterSync() {
  deleteRosterTriggers_();
  Logger.log('Roster sync triggers removed');
}

function deleteRosterTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncRosterToGitHub') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

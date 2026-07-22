// ============================================================================
// TABOOST ROSTER SYNC — pushes the roster tab to the TALENT ROSTER repo
// Google Sheets → github.com/ceyre-boop/TABOOST-TALENT_ROSTER → data/roster.csv
// The live roster page reads column G (Sales Level) from this CSV and shows
// a badge on each creator box. Rows are matched by TikTok handle or name.
// ============================================================================

// Change this if your roster tab is named differently.
const ROSTER_TAB = 'Roster';
const ROSTER_OUTPUT_PATH = 'data/roster.csv';

function syncRosterToGitHub() {
  const config = loadRosterConfig();
  const gid = getRosterGid(ROSTER_TAB);
  if (!gid) throw new Error(`Sheet "${ROSTER_TAB}" not found`);

  const csv = exportRosterCSV(config.SHEET_ID, gid);
  console.log(`✅ Exported ${csv.length} chars from ${ROSTER_TAB}`);

  const result = pushRosterToGitHub(csv, config);
  console.log(`✅ Pushed to ${ROSTER_OUTPUT_PATH} @ ${result.commit.sha.substring(0, 7)}`);
  return result;
}

function testRosterSync() { return syncRosterToGitHub(); }

function exportRosterCSV(sheetId, gid, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const response = UrlFetchApp.fetch(
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
      {
        headers: { 'Authorization': `Bearer ${ScriptApp.getOAuthToken()}` },
        muteHttpExceptions: true
      }
    );
    if (response.getResponseCode() === 200) return response.getContentText();
    Utilities.sleep(3000 * (i + 1));
  }
  throw new Error('Export failed after retries: rate limited by Google');
}

function pushRosterToGitHub(content, config) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = config;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${ROSTER_OUTPUT_PATH}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  let sha = null;
  const check = UrlFetchApp.fetch(apiUrl, { method: 'GET', headers, muteHttpExceptions: true });
  if (check.getResponseCode() === 200) sha = JSON.parse(check.getContentText()).sha;

  const payload = {
    message: `Auto-sync: ${ROSTER_TAB} @ ${new Date().toISOString()}`,
    content: Utilities.base64Encode(content),
    branch: 'main'
  };
  if (sha) payload.sha = sha;

  const upload = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = upload.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error(`GitHub error ${code}: ${upload.getContentText()}`);
  }
  return JSON.parse(upload.getContentText());
}

function getRosterGid(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  return sheet ? sheet.getSheetId().toString() : null;
}

function loadRosterConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    GITHUB_TOKEN: props.getProperty('ROSTER_GITHUB_TOKEN') || props.getProperty('GITHUB_TOKEN'),
    GITHUB_OWNER: 'ceyre-boop',
    GITHUB_REPO:  'TABOOST-TALENT_ROSTER',
    SHEET_ID:     props.getProperty('SHEET_ID') || SpreadsheetApp.getActiveSpreadsheet().getId()
  };
}

function setupRosterSync() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty('GITHUB_TOKEN') && !props.getProperty('ROSTER_GITHUB_TOKEN')) {
    const token = ui.prompt('GitHub Token', 'Enter GitHub Personal Access Token:', ui.ButtonSet.OK_CANCEL);
    if (token.getSelectedButton() !== ui.Button.OK) return;
    props.setProperty('ROSTER_GITHUB_TOKEN', token.getResponseText().trim());
  }
  props.setProperty('SHEET_ID', SpreadsheetApp.getActiveSpreadsheet().getId());

  if (!getRosterGid(ROSTER_TAB)) {
    ui.alert(`⚠️ Sheet "${ROSTER_TAB}" not found — edit ROSTER_TAB at the top of the script.`);
    return;
  }
  ui.alert('✅ Roster sync setup complete! Run testRosterSync() to test.');
}

// Twice-daily, same cadence as the platform sync (10 AM + 10 PM PT)
function createRosterTriggers() {
  deleteRosterTriggers();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  ScriptApp.newTrigger('syncRosterToGitHub')
    .timeBased().everyDays(1).atHour(22).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  SpreadsheetApp.getUi().alert('✅ Roster sync enabled: 10 AM + 10 PM PT');
}

function deleteRosterTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncRosterToGitHub') ScriptApp.deleteTrigger(t);
  });
}

function stopRosterSync() {
  deleteRosterTriggers();
  SpreadsheetApp.getUi().alert('⏸️ Roster sync stopped');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎯 ROSTER SYNC')
    .addItem('⚡ Sync Roster Now', 'syncRosterToGitHub')
    .addItem('🔧 First Time Setup', 'setupRosterSync')
    .addSeparator()
    .addItem('⏰ Twice Daily (10 AM + 10 PM PT)', 'createRosterTriggers')
    .addItem('⏸️ Stop Auto-Sync', 'stopRosterSync')
    .addToUi();
}

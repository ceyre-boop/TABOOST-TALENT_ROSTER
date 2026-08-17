// ============================================================================
// TALENT ROSTER SYNC — Google Sheets → GitHub CSV Pipeline (v2)
// Adapted from Shop Sync script
// Repo: TABOOST-TALENT_ROSTER
// ============================================================================

// ── CONFIG: Talent Roster sheet tabs ────────────────────────────────────────
const SHEET_CONFIG = [
  { tabName: 'Roster',          outputPath: 'data/roster.csv' },
  { tabName: 'Top-Products',    outputPath: 'data/top-products.csv',     optional: true },
  { tabName: 'Sugg-Products',   outputPath: 'data/sugg-products.csv',    optional: true },
  { tabName: 'TopProd-Jul26',   outputPath: 'data/top-products-jul26.csv', optional: true },
  { tabName: 'SuggProd-Jul26',  outputPath: 'data/sugg-products-jul26.csv', optional: true }
];

// ── MAIN SYNC ───────────────────────────────────────────────────────────────
function syncTalentRosterToGitHub() {
  var config = loadConfig_();
  var startTime = new Date();
  var results = [];
  var csvCache = {};

  Logger.log('🚀 Starting Talent Roster sync at ' + startTime.toISOString());

  for (var s = 0; s < SHEET_CONFIG.length; s++) {
    var sheet = SHEET_CONFIG[s];
    try {
      Logger.log('📊 Processing: ' + sheet.tabName);

      var gid = getGidForSheet_(sheet.tabName);
      if (gid === null) {
        if (sheet.optional) {
          Logger.log('⏭️ Skipping optional tab "' + sheet.tabName + '" — not found in this spreadsheet');
          results.push({ sheet: sheet.tabName, path: sheet.outputPath, status: 'skipped' });
          continue;
        }
        throw new Error('Sheet tab "' + sheet.tabName + '" not found in this spreadsheet');
      }

      var csvContent = exportSheetAsCSV_(config.SHEET_ID, gid);
      Logger.log('✅ Exported ' + csvContent.length + ' chars from ' + sheet.tabName);

      csvCache[sheet.tabName] = csvContent;

      Utilities.sleep(1500); // pace exports so Google doesn't rate-limit

      var result = pushToGitHub_(csvContent, config, sheet.outputPath, sheet.tabName);

      results.push({
        sheet: sheet.tabName,
        path: sheet.outputPath,
        status: 'success',
        commit: result.commit.sha.substring(0, 7)
      });

    } catch (error) {
      Logger.log('❌ Failed ' + sheet.tabName + ': ' + error.message);
      results.push({
        sheet: sheet.tabName,
        path: sheet.outputPath,
        status: 'error',
        error: error.message
      });
    }
  }

  var duration = (new Date() - startTime) / 1000;
  var successCount = 0, skippedCount = 0;
  for (var r = 0; r < results.length; r++) {
    if (results[r].status === 'success') successCount++;
    if (results[r].status === 'skipped') skippedCount++;
  }

  Logger.log('✅ Done: ' + successCount + '/' + SHEET_CONFIG.length + ' sheets in ' + duration + 's' +
             (skippedCount ? ' (' + skippedCount + ' optional skipped)' : ''));
  logResults_(results, duration);

  return {
    success: successCount + skippedCount === SHEET_CONFIG.length,
    timestamp: new Date().toISOString(),
    duration: duration,
    results: results
  };
}

// ── TEST ────────────────────────────────────────────────────────────────────
function testTalentRosterSync() {
  return syncTalentRosterToGitHub();
}

// ── EXPORT CSV (with retry — Google throttles rapid exports with HTTP 429) ──
function exportSheetAsCSV_(sheetId, gid) {
  var attempts = 0, maxAttempts = 4;
  while (true) {
    attempts++;
    var cacheBuster = '&t=' + new Date().getTime();
    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=csv&gid=' + gid + cacheBuster;

    var response = UrlFetchApp.fetch(exportUrl, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code === 200) return response.getContentText();

    if (code === 429 && attempts < maxAttempts) {
      var waitMs = 3000 * attempts; // 3s, 6s, 9s
      Logger.log('⏳ Rate-limited (429), retry ' + attempts + '/' + (maxAttempts - 1) + ' in ' + (waitMs / 1000) + 's…');
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error('Export failed (HTTP ' + code + '): ' + response.getContentText().substring(0, 200));
  }
}

// ── GITHUB PUSH ─────────────────────────────────────────────────────────────
function pushToGitHub_(content, config, path, sheetName) {
  var apiUrl = 'https://api.github.com/repos/' + config.GITHUB_OWNER + '/' + config.GITHUB_REPO + '/contents/' + path;

  var sha = null;
  try {
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
  } catch (e) {}

  var timestamp = new Date().toISOString();
  var payload = {
    message: 'Auto-sync: ' + sheetName + ' @ ' + timestamp,
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

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getGidForSheet_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  return sheet.getSheetId().toString();
}

function loadConfig_() {
  var props = PropertiesService.getScriptProperties();
  var activeSheetId = null;
  try {
    activeSheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
    if (activeSheetId) {
      props.setProperty('SHEET_ID', activeSheetId);
    }
  } catch(e) {}

  return {
    GITHUB_TOKEN: props.getProperty('GITHUB_TOKEN'),
    GITHUB_OWNER: props.getProperty('GITHUB_OWNER') || 'ceyre-boop',
    GITHUB_REPO:  props.getProperty('GITHUB_REPO')  || 'TABOOST-TALENT_ROSTER',
    SHEET_ID:     activeSheetId || props.getProperty('SHEET_ID')
  };
}

// ── SETUP ───────────────────────────────────────────────────────────────────
function setupTalentRosterSync() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var token = ui.prompt('GitHub Token', 'Enter your GitHub Personal Access Token:', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('GITHUB_TOKEN', token.getResponseText().trim());

  props.setProperty('GITHUB_OWNER', 'ceyre-boop');
  props.setProperty('GITHUB_REPO', 'TABOOST-TALENT_ROSTER');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  props.setProperty('SHEET_ID', ss.getId());

  var names = ss.getSheets().map(function(s) { return s.getName(); });
  var missing = SHEET_CONFIG.filter(function(cfg) {
    return !cfg.optional && names.indexOf(cfg.tabName) === -1;
  });

  if (missing.length > 0) {
    ui.alert('⚠️ Missing tabs: ' + missing.map(function(m) { return m.tabName; }).join(', ') +
             '\n\nFound tabs: ' + names.join(', '));
    return;
  }

  ui.alert('✅ Setup complete! Run testTalentRosterSync() to verify everything works.');
}

// ── TRIGGERS — Daily at 10 AM PT ────────────────────────────────────────────
function createDailyTrigger() {
  deleteTriggers_();
  ScriptApp.newTrigger('syncTalentRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  SpreadsheetApp.getUi().alert('✅ Daily sync at 10:00 AM PT enabled');
}

function createTwiceDailyTrigger() {
  deleteTriggers_();

  ScriptApp.newTrigger('syncTalentRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();

  ScriptApp.newTrigger('syncTalentRosterToGitHub')
    .timeBased().everyDays(1).atHour(22).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();

  SpreadsheetApp.getUi().alert('✅ Twice-daily sync enabled: 10 AM PT + 10 PM PT');
}

function createHourlyTrigger() {
  deleteTriggers_();
  ScriptApp.newTrigger('syncTalentRosterToGitHub')
    .timeBased().everyHours(1).create();
  SpreadsheetApp.getUi().alert('✅ Hourly sync enabled');
}

function stopSync() {
  deleteTriggers_();
  SpreadsheetApp.getUi().alert('⏸️ Sync stopped');
}

function deleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncTalentRosterToGitHub') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ── LOGGING ─────────────────────────────────────────────────────────────────
function logResults_(results, duration) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName('Sync Log');
    if (!log) {
      log = ss.insertSheet('Sync Log');
      log.appendRow(['Time', 'Duration', 'Sheet', 'Path', 'Status', 'Commit/Error']);
    }
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      log.appendRow([
        new Date().toISOString(),
        duration + 's',
        r.sheet,
        r.path,
        r.status,
        r.commit || r.error || ''
      ]);
    }
  } catch (e) {
    Logger.log('Logging failed: ' + e.message);
  }
}

// ── MENU ────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 ROSTER SYNC')
    .addItem('⚡ Sync Now', 'syncTalentRosterToGitHub')
    .addItem('🔧 First Time Setup', 'setupTalentRosterSync')
    .addSeparator()
    .addItem('⏰ Daily Auto-Sync (10 AM PT)', 'createDailyTrigger')
    .addItem('⏰ Twice Daily (10 AM + 10 PM PT)', 'createTwiceDailyTrigger')
    .addItem('⏰ Hourly Auto-Sync', 'createHourlyTrigger')
    .addItem('⏸️ Stop Auto-Sync', 'stopSync')
    .addToUi();
}

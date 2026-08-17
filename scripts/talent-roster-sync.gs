// ============================================================================
// TALENT ROSTER SYNC — Google Sheets → GitHub CSV Pipeline
// Repo: ceyre-boop/TABOOST-TALENT_ROSTER
//
// IMPORTANT — why the Roster tab is transformed and not pushed raw:
// talent.taboost.me reads data/roster.csv positionally:
//     col 0 = Full Name   col 1 = TikTok handle   col 2 = Categories
//     col 3 = Rate        col 6 = Sales Level
// and it DROPS any row where col 0 or col 1 is empty. The Roster tab's
// col 1 is Email, so pushing it raw makes the page treat emails as
// handles (breaking every avatar) and silently discard every creator
// who has no email on file. Do not "simplify" this by removing the
// transform. Other tabs have no such contract and are pushed as-is.
//
// AVATARS: the page shows assets/avatars/<handle>.jpg and falls back to
// unavatar.io only if that 404s. Treat the fallback as decorative — it
// returns HTTP 429 under any burst, so a handle with no cached file will
// usually render as bare initials. When a NEW handle is added to the
// sheet, cache its picture into assets/avatars/ (see the notes in
// scripts/README-avatars.md) rather than relying on the fallback.
// ============================================================================

// ── CONFIG ──────────────────────────────────────────────────────────────────
// transform: 'roster' runs the column remap. Omit it to push the tab raw.
// optional : true means "skip silently if the tab does not exist".
var SHEET_CONFIG = [
  { tabName: 'Roster',         outputPath: 'data/roster.csv', transform: 'roster' },
  { tabName: 'Top-Products',   outputPath: 'data/top-products.csv',        optional: true },
  { tabName: 'Sugg-Products',  outputPath: 'data/sugg-products.csv',       optional: true },
  { tabName: 'TopProd-Jul26',  outputPath: 'data/top-products-jul26.csv',  optional: true },
  { tabName: 'SuggProd-Jul26', outputPath: 'data/sugg-products-jul26.csv', optional: true }
];

// Guard: if the remap ever yields fewer than this many creators, something
// upstream changed shape. Abort rather than publish a gutted roster to a
// live site. Raise it if the roster genuinely shrinks.
var MIN_CREATORS = 60;

// ── MAIN SYNC ───────────────────────────────────────────────────────────────
function syncTalentRosterToGitHub() {
  var config = loadConfig_();
  var startTime = new Date();
  var results = [];

  Logger.log('🚀 Starting Talent Roster sync at ' + startTime.toISOString());

  for (var s = 0; s < SHEET_CONFIG.length; s++) {
    var sheet = SHEET_CONFIG[s];
    try {
      Logger.log('📊 Processing: ' + sheet.tabName);

      var gid = getGidForSheet_(sheet.tabName);
      if (gid === null) {
        if (sheet.optional) {
          Logger.log('⏭️ Skipping optional tab "' + sheet.tabName + '" — not present');
          results.push({ sheet: sheet.tabName, path: sheet.outputPath, status: 'skipped' });
          continue;
        }
        throw new Error('Sheet tab "' + sheet.tabName + '" not found in this spreadsheet');
      }

      var csvContent = exportSheetAsCSV_(config.SHEET_ID, gid);
      Logger.log('✅ Exported ' + csvContent.length + ' chars from ' + sheet.tabName);

      if (sheet.transform === 'roster') {
        var before = csvContent.length;
        csvContent = transformRoster_(csvContent);
        Logger.log('🔧 Remapped Roster columns: ' + before + ' → ' + csvContent.length + ' chars');
      }

      Utilities.sleep(1500); // pace exports so Google does not rate-limit later tabs

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

// ── ROSTER TRANSFORM ────────────────────────────────────────────────────────
// Roster tab  -> Full Name | Email | Category | Live | UGC | Mom | Rate |
//                Sales Level | TikTok Account | IG Account | Additional TikTok
// Page wants  -> Full Name | TikTok Handle | Categories | Rate | _ | _ | Sales Level
function transformRoster_(csvText) {
  var rows = parseCsvRows_(csvText);
  if (rows.length < 2) throw new Error('Roster tab exported no data rows');

  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });

  // Exact match first: "tiktok account" must hit col I, never
  // "additional tiktok accounts". Substring only as a fallback.
  function col(name) {
    for (var i = 0; i < header.length; i++) if (header[i] === name) return i;
    for (var j = 0; j < header.length; j++) if (header[j].indexOf(name) !== -1) return j;
    throw new Error('Roster tab is missing a "' + name + '" column. Header was: ' + header.join(' | '));
  }

  var iName   = col('full name');
  var iHandle = col('tiktok account');
  var iCat    = col('category');
  var iRate   = col('rate');
  var iLevel  = col('sales level');
  var iExtra  = col('additional tiktok accounts');

  var out  = [['Full Name', 'TikTok Handle', 'Categories', 'Rate', '', '', 'Sales Level']];
  var seen = {};
  var maxIdx = Math.max(iName, iHandle, iCat, iRate, iLevel);

  for (var k = 1; k < rows.length; k++) {
    var r = rows[k];
    if (r.length <= maxIdx) continue;

    var name = String(r[iName] || '').trim();
    if (!name) continue;                         // page would drop these anyway

    // Blank out N/A and spreadsheet error values so no "#ERROR!" filter chip
    // can ever reach the live page.
    var level = String(r[iLevel] || '').trim();
    if (level.toUpperCase() === 'N/A' || level.charAt(0) === '#') level = '';

    var cat  = String(r[iCat]  || '').trim();
    var rate = String(r[iRate] || '').trim();

    // Main account first, then every secondary account, so a creator's cards
    // sit next to each other on the page. Secondary handles spill past the
    // "Additional TikTok Accounts" header into unnamed columns, so sweep to
    // the end of the row rather than reading a single cell. Each secondary
    // card inherits its parent's name, categories, rate and level.
    var handles = [r[iHandle]].concat(r.slice(iExtra));

    for (var x = 0; x < handles.length; x++) {
      var handle = String(handles[x] || '').trim().replace(/^@/, '');
      if (!handle) continue;

      var key = handle.toLowerCase();
      if (seen[key]) continue;                   // one card per TikTok account
      seen[key] = true;

      out.push([name, handle, cat, rate, '', '', level]);
    }
  }

  var count = out.length - 1;
  if (count < MIN_CREATORS) {
    throw new Error('Refusing to publish: remap produced only ' + count +
                    ' creators (floor is ' + MIN_CREATORS + '). The Roster tab layout probably changed.');
  }
  Logger.log('👥 Roster remap produced ' + count + ' creators');

  return serializeCsv_(out);
}

// ── CSV HELPERS ─────────────────────────────────────────────────────────────
function parseCsvRows_(text) {
  // Apps Script ships a spec-compliant parser — quoted commas and embedded
  // newlines included. Hand-rolled splitting mangles rates like "$1,000".
  return Utilities.parseCsv(text);
}

function serializeCsv_(rows) {
  var lines = [];
  for (var i = 0; i < rows.length; i++) {
    var cells = [];
    for (var j = 0; j < rows[i].length; j++) {
      var v = String(rows[i][j] === null || rows[i][j] === undefined ? '' : rows[i][j]);
      if (v.indexOf('"') !== -1 || v.indexOf(',') !== -1 || v.indexOf('\n') !== -1) {
        v = '"' + v.replace(/"/g, '""') + '"';
      }
      cells.push(v);
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

// ── EXPORT CSV (retries — Google throttles rapid exports with HTTP 429) ─────
function exportSheetAsCSV_(sheetId, gid) {
  var attempts = 0, maxAttempts = 4;
  while (true) {
    attempts++;
    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId +
                    '/export?format=csv&gid=' + gid + '&t=' + new Date().getTime();

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
  var apiUrl = 'https://api.github.com/repos/' + config.GITHUB_OWNER + '/' +
               config.GITHUB_REPO + '/contents/' + path;

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

  var payload = {
    message: 'Auto-sync: ' + sheetName + ' @ ' + new Date().toISOString(),
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

// ── DRY RUN — check the remap without writing to GitHub ─────────────────────
function previewRosterTransform() {
  var config = loadConfig_();
  var gid = getGidForSheet_('Roster');
  if (gid === null) throw new Error('No "Roster" tab in this spreadsheet');

  var raw = exportSheetAsCSV_(config.SHEET_ID, gid);
  var mapped = transformRoster_(raw);
  var lines = mapped.split('\n');

  Logger.log('Preview — ' + (lines.length - 2) + ' creators. First 6 rows:');
  for (var i = 0; i < Math.min(6, lines.length); i++) Logger.log('  ' + lines[i]);
  Logger.log('Nothing was written to GitHub.');
  return mapped;
}

function testTalentRosterSync() {
  return syncTalentRosterToGitHub();
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getGidForSheet_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  return sheet ? sheet.getSheetId().toString() : null;
}

function loadConfig_() {
  var props = PropertiesService.getScriptProperties();
  var activeSheetId = null;
  try {
    activeSheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
    if (activeSheetId) props.setProperty('SHEET_ID', activeSheetId);
  } catch (e) {}

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

  var names = ss.getSheets().map(function (s) { return s.getName(); });
  var missing = SHEET_CONFIG.filter(function (cfg) {
    return !cfg.optional && names.indexOf(cfg.tabName) === -1;
  });

  if (missing.length > 0) {
    ui.alert('⚠️ Missing tabs: ' + missing.map(function (m) { return m.tabName; }).join(', ') +
             '\n\nFound tabs: ' + names.join(', '));
    return;
  }

  ui.alert('✅ Setup complete.\n\nRun "Preview Roster Remap" first — it shows what would publish without writing anything.');
}

// ── TRIGGERS ────────────────────────────────────────────────────────────────
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

function stopSync() {
  deleteTriggers_();
  SpreadsheetApp.getUi().alert('⏸️ Sync stopped');
}

function deleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTalentRosterToGitHub') ScriptApp.deleteTrigger(t);
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
      log.appendRow([new Date().toISOString(), duration + 's', r.sheet, r.path,
                     r.status, r.commit || r.error || '']);
    }
  } catch (e) {
    Logger.log('Logging failed: ' + e.message);
  }
}

// ── MENU ────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 ROSTER SYNC')
    .addItem('🔍 Preview Roster Remap (no write)', 'previewRosterTransform')
    .addItem('⚡ Sync Now', 'syncTalentRosterToGitHub')
    .addItem('🔧 First Time Setup', 'setupTalentRosterSync')
    .addSeparator()
    .addItem('⏰ Daily Auto-Sync (10 AM PT)', 'createDailyTrigger')
    .addItem('⏰ Twice Daily (10 AM + 10 PM PT)', 'createTwiceDailyTrigger')
    .addItem('⏸️ Stop Auto-Sync', 'stopSync')
    .addToUi();
}

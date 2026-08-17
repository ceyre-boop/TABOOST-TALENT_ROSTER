// ============================================================================
// TALENT ROSTER SYNC — Roster tab → ceyre-boop/TABOOST-TALENT_ROSTER
//
// HOW TO INSTALL
// This is a SEPARATE .gs file that lives ALONGSIDE the Shop sync in the same
// Apps Script project. Add it as a new file (e.g. RosterSync.gs). Do not paste
// it into Code.gs and do not delete the Shop sync.
//
// WHY EVERY NAME IN HERE IS PREFIXED
// All .gs files in one Apps Script project share a single global scope. The
// Shop sync already defines SHEET_CONFIG, exportSheetAsCSV_, pushToGitHub_,
// loadConfig_, logResults_, getGidForSheet_, onOpen and friends. Re-declaring
// any of them throws "Identifier 'X' has already been declared" and BOTH
// scripts stop working. Everything below is therefore prefixed ROSTER_ /
// roster*, and this file deliberately declares NO onOpen. Keep it that way
// when editing.
//
// WHY THIS DOES NOT READ GITHUB_REPO FROM SCRIPT PROPERTIES
// The Shop sync stores GITHUB_REPO = 'TABOOST-Shop' in the shared script
// properties. Reading it here would push the roster into the Shop repo, and
// writing it here would break the Shop sync. Owner and repo are hardcoded
// constants below. Only GITHUB_TOKEN is shared, and this file never writes it.
//
// WHY THE ROSTER TAB IS TRANSFORMED AND NOT PUSHED RAW
// talent.taboost.me reads data/roster.csv positionally:
//     col 0 = Full Name   col 1 = TikTok handle   col 2 = Categories
//     col 3 = Rate        col 6 = Sales Level
// and it DROPS any row where col 0 or col 1 is empty. The Roster tab's col 1
// is Email, so pushing it raw makes the page render emails as handles (every
// avatar breaks) and silently discards every creator with no email on file —
// it took the live site down to 22 cards on 2026-08-17. Do not "simplify"
// this by removing the transform.
//
// AVATARS
// The page shows assets/avatars/<handle>.jpg and falls back to unavatar.io
// only if that 404s. Treat the fallback as decorative — it returns HTTP 429
// under any burst, so a handle with no cached file renders as bare initials.
// When new talent is added, cache the picture into assets/avatars/ first:
// see scripts/README-avatars.md.
// ============================================================================

// ── CONFIG ──────────────────────────────────────────────────────────────────
var ROSTER_GITHUB_OWNER = 'ceyre-boop';
var ROSTER_GITHUB_REPO  = 'TABOOST-TALENT_ROSTER';
var ROSTER_TAB_NAME     = 'Roster';
var ROSTER_OUTPUT_PATH  = 'data/roster.csv';

// Guard: if the remap ever yields fewer than this many creators, something
// upstream changed shape. Abort rather than publish a gutted roster to a live
// site. Raise it if the roster genuinely shrinks.
var ROSTER_MIN_CREATORS = 60;

// ── MAIN SYNC ───────────────────────────────────────────────────────────────
function syncTalentRosterToGitHub() {
  var started = new Date();
  Logger.log('🚀 Roster sync started ' + started.toISOString());

  var gid = rosterGid_(ROSTER_TAB_NAME);
  if (gid === null) throw new Error('No "' + ROSTER_TAB_NAME + '" tab in this spreadsheet');

  var raw = rosterExportCsv_(rosterSpreadsheetId_(), gid);
  Logger.log('✅ Exported ' + raw.length + ' chars from ' + ROSTER_TAB_NAME);

  var mapped = rosterTransform_(raw);
  var result = rosterPushToGitHub_(mapped, ROSTER_OUTPUT_PATH);

  var duration = (new Date() - started) / 1000;
  var sha = result.commit.sha.substring(0, 7);
  Logger.log('✅ Roster synced in ' + duration + 's — commit ' + sha);
  rosterLog_(sha, duration);

  return { success: true, commit: sha, duration: duration };
}

function testTalentRosterSync() {
  return syncTalentRosterToGitHub();
}

// ── DRY RUN — verify the remap without writing to GitHub ────────────────────
function previewRosterTransform() {
  var gid = rosterGid_(ROSTER_TAB_NAME);
  if (gid === null) throw new Error('No "' + ROSTER_TAB_NAME + '" tab in this spreadsheet');

  var mapped = rosterTransform_(rosterExportCsv_(rosterSpreadsheetId_(), gid));
  var lines = mapped.split('\n');

  Logger.log('── PREVIEW — nothing was written to GitHub ──');
  Logger.log('Would publish ' + (lines.length - 2) + ' creators to ' +
             ROSTER_GITHUB_OWNER + '/' + ROSTER_GITHUB_REPO + '/' + ROSTER_OUTPUT_PATH);
  Logger.log('First rows:');
  for (var i = 0; i < Math.min(6, lines.length); i++) Logger.log('  ' + lines[i]);
  return mapped;
}

// ── TRANSFORM ───────────────────────────────────────────────────────────────
// Roster tab  -> Full Name | Email | Category | Live | UGC | Mom | Rate |
//                Sales Level | TikTok Account | ...
// Page wants  -> Full Name | TikTok Handle | Categories | Rate | _ | _ | Sales Level
function rosterTransform_(csvText) {
  var rows = Utilities.parseCsv(csvText);   // spec-compliant: keeps "$1,000" intact
  if (rows.length < 2) throw new Error('Roster tab exported no data rows');

  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });

  // Exact match first, so "tiktok account" hits col I and never
  // "additional tiktok accounts". Substring only as a fallback.
  function col(name) {
    for (var i = 0; i < header.length; i++) if (header[i] === name) return i;
    for (var j = 0; j < header.length; j++) if (header[j].indexOf(name) !== -1) return j;
    throw new Error('Roster tab has no "' + name + '" column. Header: ' + header.join(' | '));
  }

  var iName   = col('full name');
  var iHandle = col('tiktok account');
  var iCat    = col('category');
  var iRate   = col('rate');
  var iLevel  = col('sales level');

  var out    = [['Full Name', 'TikTok Handle', 'Categories', 'Rate', '', '', 'Sales Level']];
  var seen   = {};
  var maxIdx = Math.max(iName, iHandle, iCat, iRate, iLevel);

  // ONE CARD PER SHEET ROW, keyed on the primary TikTok Account (col I).
  // Any "Additional TikTok Accounts" column is deliberately NOT expanded:
  // publishing those took the roster from 95 to 110 and broke parity with the
  // sheet's row count, which is how the roster gets reviewed. Rows that reuse
  // a handle from an earlier row collapse into it, so 97 rows yields 95 cards.
  for (var k = 1; k < rows.length; k++) {
    var r = rows[k];
    if (r.length <= maxIdx) continue;

    var name   = String(r[iName]   || '').trim();
    var handle = String(r[iHandle] || '').trim().replace(/^@/, '');
    if (!name || !handle) continue;            // the page would drop these anyway

    var key = handle.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;

    // Blank out N/A and spreadsheet error values so no "#ERROR!" filter chip
    // can reach the live page.
    var level = String(r[iLevel] || '').trim();
    if (level.toUpperCase() === 'N/A' || level.charAt(0) === '#') level = '';

    out.push([
      name,
      handle,
      String(r[iCat]  || '').trim(),
      String(r[iRate] || '').trim(),
      '', '',
      level
    ]);
  }

  var count = out.length - 1;
  if (count < ROSTER_MIN_CREATORS) {
    throw new Error('Refusing to publish: remap produced only ' + count + ' creators (floor ' +
                    ROSTER_MIN_CREATORS + '). The Roster tab layout probably changed.');
  }
  Logger.log('👥 Remap produced ' + count + ' creators');

  return rosterSerializeCsv_(out);
}

function rosterSerializeCsv_(rows) {
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

// ── EXPORT (retries — Google throttles rapid exports with HTTP 429) ─────────
function rosterExportCsv_(sheetId, gid) {
  var attempts = 0, maxAttempts = 4;
  while (true) {
    attempts++;
    var url = 'https://docs.google.com/spreadsheets/d/' + sheetId +
              '/export?format=csv&gid=' + gid + '&t=' + new Date().getTime();

    var res = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    if (code === 200) return res.getContentText();

    if (code === 429 && attempts < maxAttempts) {
      var waitMs = 3000 * attempts;
      Logger.log('⏳ Rate-limited (429), retry ' + attempts + ' in ' + (waitMs / 1000) + 's…');
      Utilities.sleep(waitMs);
      continue;
    }
    throw new Error('Export failed (HTTP ' + code + '): ' + res.getContentText().substring(0, 200));
  }
}

// ── GITHUB PUSH ─────────────────────────────────────────────────────────────
function rosterPushToGitHub_(content, path) {
  var token = rosterToken_();
  var apiUrl = 'https://api.github.com/repos/' + ROSTER_GITHUB_OWNER + '/' +
               ROSTER_GITHUB_REPO + '/contents/' + path;

  var sha = null;
  try {
    var check = UrlFetchApp.fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json' },
      muteHttpExceptions: true
    });
    if (check.getResponseCode() === 200) sha = JSON.parse(check.getContentText()).sha;
  } catch (e) {}

  var payload = {
    message: 'Auto-sync: Roster @ ' + new Date().toISOString(),
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: 'main'
  };
  if (sha) payload.sha = sha;

  var res = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('GitHub PUT error ' + code + ': ' + res.getContentText().substring(0, 300));
  }
  return JSON.parse(res.getContentText());
}

// ── HELPERS ─────────────────────────────────────────────────────────────────
function rosterGid_(tabName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  return sheet ? sheet.getSheetId().toString() : null;
}

function rosterSpreadsheetId_() {
  return SpreadsheetApp.getActiveSpreadsheet().getId();
}

// Reads the token the Shop sync already stored. Never writes it, and never
// touches GITHUB_OWNER / GITHUB_REPO — those belong to the Shop sync.
function rosterToken_() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error('No GITHUB_TOKEN in script properties. Run the Shop sync setup first, ' +
                    'or add GITHUB_TOKEN under Project Settings → Script Properties.');
  }
  return token;
}

function rosterLog_(sha, duration) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var log = ss.getSheetByName('Sync Log');
    if (!log) {
      log = ss.insertSheet('Sync Log');
      log.appendRow(['Time', 'Duration', 'Sheet', 'Path', 'Status', 'Commit/Error']);
    }
    log.appendRow([new Date().toISOString(), duration + 's', ROSTER_TAB_NAME,
                   ROSTER_OUTPUT_PATH, 'success', sha]);
  } catch (e) {
    Logger.log('Logging failed: ' + e.message);
  }
}

// ── TRIGGERS ────────────────────────────────────────────────────────────────
function createRosterDailyTrigger() {
  rosterDeleteTriggers_();
  ScriptApp.newTrigger('syncTalentRosterToGitHub')
    .timeBased().everyDays(1).atHour(10).nearMinute(0)
    .inTimezone('America/Los_Angeles').create();
  Logger.log('✅ Roster sync scheduled daily at 10:00 AM PT');
}

function stopRosterSync() {
  rosterDeleteTriggers_();
  Logger.log('⏸️ Roster sync triggers removed');
}

function rosterDeleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTalentRosterToGitHub') ScriptApp.deleteTrigger(t);
  });
}

// ── OPTIONAL MENU ───────────────────────────────────────────────────────────
// This file declares NO onOpen — the Shop sync owns that. To add a Roster
// submenu, paste this ONE line inside the existing onOpen() in Code.gs:
//
//     addRosterSyncMenu_();
//
// Everything here also runs from the Apps Script editor's function dropdown,
// so the menu is entirely optional.
function addRosterSyncMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('🔄 ROSTER SYNC')
    .addItem('🔍 Preview Remap (no write)', 'previewRosterTransform')
    .addItem('⚡ Sync Roster Now', 'syncTalentRosterToGitHub')
    .addSeparator()
    .addItem('⏰ Daily 10 AM PT', 'createRosterDailyTrigger')
    .addItem('⏸️ Stop Roster Sync', 'stopRosterSync')
    .addToUi();
}

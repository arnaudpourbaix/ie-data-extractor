#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  mergeExtraction,
  formatChangeLog,
  parseInput,
  parseDestination,
  formatDestinationCsv,
} = require('./lib');

// A history snapshot is `<NNN>_<origin>.csv`: a zero-padded global sequence
// number, an underscore, then the --origin the extract-creatures run was given
// (which may contain `#`, `-`, etc.). The companion log is `<NNN>_<origin>_changes.log`.
const SNAPSHOT_RE = /^(\d+)_(.+)\.csv$/;

function parseArgs(argv) {
  let destination = null;
  let history = null;
  let dryRun = false;
  let keepOrphans = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--destination') {
      destination = argv[++i];
    } else if (argv[i] === '--history') {
      history = argv[++i];
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--keep-orphans') {
      keepOrphans = true;
    }
  }
  return {
    destination: destination || path.join('extract', 'csv', 'creatures.csv'),
    history,
    dryRun,
    keepOrphans,
  };
}

// Every `<NNN>_<origin>.csv` directly inside historyDir, oldest first. Anything
// else — the `_changes.log` files, the `backup/` folder, stray files — is ignored.
function collectSnapshots(historyDir) {
  const snapshots = [];
  for (const name of fs.readdirSync(historyDir)) {
    const full = path.join(historyDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const m = SNAPSHOT_RE.exec(name);
    if (!m) continue;
    snapshots.push({ seq: parseInt(m[1], 10), seqText: m[1], origin: m[2], name, path: full });
  }
  snapshots.sort((a, b) => a.seq - b.seq);
  return snapshots;
}

function run({ destinationPath, historyDir, dryRun = false, keepOrphans = false }) {
  const destinationDir = path.dirname(destinationPath);
  if (!fs.existsSync(destinationDir)) {
    throw new Error(`destination directory not found: ${destinationDir}`);
  }
  const resolvedHistoryDir = historyDir || path.join(destinationDir, 'history');
  if (!fs.existsSync(resolvedHistoryDir)) {
    throw new Error(`history directory not found: ${resolvedHistoryDir}`);
  }

  const snapshots = collectSnapshots(resolvedHistoryDir);
  if (snapshots.length === 0) {
    throw new Error(`no <NNN>_<origin>.csv snapshots found in ${resolvedHistoryDir}`);
  }

  const warnings = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    if (cur.seq === prev.seq) {
      warnings.push(`${cur.name}: shares sequence number ${cur.seqText} with ${prev.name}`);
    } else if (cur.seq !== prev.seq + 1) {
      warnings.push(`sequence gap: ${cur.name} follows ${prev.name} — replaying anyway`);
    }
  }

  // Replay every surviving snapshot in order against an initially empty master
  // list. The first snapshot bootstraps the whole roster; each later one diffs
  // against the accumulated state, exactly as a live install would have.
  let destinationText = '';
  const logsWritten = [];
  const logsDeleted = [];

  for (const snap of snapshots) {
    const inputText = fs.readFileSync(snap.path, 'utf8');
    const result = mergeExtraction({
      destinationText,
      inputText,
      origin: snap.origin,
      sourceLabel: snap.name,
    });
    destinationText = result.destinationText;
    for (const w of result.warnings) warnings.push(`${snap.name}: ${w}`);

    // Rewrite the per-install change log to match this fresh replay. The
    // bootstrap snapshot never gets one (it *is* the initial roster); a snapshot
    // that now replays as a no-op loses any stale log it had on disk.
    const logPath = path.join(resolvedHistoryDir, `${snap.seqText}_${snap.origin}_changes.log`);
    const earnsLog = !result.bootstrapping
      && (result.newRows.length > 0 || result.changedRows.length > 0);
    if (earnsLog) {
      if (!dryRun) {
        fs.writeFileSync(
          logPath,
          formatChangeLog(snap.origin, result.newRows, result.changedRows, result.nameField),
        );
      }
      logsWritten.push(path.basename(logPath));
    } else if (fs.existsSync(logPath)) {
      if (!dryRun) fs.rmSync(logPath);
      logsDeleted.push(path.basename(logPath));
    }
  }

  // Replay only ever adds or updates creatures, so a `.cre` that some mod later
  // deleted from override/ lingers in the rebuilt list. The newest surviving
  // snapshot is a full override/ extraction — the authoritative current roster —
  // so anything absent from it is stale and gets dropped. `--keep-orphans` opts
  // out (matching the pre-rebuild incremental behaviour, stale rows and all).
  const pruned = [];
  if (!keepOrphans) {
    const last = snapshots[snapshots.length - 1];
    const { rows: lastRows, columns: lastColumns } = parseInput(
      fs.readFileSync(last.path, 'utf8'),
      last.name,
    );
    const liveKeys = new Set(lastRows.map((r) => r[lastColumns[0]]));
    const dest = parseDestination(destinationText);
    const keyCol = dest.columns[0];
    const nameCol = dest.columns[dest.columns.length - 1];
    const kept = dest.rows.filter((row) => {
      if (liveKeys.has(row[keyCol])) return true;
      pruned.push(row[nameCol] ? `${row[keyCol]} (${row[nameCol]})` : row[keyCol]);
      return false;
    });
    if (pruned.length > 0) {
      destinationText = formatDestinationCsv(kept, [], dest.columns);
    }
  }

  const creatureCount = Math.max(
    0,
    destinationText.split(/\r?\n/).filter((l) => l.length > 0).length - 1,
  );

  if (!dryRun) {
    fs.writeFileSync(destinationPath, destinationText);
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const summary =
    `${dryRun ? '[dry-run] ' : ''}replayed ${snapshots.length} snapshot(s) ` +
    `(${first.name} .. ${last.name}); ` +
    `${creatureCount} creature(s)${dryRun ? ' would be' : ''} in ${destinationPath}; ` +
    `${logsWritten.length} change log(s) ${dryRun ? 'would be ' : ''}written, ` +
    `${logsDeleted.length} ${dryRun ? 'would be ' : ''}removed` +
    (keepOrphans
      ? '; orphan pruning skipped'
      : `; ${pruned.length} orphan(s) ${dryRun ? 'would be ' : ''}pruned`);

  return {
    summary,
    warnings,
    creatureCount,
    snapshots: snapshots.length,
    logsWritten,
    logsDeleted,
    pruned,
  };
}

function main() {
  try {
    const { destination, history, dryRun, keepOrphans } = parseArgs(process.argv.slice(2));
    const { summary, warnings, pruned } = run({
      destinationPath: destination,
      historyDir: history,
      dryRun,
      keepOrphans,
    });
    for (const w of warnings) console.warn(w);
    for (const p of pruned) console.warn(`pruned orphan: ${p}`);
    console.log(summary);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, collectSnapshots, run, main };

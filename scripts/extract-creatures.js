#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { mergeExtraction, formatChangeLog } = require('./lib');

function parseArgs(argv) {
  let origin = null;
  let destination = null;
  let source = null;
  let history = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin') {
      origin = argv[++i];
    } else if (argv[i] === '--destination') {
      destination = argv[++i];
    } else if (argv[i] === '--source') {
      source = argv[++i];
    } else if (argv[i] === '--history') {
      history = argv[++i];
    }
  }
  if (!origin) {
    throw new Error('--origin <name> is required');
  }
  return {
    origin,
    destination: destination || path.join('extract', 'csv', 'creatures.csv'),
    source,
    history,
  };
}

// Next global install number for the history folder: max leading integer across
// existing <n>_<mod>.csv snapshots, plus one. Zero-padded to 3 for sane sorting.
function nextHistorySequence(historyDir) {
  let max = 0;
  for (const name of fs.readdirSync(historyDir)) {
    const m = /^(\d+)_.*\.csv$/.exec(name);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function run({ origin, destinationPath, sourcePath, historyDir }) {
  const destinationDir = path.dirname(destinationPath);
  if (!fs.existsSync(destinationDir)) {
    throw new Error(`destination directory not found: ${destinationDir}`);
  }
  const inputPath = sourcePath || path.join(destinationDir, 'source.csv');
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }

  const inputText = fs.readFileSync(inputPath, 'utf8');
  const destinationText = fs.existsSync(destinationPath)
    ? fs.readFileSync(destinationPath, 'utf8')
    : '';

  const {
    destinationText: mergedText,
    warnings,
    newRows,
    changedRows,
    migrated,
    bootstrapping,
    destinationChanged,
    wantedColumns,
    nameField,
  } = mergeExtraction({ destinationText, inputText, origin, sourceLabel: inputPath });

  if (destinationChanged) {
    fs.writeFileSync(destinationPath, mergedText);
  }

  // A history snapshot only earns its place when the run actually moved state:
  // a creature was added or modified, or the column layout was migrated. A clean
  // re-run's extraction is byte-identical to the newest snapshot already on disk,
  // so copying it again would just add noise and burn a sequence number.
  let historyCsvPath = null;
  let historyLogPath = null;
  if (destinationChanged) {
    const resolvedHistoryDir = historyDir || path.join(destinationDir, 'history');
    fs.mkdirSync(resolvedHistoryDir, { recursive: true });
    const seq = String(nextHistorySequence(resolvedHistoryDir)).padStart(3, '0');
    historyCsvPath = path.join(resolvedHistoryDir, `${seq}_${origin}.csv`);
    fs.copyFileSync(inputPath, historyCsvPath);

    // Log this install's footprint (added + modified creatures). Skipped when
    // bootstrapping — the 001 snapshot already *is* the full initial roster.
    if (!bootstrapping && (newRows.length > 0 || changedRows.length > 0)) {
      historyLogPath = path.join(resolvedHistoryDir, `${seq}_${origin}_changes.log`);
      fs.writeFileSync(historyLogPath, formatChangeLog(origin, newRows, changedRows, nameField));
    }
  }

  // The default source.csv is the extract component's raw dump — transient input
  // with no use once the merge succeeds (its content is now in history/, or was
  // already identical to the latest snapshot). Remove it so a later stray run
  // can't silently read stale data. Left alone when the caller passed an explicit
  // --source (their file), or when warnings flag a snapshot worth inspecting.
  let sourceRemoved = false;
  if (!sourcePath && warnings.length === 0 && fs.existsSync(inputPath)) {
    fs.rmSync(inputPath);
    sourceRemoved = true;
  }

  const summary = `${newRows.length} new creature(s) added (origin=${origin}), ` +
    `${changedRows.length} changed creature(s) applied` +
    (migrated ? `, destination migrated to ${wantedColumns.length} columns` : '') +
    `; ${historyCsvPath ? `history snapshot ${historyCsvPath}` : 'no changes — no history snapshot'}` +
    (historyLogPath ? `, change log ${historyLogPath}` : '') +
    (sourceRemoved ? '; source.csv removed' : '');

  return { summary, warnings };
}

function main() {
  try {
    const { origin, destination, source, history } = parseArgs(process.argv.slice(2));
    const { summary, warnings } = run({
      origin,
      destinationPath: destination,
      sourcePath: source,
      historyDir: history,
    });
    for (const w of warnings) console.warn(w);
    console.log(summary);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, run, main };

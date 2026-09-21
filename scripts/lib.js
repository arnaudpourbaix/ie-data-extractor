const ORIGIN_COLUMN = 'origin';
const INVALID_STRREF_NAME = '<Invalid Strref -1>';
const EOL = '\r\n';

function splitCsvLine(line, fieldCount) {
  const parts = line.split(';');
  if (fieldCount && parts.length > fieldCount) {
    const head = parts.slice(0, fieldCount - 1);
    const tail = parts.slice(fieldCount - 1).join(';');
    return [...head, tail];
  }
  return parts;
}

function joinCsvLine(fields) {
  return fields.join(';');
}

// The destination (creatures.csv) carries every input column plus an `origin`
// column inserted just before the trailing name column.
function deriveDestinationColumns(inputColumns) {
  if (inputColumns.length < 2) return [...inputColumns];
  const head = inputColumns.slice(0, -1);
  const nameCol = inputColumns[inputColumns.length - 1];
  return [...head, ORIGIN_COLUMN, nameCol];
}

// Fields whose changes are tracked: everything except the key (first column)
// and the display name (last column). When migrating an existing destination
// that predates some input columns, only columns already present in that
// destination are compared — brand-new columns have no prior value to diff.
function computeCompareFields(inputColumns, destinationColumns) {
  const middle = inputColumns.slice(1, -1);
  if (!destinationColumns || destinationColumns.length === 0) return middle;
  const destSet = new Set(destinationColumns);
  return middle.filter((col) => destSet.has(col));
}

// The extract component prefixes source.csv with a blank line, so the header is
// the first *non-empty* line, not necessarily line 0. Column names come from
// that header, so adding/removing columns in extract.tp2 needs no code change.
function parseInput(text, sourceLabel) {
  const rows = [];
  const warnings = [];
  const lines = text.split(/\r?\n/);
  let headerLine = null;
  let columns = null;
  let nameCol = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (columns === null) {
      headerLine = line;
      columns = line.split(';');
      nameCol = columns[columns.length - 1];
      continue;
    }
    if (line === headerLine) {
      warnings.push(`${sourceLabel}:${i + 1}: repeated header line — skipped`);
      continue;
    }
    const fields = splitCsvLine(line, columns.length);
    if (fields.length !== columns.length) {
      warnings.push(`${sourceLabel}:${i + 1}: expected ${columns.length} columns, got ${fields.length} — skipped`);
      continue;
    }
    const row = {};
    columns.forEach((col, idx) => { row[col] = fields[idx]; });
    if (row[nameCol] === INVALID_STRREF_NAME) row[nameCol] = '';
    rows.push(row);
  }
  return { rows, warnings, columns: columns || [] };
}

function parseDestination(text) {
  const rows = [];
  const byFile = new Map();
  const lines = (text || '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { rows, byFile, columns: [] };
  const columns = lines[0].split(';');
  const keyCol = columns[0];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i], columns.length);
    if (fields.length !== columns.length) continue;
    const row = {};
    columns.forEach((col, idx) => { row[col] = fields[idx]; });
    rows.push(row);
    byFile.set(row[keyCol], row);
  }
  return { rows, byFile, columns };
}

// Reproject existing destination rows onto a new column layout: keep values for
// columns that survive, backfill brand-new columns from the current extraction
// (matched by key) or an empty string. Never reported as a per-creature change.
function migrateDestination(destination, wantedColumns, inputRows, keyField) {
  const originalColumns = destination.columns;
  if (originalColumns.length === 0) return false;
  if (originalColumns.join(';') === wantedColumns.join(';')) return false;

  const originalSet = new Set(originalColumns);
  const inputByKey = new Map(inputRows.map((r) => [r[keyField], r]));
  destination.rows = destination.rows.map((row) => {
    const src = inputByKey.get(row[keyField]);
    const next = {};
    for (const col of wantedColumns) {
      if (originalSet.has(col)) {
        next[col] = row[col] === undefined ? '' : row[col];
      } else {
        next[col] = src && src[col] !== undefined ? src[col] : '';
      }
    }
    return next;
  });
  destination.byFile = new Map(destination.rows.map((r) => [r[keyField], r]));
  destination.columns = [...wantedColumns];
  return true;
}

function diffCreatures(inputRows, destination, origin, options = {}) {
  const keyField = options.keyField || 'file';
  const compareFields = options.compareFields
    || (inputRows.length ? Object.keys(inputRows[0]).slice(1, -1) : []);
  const newRows = [];
  const changedRows = [];
  for (const inputRow of inputRows) {
    const existing = destination.byFile.get(inputRow[keyField]);
    if (!existing) {
      newRows.push({ ...inputRow, [ORIGIN_COLUMN]: origin });
      continue;
    }
    const changes = [];
    for (const field of compareFields) {
      const oldValue = existing[field] === undefined ? '' : existing[field];
      const newValue = inputRow[field] === undefined ? '' : inputRow[field];
      if (oldValue !== newValue) {
        changes.push({ field, oldValue, newValue });
      }
    }
    if (changes.length > 0) {
      // origin records the mod that first introduced the creature and is
      // immutable: a later mod modifying tracked fields updates those values
      // but its own origin value is kept, never the modifying mod's.
      changedRows.push({
        file: inputRow[keyField],
        changes,
        updatedRow: { ...existing, ...inputRow, [ORIGIN_COLUMN]: existing[ORIGIN_COLUMN] },
      });
    }
  }
  return { newRows, changedRows };
}

// The pure core of one merge step: fold a single extraction (inputText) into the
// current master list (destinationText) under a given origin, returning the new
// master text plus everything a caller needs to report or log the step. Does no
// I/O — extract-creatures.js drives it from source.csv, rebuild-creatures.js
// drives it once per history snapshot. `sourceLabel` only tags parse warnings.
function mergeExtraction({ destinationText, inputText, origin, sourceLabel = 'input' }) {
  const { rows: inputRows, warnings, columns: inputColumns } = parseInput(inputText, sourceLabel);
  if (inputColumns.length < 2) {
    throw new Error(`input has no usable header: ${sourceLabel}`);
  }

  const destination = parseDestination(destinationText || '');
  const bootstrapping = destination.rows.length === 0;
  const originalDestColumns = destination.columns;
  const wantedColumns = deriveDestinationColumns(inputColumns);
  const keyField = inputColumns[0];
  const nameField = inputColumns[inputColumns.length - 1];

  const migrated = migrateDestination(destination, wantedColumns, inputRows, keyField);
  const compareFields = computeCompareFields(inputColumns, originalDestColumns);
  const { newRows, changedRows } = diffCreatures(inputRows, destination, origin, {
    keyField,
    compareFields,
  });

  const destinationChanged = migrated || newRows.length > 0 || changedRows.length > 0;
  let nextDestinationText = destinationText || '';
  if (destinationChanged) {
    const updatedByFile = new Map(changedRows.map((c) => [c.file, c.updatedRow]));
    const updatedExistingRows = destination.rows.map((row) => updatedByFile.get(row[keyField]) || row);
    nextDestinationText = formatDestinationCsv(updatedExistingRows, newRows, wantedColumns);
  }

  return {
    destinationText: nextDestinationText,
    warnings,
    newRows,
    changedRows,
    migrated,
    bootstrapping,
    destinationChanged,
    wantedColumns,
    keyField,
    nameField,
  };
}

function formatDestinationCsv(existingRows, newRows, columns) {
  const allRows = [...existingRows, ...newRows];
  const lines = [columns.join(';')];
  for (const row of allRows) {
    lines.push(columns.map((col) => (row[col] === undefined ? '' : row[col])).join(';'));
  }
  return lines.join(EOL) + EOL;
}

// A per-install record: a count line, then the resrefs this mod added, then
// each existing creature it modified with the field-level old -> new diff.
// Each creature line is `<resref>  <display name>` (resref alone if unnamed).
function formatChangeLog(origin, newRows, changedRows, nameField = 'name') {
  const creatureLine = (resref, name) => (name ? `  ${resref.padEnd(8)}  ${name}` : `  ${resref}`);
  const lines = [`${origin}: ${newRows.length} new, ${changedRows.length} changed`];
  if (newRows.length > 0) {
    lines.push('', `NEW (${newRows.length}):`);
    for (const row of newRows) lines.push(creatureLine(row.file, row[nameField]));
  }
  if (changedRows.length > 0) {
    lines.push('', `CHANGED (${changedRows.length}):`);
    for (const entry of changedRows) {
      lines.push(creatureLine(entry.file, entry.updatedRow && entry.updatedRow[nameField]));
      for (const c of entry.changes) {
        lines.push(`    ${c.field}: ${c.oldValue} -> ${c.newValue}`);
      }
    }
  }
  return lines.join(EOL) + EOL;
}

module.exports = {
  ORIGIN_COLUMN,
  INVALID_STRREF_NAME,
  splitCsvLine,
  joinCsvLine,
  deriveDestinationColumns,
  computeCompareFields,
  parseInput,
  parseDestination,
  migrateDestination,
  diffCreatures,
  mergeExtraction,
  formatDestinationCsv,
  formatChangeLog,
};

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitCsvLine,
  joinCsvLine,
  deriveDestinationColumns,
  computeCompareFields,
  parseDestination,
  parseInput,
  migrateDestination,
  diffCreatures,
  mergeExtraction,
  formatDestinationCsv,
  formatChangeLog,
} = require('./lib');

const WIDE_HEADER =
  'file;general;race;class;anim;deathvar;dialog;level;gender;sex;allegiance;' +
  'overrideScript;classScript;raceScript;generalScript;defaultScript;' +
  'helmet;shield;lring;rring;amulet;weapon1;weapon2;weapon3;weapon4;xpv;name';

test('splitCsvLine splits a line with exactly the expected field count', () => {
  const result = splitCsvLine('AATAQAH;GIANTHUMANOID;GENIE', 3);
  assert.deepEqual(result, ['AATAQAH', 'GIANTHUMANOID', 'GENIE']);
});

test('splitCsvLine merges an extra semicolon-separated piece (e.g. an embedded quote) into the last field', () => {
  const result = splitCsvLine('AATAQAH;GENIE;Bertrand the "Companion"', 3);
  assert.deepEqual(result, ['AATAQAH', 'GENIE', 'Bertrand the "Companion"']);
});

test('splitCsvLine merges pieces split on an embedded semicolon in the last field', () => {
  const result = splitCsvLine('AATAQAH;GENIE;Name; With; Semicolons', 3);
  assert.deepEqual(result, ['AATAQAH', 'GENIE', 'Name; With; Semicolons']);
});

test('splitCsvLine returns fewer fields than expected unchanged, for malformed-row detection', () => {
  const result = splitCsvLine('AATAQAH;GENIE', 3);
  assert.deepEqual(result, ['AATAQAH', 'GENIE']);
});

test('splitCsvLine without a fieldCount just splits on semicolon', () => {
  const result = splitCsvLine('AATAQAH;GENIE;Aataqah');
  assert.deepEqual(result, ['AATAQAH', 'GENIE', 'Aataqah']);
});

test('joinCsvLine joins fields with semicolons, unquoted', () => {
  const result = joinCsvLine(['AATAQAH', 'GENIE', 'Bertrand the "Companion"']);
  assert.equal(result, 'AATAQAH;GENIE;Bertrand the "Companion"');
});

test('parseDestination returns no rows for an empty string', () => {
  const { rows, byFile } = parseDestination('');
  assert.deepEqual(rows, []);
  assert.equal(byFile.size, 0);
});

test('parseDestination returns no rows for header-only text', () => {
  const { rows } = parseDestination('file;general;race;class;anim;deathvar;dialog;origin;name\r\n');
  assert.deepEqual(rows, []);
});

test('parseDestination parses a data row with an embedded quote in name, indexed by file', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;base;Bertrand the "Companion"\r\n';
  const { rows, byFile } = parseDestination(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Bertrand the "Companion"');
  assert.equal(byFile.get('BERTRAND').origin, 'base');
});

test('parseDestination skips a malformed row without throwing, even after a blank line', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AAA;G;R;C;ANIM;DV;DLG;base;A\r\n' +
    '\r\n' +
    'BADROW;ONLYTHREE\r\n';
  const { rows } = parseDestination(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'AAA');
});

test('parseInput parses a data row without an origin column, name last', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n';
  const { rows, warnings } = parseInput(text, 'test.csv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'AATAQAH');
  assert.equal(rows[0].name, 'Aataqah');
  assert.deepEqual(warnings, []);
});

test('parseInput preserves a name containing an unescaped embedded quote', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;Bertrand the "Companion"\r\n';
  const { rows, warnings } = parseInput(text, 'test.csv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Bertrand the "Companion"');
  assert.deepEqual(warnings, []);
});

test('parseInput warns and skips a repeated header line appearing mid-file', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n' +
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;Bertrand\r\n';
  const { rows, warnings } = parseInput(text, 'test.csv');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.file), ['AATAQAH', 'BERTRAND']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test\.csv:3: repeated header line/);
});

test('parseInput warns and skips a row with too few columns', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'BADROW;ONLYTWO\r\n';
  const { rows, warnings } = parseInput(text, 'test.csv');
  assert.equal(rows.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test\.csv:2/);
});

test('parseInput reports the correct line number even when a blank line precedes a malformed row', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AAA;G;R;C;ANIM;DV;DLG;A\r\n' +
    '\r\n' +
    'BADROW;ONLYTWO\r\n';
  const { rows, warnings } = parseInput(text, 'test.csv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'AAA');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test\.csv:4/);
});

test('diffCreatures treats a file missing from destination as new, tagged with origin', () => {
  const destination = parseDestination('');
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { newRows, changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0].origin, 'cdtweaks');
  assert.equal(newRows[0].file, 'AATAQAH');
  assert.deepEqual(changedRows, []);
});

test('diffCreatures flags a field mismatch as changed without altering destination rows', () => {
  const destination = parseDestination(
    'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah\r\n'
  );
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { newRows, changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.deepEqual(newRows, []);
  assert.equal(changedRows.length, 1);
  assert.deepEqual(changedRows[0].changes, [
    { field: 'class', oldValue: 'GENIE_DJINNI', newValue: 'GENIE_EFREET' },
  ]);
  assert.equal(destination.byFile.get('AATAQAH').class, 'GENIE_DJINNI');
  assert.equal(changedRows[0].updatedRow.class, 'GENIE_EFREET');
  // origin is immutable — the modifying mod does not take it over
  assert.equal(changedRows[0].updatedRow.origin, 'base');
});

test('diffCreatures keeps the original origin on a changed creature — never the modifying mod', () => {
  const destination = parseDestination(
    'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;bg1;Aataqah\r\n'
  );
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.equal(changedRows.length, 1);
  assert.equal(changedRows[0].updatedRow.origin, 'bg1');
});

test('diffCreatures leaves a blank origin blank on a changed creature — it is never filled in by the modifying mod', () => {
  const destination = parseDestination(
    'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;;Aataqah\r\n'
  );
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.equal(changedRows[0].updatedRow.origin, '');
});

test('diffCreatures ignores a name-only difference — name is not a compared field', () => {
  const destination = parseDestination(
    'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah\r\n'
  );
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Renamed Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { newRows, changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.deepEqual(newRows, []);
  assert.deepEqual(changedRows, []);
});

test('diffCreatures ignores a row that matches destination exactly', () => {
  const csv = 'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah\r\n';
  const destination = parseDestination(csv);
  const { rows: inputRows } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n',
    'cdtweaks.csv'
  );
  const { newRows, changedRows } = diffCreatures(inputRows, destination, 'cdtweaks');
  assert.deepEqual(newRows, []);
  assert.deepEqual(changedRows, []);
});

test('formatDestinationCsv writes the header, existing rows, then new rows, CRLF-joined, name last unquoted', () => {
  const existingRows = [{
    file: 'AATAQAH', general: 'GIANTHUMANOID', race: 'GENIE',
    class: 'GENIE_DJINNI', anim: 'DJINNI', deathvar: 'aataqah', dialog: 'aataqah', origin: 'base', name: 'Aataqah',
  }];
  const newRows = [{
    file: 'BERTRAND', general: 'HUMANOID', race: 'HUMAN',
    class: 'FIGHTER', anim: 'MHM1', deathvar: 'bertrand', dialog: 'bertrand', origin: 'cdtweaks', name: 'Bertrand the "Companion"',
  }];
  const columns = ['file', 'general', 'race', 'class', 'anim', 'deathvar', 'dialog', 'origin', 'name'];
  const text = formatDestinationCsv(existingRows, newRows, columns);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'file;general;race;class;anim;deathvar;dialog;origin;name');
  assert.equal(lines[1], 'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah');
  assert.equal(lines[2], 'BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;cdtweaks;Bertrand the "Companion"');
  assert.equal(lines[3], '');
});

test('formatChangeLog opens with a count line and a NEW section of `resref  name` lines', () => {
  const newRows = [
    { file: 'ACGNOLL1', name: 'Gnoll Chieftain' },
    { file: 'ACGNOLL2', name: 'Gnoll Bodyguard' },
  ];
  const text = formatChangeLog('ac_quest', newRows, []);
  assert.equal(text,
    'ac_quest: 2 new, 0 changed\r\n' +
    '\r\nNEW (2):\r\n' +
    '  ACGNOLL1  Gnoll Chieftain\r\n' +
    '  ACGNOLL2  Gnoll Bodyguard\r\n');
});

test('formatChangeLog omits the name when a creature has none, keeping the resref alone', () => {
  const text = formatChangeLog('ac_quest', [{ file: 'ACQ10101', name: '' }], []);
  assert.equal(text, 'ac_quest: 1 new, 0 changed\r\n\r\nNEW (1):\r\n  ACQ10101\r\n');
});

test('formatChangeLog renders a CHANGED section with the name and the field-level old -> new diff', () => {
  const changedRows = [{
    file: 'AATAQAH',
    updatedRow: { name: 'Aataqah' },
    changes: [{ field: 'class', oldValue: 'GENIE_DJINNI', newValue: 'GENIE_EFREET' }],
  }];
  const text = formatChangeLog('cdtweaks', [], changedRows);
  assert.equal(text,
    'cdtweaks: 0 new, 1 changed\r\n' +
    '\r\nCHANGED (1):\r\n' +
    '  AATAQAH   Aataqah\r\n' +
    '    class: GENIE_DJINNI -> GENIE_EFREET\r\n');
});

test('formatChangeLog includes both NEW and CHANGED sections when both are present', () => {
  const text = formatChangeLog(
    'bg1ub',
    [{ file: 'NEWCRE01', name: 'New Guy' }],
    [
      { file: 'AATAQAH', updatedRow: { name: 'Aataqah' }, changes: [{ field: 'class', oldValue: 'A', newValue: 'B' }] },
      { file: 'ABAZIGAL', updatedRow: { name: 'Abazigal' }, changes: [{ field: 'anim', oldValue: 'X', newValue: 'Y' }] },
    ]
  );
  assert.equal(text,
    'bg1ub: 1 new, 2 changed\r\n' +
    '\r\nNEW (1):\r\n' +
    '  NEWCRE01  New Guy\r\n' +
    '\r\nCHANGED (2):\r\n' +
    '  AATAQAH   Aataqah\r\n' +
    '    class: A -> B\r\n' +
    '  ABAZIGAL  Abazigal\r\n' +
    '    anim: X -> Y\r\n');
});

test('parseInput takes the first non-empty line as the header (extract prefixes a blank line)', () => {
  const text = '\r\n' +
    'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n';
  const { rows, warnings, columns } = parseInput(text, 'source.csv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'AATAQAH');
  assert.deepEqual(warnings, []);
  assert.equal(columns[0], 'file');
  assert.equal(columns[columns.length - 1], 'name');
});

test('parseInput derives an arbitrary wide column set from the header', () => {
  const text = WIDE_HEADER + '\r\n' +
    'A;HUMANOID;ELF;SORCERER;MAGE_MALE_ELF;BAELOTH;BAELOTH;6;MALE;MALE;NEUTRAL;' +
    'BAELOTH;;;;;;;;BARING;;STAF02;DART11;;;0;Baeloth\r\n';
  const { rows, warnings, columns } = parseInput(text, 'source.csv');
  assert.deepEqual(warnings, []);
  assert.equal(columns.length, 27);
  assert.equal(rows[0].level, '6');
  assert.equal(rows[0].allegiance, 'NEUTRAL');
  assert.equal(rows[0].weapon1, 'STAF02');
  assert.equal(rows[0].xpv, '0');
  assert.equal(rows[0].name, 'Baeloth');
});

test('parseInput normalizes an <Invalid Strref -1> name to an empty string', () => {
  const text = 'file;general;race;class;anim;deathvar;dialog;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;<Invalid Strref -1>\r\n';
  const { rows, warnings } = parseInput(text, 'source.csv');
  assert.equal(rows[0].name, '');
  assert.deepEqual(warnings, []);
});

test('deriveDestinationColumns inserts origin just before the trailing name column', () => {
  assert.deepEqual(
    deriveDestinationColumns(['file', 'general', 'name']),
    ['file', 'general', 'origin', 'name']
  );
});

test('computeCompareFields is every input column except key and name, when bootstrapping', () => {
  assert.deepEqual(
    computeCompareFields(['file', 'general', 'race', 'name'], []),
    ['general', 'race']
  );
});

test('computeCompareFields excludes input columns absent from an existing destination', () => {
  const inputColumns = ['file', 'general', 'xpv', 'name'];
  const destColumns = ['file', 'general', 'origin', 'name'];
  assert.deepEqual(computeCompareFields(inputColumns, destColumns), ['general']);
});

test('diffCreatures flags a change in a newly added column when both sides carry it', () => {
  const destination = parseDestination(
    'file;general;xpv;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;1400;base;Aataqah\r\n'
  );
  const { rows: inputRows, columns } = parseInput(
    'file;general;xpv;name\r\n' +
    'AATAQAH;GIANTHUMANOID;3000;Aataqah\r\n',
    'scs.csv'
  );
  const { newRows, changedRows } = diffCreatures(inputRows, destination, 'stratagems', {
    keyField: 'file',
    compareFields: computeCompareFields(columns, destination.columns),
  });
  assert.deepEqual(newRows, []);
  assert.deepEqual(changedRows[0].changes, [
    { field: 'xpv', oldValue: '1400', newValue: '3000' },
  ]);
  assert.equal(changedRows[0].updatedRow.origin, 'base');
});

test('migrateDestination realigns rows to a wider layout, backfilling from the extraction, no change flagged', () => {
  const destination = parseDestination(
    'file;general;race;class;anim;deathvar;dialog;origin;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah\r\n'
  );
  const { rows: inputRows, columns: inputColumns } = parseInput(
    'file;general;race;class;anim;deathvar;dialog;xpv;name\r\n' +
    'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;1400;Aataqah\r\n',
    'source.csv'
  );
  const originalDestColumns = destination.columns;
  const wanted = deriveDestinationColumns(inputColumns);
  const migrated = migrateDestination(destination, wanted, inputRows, 'file');
  assert.equal(migrated, true);
  assert.deepEqual(destination.columns, wanted);
  assert.equal(destination.byFile.get('AATAQAH').xpv, '1400');

  const { changedRows } = diffCreatures(inputRows, destination, 'stratagems', {
    keyField: 'file',
    compareFields: computeCompareFields(inputColumns, originalDestColumns),
  });
  assert.deepEqual(changedRows, []);
});

test('migrateDestination is a no-op when the layout already matches', () => {
  const destination = parseDestination(
    'file;general;origin;name\r\n' +
    'AAA;G;base;A\r\n'
  );
  const migrated = migrateDestination(destination, ['file', 'general', 'origin', 'name'], [], 'file');
  assert.equal(migrated, false);
});

test('formatDestinationCsv emits empty strings for columns missing on a row', () => {
  const columns = ['file', 'general', 'xpv', 'origin', 'name'];
  const text = formatDestinationCsv([{ file: 'AAA', general: 'G', origin: 'base', name: 'A' }], [], columns);
  assert.equal(text.split('\r\n')[1], 'AAA;G;;base;A');
});

test('mergeExtraction bootstraps an empty destination, inserting the origin column', () => {
  const result = mergeExtraction({
    destinationText: '',
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n',
    origin: 'base',
  });
  assert.equal(result.bootstrapping, true);
  assert.equal(result.destinationChanged, true);
  assert.equal(result.newRows.length, 1);
  assert.deepEqual(result.changedRows, []);
  assert.equal(result.nameField, 'name');
  assert.equal(result.destinationText.split('\r\n')[0], 'file;general;race;class;anim;deathvar;dialog;origin;name');
  assert.match(result.destinationText, /AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;base;Aataqah\r\n/);
});

test('mergeExtraction folds a second extraction in, tagging only the genuinely new creature', () => {
  const first = mergeExtraction({
    destinationText: '',
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n',
    origin: 'bg1',
  });
  const second = mergeExtraction({
    destinationText: first.destinationText,
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n' +
      'BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;Bertrand\r\n',
    origin: 'bg1ub',
  });
  assert.equal(second.bootstrapping, false);
  assert.equal(second.newRows.length, 1);
  assert.equal(second.newRows[0].file, 'BERTRAND');
  assert.match(second.destinationText, /BERTRAND;HUMANOID;HUMAN;FIGHTER;MHM1;bertrand;bertrand;bg1ub;Bertrand\r\n/);
});

test('mergeExtraction applies a field change but keeps the original origin, and reports it unchanged text on a clean re-run', () => {
  const base = mergeExtraction({
    destinationText: '',
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;Aataqah\r\n',
    origin: 'bg1',
  });
  const changed = mergeExtraction({
    destinationText: base.destinationText,
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;Aataqah\r\n',
    origin: 'cdtweaks',
  });
  assert.equal(changed.changedRows.length, 1);
  assert.match(changed.destinationText, /GENIE_EFREET;DJINNI;aataqah;aataqah;bg1;Aataqah\r\n/);

  const rerun = mergeExtraction({
    destinationText: changed.destinationText,
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;Aataqah\r\n',
    origin: 'cdtweaks',
  });
  assert.equal(rerun.destinationChanged, false);
  assert.equal(rerun.destinationText, changed.destinationText);
});

test('mergeExtraction surfaces parse warnings tagged with the given sourceLabel', () => {
  const result = mergeExtraction({
    destinationText: 'file;general;race;class;anim;deathvar;dialog;origin;name\r\n',
    inputText:
      'file;general;race;class;anim;deathvar;dialog;name\r\n' +
      'BADROW;ONLYTWO\r\n',
    origin: 'x',
    sourceLabel: '017_bg1npc.csv',
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^017_bg1npc\.csv:2:/);
});

test('mergeExtraction throws when the input has no usable header', () => {
  assert.throws(
    () => mergeExtraction({ destinationText: '', inputText: 'file\r\n', origin: 'x', sourceLabel: 'bad.csv' }),
    /no usable header: bad\.csv/,
  );
});

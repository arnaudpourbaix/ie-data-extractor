const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, collectSnapshots, run } = require('./rebuild-creatures');

const HEADER = 'file;general;race;class;anim;deathvar;dialog;name';
const cre = (f, over = {}) => {
  const base = {
    general: 'GIANTHUMANOID', race: 'GENIE', class: 'GENIE_DJINNI', anim: 'DJINNI',
    deathvar: f.toLowerCase(), dialog: f.toLowerCase(), name: f,
  };
  const r = { ...base, ...over };
  return `${f};${r.general};${r.race};${r.class};${r.anim};${r.deathvar};${r.dialog};${r.name}`;
};
const snapshot = (...lines) => [HEADER, ...lines, ''].join('\r\n');

function makeCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-creatures-'));
  const csvDir = path.join(dir, 'extract', 'csv');
  const historyDir = path.join(csvDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const destinationPath = path.join(csvDir, 'creatures.csv');
  const writeSnap = (name, text) => fs.writeFileSync(path.join(historyDir, name), text);
  return { dir, csvDir, historyDir, destinationPath, writeSnap };
}

test('parseArgs defaults destination and leaves history unset', () => {
  const a = parseArgs([]);
  assert.equal(a.destination, path.join('extract', 'csv', 'creatures.csv'));
  assert.equal(a.history, null);
  assert.equal(a.dryRun, false);
});

test('parseArgs honors --destination, --history, --dry-run and --keep-orphans', () => {
  const a = parseArgs(['--destination', 'c.csv', '--history', 'h', '--dry-run', '--keep-orphans']);
  assert.equal(a.destination, 'c.csv');
  assert.equal(a.history, 'h');
  assert.equal(a.dryRun, true);
  assert.equal(a.keepOrphans, true);
});

test('collectSnapshots returns NNN_<origin>.csv files oldest first, ignoring logs and folders', () => {
  const { historyDir, writeSnap } = makeCase();
  writeSnap('010_gorgon.csv', snapshot(cre('G1')));
  writeSnap('002_bg1ub.csv', snapshot(cre('B1')));
  writeSnap('001_bg1.csv', snapshot(cre('A1')));
  writeSnap('003_C#ENDLESSBG1.csv', snapshot(cre('C1')));
  writeSnap('002_bg1ub_changes.log', 'noise');
  fs.mkdirSync(path.join(historyDir, 'backup'));
  fs.writeFileSync(path.join(historyDir, 'backup', '004_later.csv'), snapshot(cre('X1')));

  const got = collectSnapshots(historyDir).map((s) => [s.seq, s.origin]);
  assert.deepEqual(got, [[1, 'bg1'], [2, 'bg1ub'], [3, 'C#ENDLESSBG1'], [10, 'gorgon']]);
});

test('run replays a prefix: first snapshot bootstraps, later ones add with their own origin', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_bg1ub.csv', snapshot(cre('AATAQAH'), cre('BERTRAND', { name: 'Bertrand the "Companion"' })));

  const { summary, warnings, creatureCount } = run({ destinationPath, historyDir });

  assert.deepEqual(warnings, []);
  assert.equal(creatureCount, 2);
  assert.match(summary, /replayed 2 snapshot\(s\) \(001_bg1\.csv \.\. 002_bg1ub\.csv\)/);
  const text = fs.readFileSync(destinationPath, 'utf8');
  assert.equal(text.split('\r\n')[0], 'file;general;race;class;anim;deathvar;dialog;origin;name');
  assert.match(text, /AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;bg1;AATAQAH\r\n/);
  assert.match(text, /BERTRAND;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;bertrand;bertrand;bg1ub;Bertrand the "Companion"\r\n/);
  assert.ok(text.endsWith('\r\n'));
});

test('run writes a fresh change log for a non-bootstrap snapshot that adds creatures', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_ac_quest.csv', snapshot(cre('AATAQAH'), cre('ACGNOLL1', { name: 'Gnoll Chieftain' })));

  const { logsWritten } = run({ destinationPath, historyDir });

  assert.deepEqual(logsWritten, ['002_ac_quest_changes.log']);
  const log = fs.readFileSync(path.join(historyDir, '002_ac_quest_changes.log'), 'utf8');
  assert.equal(log, 'ac_quest: 1 new, 0 changed\r\n\r\nNEW (1):\r\n  ACGNOLL1  Gnoll Chieftain\r\n');
});

test('run applies a field change across snapshots, keeps the original origin, logs the diff', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_cdtweaks.csv', snapshot(cre('AATAQAH', { class: 'GENIE_EFREET' })));

  run({ destinationPath, historyDir });

  const text = fs.readFileSync(destinationPath, 'utf8');
  assert.match(text, /AATAQAH;GIANTHUMANOID;GENIE;GENIE_EFREET;DJINNI;aataqah;aataqah;bg1;AATAQAH\r\n/);
  assert.ok(!text.includes(';cdtweaks;'));
  const log = fs.readFileSync(path.join(historyDir, '002_cdtweaks_changes.log'), 'utf8');
  assert.equal(
    log,
    'cdtweaks: 0 new, 1 changed\r\n\r\nCHANGED (1):\r\n  AATAQAH   AATAQAH\r\n    class: GENIE_DJINNI -> GENIE_EFREET\r\n',
  );
});

test('run deletes a stale change log sitting next to the bootstrap snapshot', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('001_bg1_changes.log', 'stale bootstrap log that should not exist');
  writeSnap('002_ac_quest.csv', snapshot(cre('AATAQAH'), cre('ACGNOLL1')));

  const { logsDeleted } = run({ destinationPath, historyDir });

  assert.deepEqual(logsDeleted, ['001_bg1_changes.log']);
  assert.equal(fs.existsSync(path.join(historyDir, '001_bg1_changes.log')), false);
});

test('run deletes a stale change log for a snapshot that now replays as a no-op', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_noop.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_noop_changes.log', 'stale — this pass changed nothing after the rebuild');

  const { logsDeleted, creatureCount } = run({ destinationPath, historyDir });

  assert.equal(creatureCount, 1);
  assert.deepEqual(logsDeleted, ['002_noop_changes.log']);
  assert.equal(fs.existsSync(path.join(historyDir, '002_noop_changes.log')), false);
});

test('run prunes a creature that a later snapshot no longer contains', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_ac_quest.csv', snapshot(cre('AATAQAH'), cre('OBSERVE', { name: 'Observer' })));
  // by the third install OBSERVE's .cre is gone from override
  writeSnap('003_reflections.csv', snapshot(cre('AATAQAH'), cre('CORWIN')));

  const { creatureCount, pruned, summary } = run({ destinationPath, historyDir });

  assert.equal(creatureCount, 2);
  assert.deepEqual(pruned, ['OBSERVE (Observer)']);
  assert.match(summary, /1 orphan\(s\) pruned/);
  const text = fs.readFileSync(destinationPath, 'utf8');
  assert.ok(!text.includes('OBSERVE'));
  assert.match(text, /AATAQAH;/);
  assert.match(text, /CORWIN;/);
});

test('run --keep-orphans leaves a stale creature in place', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_ac_quest.csv', snapshot(cre('AATAQAH'), cre('OBSERVE')));
  writeSnap('003_reflections.csv', snapshot(cre('AATAQAH')));

  const { creatureCount, pruned, summary } = run({ destinationPath, historyDir, keepOrphans: true });

  assert.equal(creatureCount, 2);
  assert.deepEqual(pruned, []);
  assert.match(summary, /orphan pruning skipped/);
  assert.match(fs.readFileSync(destinationPath, 'utf8'), /OBSERVE;/);
});

test('run warns on a sequence gap but still replays every surviving snapshot', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_bg1ub.csv', snapshot(cre('AATAQAH'), cre('B1')));
  writeSnap('005_ntotsc.csv', snapshot(cre('AATAQAH'), cre('B1'), cre('N1')));

  const { warnings, creatureCount } = run({ destinationPath, historyDir });

  assert.equal(creatureCount, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sequence gap: 005_ntotsc\.csv follows 002_bg1ub\.csv/);
});

test('run prefixes a malformed-row warning with the snapshot filename', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_cdtweaks.csv', [HEADER, cre('AATAQAH'), 'BADROW;ONLYTWO', cre('NEWCRE01'), ''].join('\r\n'));

  const { warnings, creatureCount } = run({ destinationPath, historyDir });

  assert.equal(creatureCount, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^002_cdtweaks\.csv: .*:3:.*expected 8 columns, got 2/);
});

test('run --dry-run writes nothing but reports what would happen', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap('002_ac_quest.csv', snapshot(cre('AATAQAH'), cre('ACGNOLL1')));

  const { summary } = run({ destinationPath, historyDir, dryRun: true });

  assert.match(summary, /^\[dry-run\] replayed 2 snapshot\(s\)/);
  assert.equal(fs.existsSync(destinationPath), false);
  assert.equal(fs.existsSync(path.join(historyDir, '002_ac_quest_changes.log')), false);
});

test('run migrates the roster when a later snapshot adds a column', () => {
  const { historyDir, destinationPath, writeSnap } = makeCase();
  writeSnap('001_bg1.csv', snapshot(cre('AATAQAH')));
  writeSnap(
    '002_stratagems.csv',
    [
      'file;general;race;class;anim;deathvar;dialog;xpv;name',
      'AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;1400;AATAQAH',
      'CORWIN;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;corwin;corwin;900;CORWIN',
      '',
    ].join('\r\n'),
  );

  const { summary } = run({ destinationPath, historyDir });

  assert.match(summary, /2 creature\(s\)/);
  const text = fs.readFileSync(destinationPath, 'utf8');
  assert.equal(
    text.split('\r\n')[0],
    'file;general;race;class;anim;deathvar;dialog;xpv;origin;name',
  );
  assert.match(text, /AATAQAH;GIANTHUMANOID;GENIE;GENIE_DJINNI;DJINNI;aataqah;aataqah;1400;bg1;AATAQAH\r\n/);
});

test('run throws when the history directory has no snapshots', () => {
  const { historyDir, destinationPath } = makeCase();
  assert.throws(() => run({ destinationPath, historyDir }), /no <NNN>_<origin>\.csv snapshots/);
});

test('run throws when the history directory does not exist', () => {
  const { destinationPath } = makeCase();
  assert.throws(
    () => run({ destinationPath, historyDir: path.join(path.dirname(destinationPath), 'nope') }),
    /history directory not found/,
  );
});

test('run throws when the destination directory does not exist', () => {
  const { dir } = makeCase();
  assert.throws(
    () => run({ destinationPath: path.join(dir, 'missing', 'creatures.csv'), historyDir: path.join(dir, 'x') }),
    /destination directory not found/,
  );
});

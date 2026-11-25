import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, ...options });
  assert.ifError(result.error);
  return result;
}

test('real SQLite WAL snapshots survive age encryption and preserve failure semantics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vowmirror-backup-test-'));
  const volume = join(directory, 'volume');
  const snapshots = join(directory, 'tmpfs');
  const backups = join(directory, 'backups');
  const bin = join(directory, 'bin');
  for (const path of [volume, snapshots, backups, bin]) mkdirSync(path);
  const identity = join(directory, 'identity');
  const recipients = join(directory, 'recipients');
  const databasePath = join(volume, 'usage.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    assert.equal(run('age-keygen', ['-o', identity]).status, 0);
    const publicKey = run('age-keygen', ['-y', identity]);
    assert.equal(publicKey.status, 0);
    writeFileSync(recipients, publicKey.stdout);
    // Keep the writer open with autocheckpoint disabled: data is only in the WAL.
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE usage (principal_hash TEXT PRIMARY KEY, successes INTEGER); INSERT INTO usage VALUES ('synthetic-principal', 3)");
    assert.ok(statSync(databasePath + '-wal').size > 0);
    // Only the Docker process boundary is simulated; SQLite, WAL, snapshots and age are real.
    writeFileSync(join(bin, 'docker'), `#!/bin/sh
set -eu
case "$*" in
    'version --format {{.Server.Version}}') exit "\${TEST_DOCKER_EXIT:-0}" ;;
    'compose -f compose.yaml build tools-backup') echo 'synthetic build progress'; exit "\${TEST_BUILD_EXIT:-0}" ;;
    'compose -f compose.yaml run --rm --no-deps -T tools-backup')
        if [ "\${TEST_PRODUCER_FAILURE:-0}" = 1 ]; then printf 'partial snapshot'; exit 1; fi
        exec sh "$TEST_SNAPSHOT_SCRIPT" "$TEST_DATABASE" ;;
    *) echo 'Unexpected Docker invocation' >&2; exit 91 ;;
esac
`, { mode: 0o755 });
    const environment = {
      ...process.env, PATH: bin + ':' + process.env.PATH,
      VOWMIRROR_BACKUP_DIR: backups, VOWMIRROR_BACKUP_RECIPIENTS: recipients,
      TEST_SNAPSHOT_SCRIPT: join(root, 'docker/snapshot-usage.sh'), TEST_DATABASE: databasePath,
      TMPDIR: snapshots,
    };
    const execute = overrides => run('bash', [join(root, 'scripts/backup-usage.sh')], { env: { ...environment, ...overrides } });
    const old = join(backups, 'usage-20000101-000000-old.sqlite.age');
    const unrelated = join(backups, 'unrelated.age');
    const recent = join(backups, 'usage-recent.sqlite.age');
    for (const path of [old, unrelated, recent]) writeFileSync(path, 'synthetic ciphertext');
    for (const path of [old, unrelated]) utimesSync(path, new Date(0), new Date(0));
    const success = execute();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(recent), true);
    const archives = () => readdirSync(backups).filter(name => /^usage-\d{8}-/.test(name));
    assert.equal(archives().length, 1);
    const archive = join(backups, archives()[0]);
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    const restored = join(directory, 'restored.sqlite');
    const decrypted = run('age', ['--decrypt', '-i', identity, '-o', restored, archive]);
    assert.equal(decrypted.status, 0, decrypted.stderr);
    const restoredDB = new DatabaseSync(restored, { readOnly: true });
    assert.equal(restoredDB.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restoredDB.prepare('SELECT successes FROM usage').get().successes, 3);
    restoredDB.close();
    assert.deepEqual(readdirSync(snapshots), [], 'plaintext snapshots removed');
    const absent = execute({ TEST_DATABASE: join(volume, 'absent.sqlite') });
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /not been initialized/);
    assert.notEqual(execute({ TEST_DATABASE: join(directory, 'missing-volume', 'usage.sqlite') }).status, 0);
    writeFileSync(join(volume, 'corrupt.sqlite'), 'broken database');
    assert.notEqual(execute({ TEST_DATABASE: join(volume, 'corrupt.sqlite') }).status, 0);
    assert.notEqual(execute({ TEST_DOCKER_EXIT: '1' }).status, 0);
    assert.notEqual(execute({ TEST_BUILD_EXIT: '1' }).status, 0);
    assert.notEqual(execute({ TEST_PRODUCER_FAILURE: '1' }).status, 0);
    const locked = run('flock', ['-n', join(backups, '.backup.lock'), 'bash', join(root, 'scripts/backup-usage.sh')], { env: environment });
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /Another usage backup is running/);
    const invalidRecipients = join(directory, 'invalid-recipients');
    writeFileSync(invalidRecipients, 'invalid recipient');
    assert.notEqual(execute({ VOWMIRROR_BACKUP_RECIPIENTS: invalidRecipients }).status, 0);
    assert.notEqual(execute({ VOWMIRROR_BACKUP_RECIPIENTS: join(directory, 'missing') }).status, 0);
    assert.equal(archives().length, 1, 'failed or absent backups publish no archive');
    assert.deepEqual(readdirSync(snapshots), [], 'all plaintext failure paths cleaned up');
    assert.deepEqual(readdirSync(backups).filter(name => name.startsWith('.usage-backup.')), []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

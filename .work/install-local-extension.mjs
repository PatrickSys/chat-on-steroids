// One-shot, pinned compatibility overlay. Only run after the app has quit normally.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionStamp } from '../scripts/write-extension-stamp.mjs';

const work = path.dirname(fileURLToPath(import.meta.url));
const rehearsal = process.argv.includes('--rehearse');
if (!rehearsal) {
  const processes = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Chat On Steroids.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 });
  if (process.platform !== 'win32' || processes.status !== 0 || !processes.stdout) throw new Error('Cannot establish safe process state');
  if (processes.stdout.toLowerCase().includes('chat on steroids.exe')) throw new Error('App is running: use normal Quit, never force-kill');
}
const bundled = rehearsal ? path.join(work, 'overlay-rehearsal-extension')
  : path.join(process.env.LOCALAPPDATA, 'Programs', 'Chat On Steroids', 'resources', 'extension');
const stage = path.join(work, 'local-extension-overlay');
const backup = path.join(work, rehearsal ? 'overlay-rehearsal-backup' : 'installed-2.1.44-before-overlay');
const report = path.join(work, rehearsal ? 'overlay-rehearsal-receipt.json' : 'installed-overlay-receipt.json');
const expected = JSON.parse(fs.readFileSync(path.join(work, 'official-extension-2.1.44.json'), 'utf8'));
const overlay = JSON.parse(fs.readFileSync(path.join(stage, 'overlay.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = ['content.js', 'background.js', 'build-stamp.txt'];
if (JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8')).version !== '2.1.44') {
  throw new Error('Installed extension is not the pinned 2.1.44 baseline');
}
for (const row of expected) {
  if (hash(fs.readFileSync(path.join(bundled, row.file))) !== row.sha256) throw new Error(`Installed baseline differs: ${row.file}`);
}
if (extensionStamp(bundled) !== fs.readFileSync(path.join(bundled, 'build-stamp.txt'), 'utf8').trim()) throw new Error('Installed baseline full-tree stamp mismatch');
for (const row of overlay.files) {
  if (hash(fs.readFileSync(path.join(stage, row.file))) !== row.sha256) throw new Error(`Reviewed candidate changed: ${row.file}`);
}
if (fs.existsSync(backup) || fs.existsSync(report)) throw new Error('Rollback backup or receipt already exists; inspect rather than overwrite');
fs.mkdirSync(backup);
for (const name of targets) fs.copyFileSync(path.join(bundled, name), path.join(backup, name));
for (const name of targets) {
  if (hash(fs.readFileSync(path.join(backup, name))) !== expected.find(row => row.file === name)?.sha256) throw new Error('Backup verification failed: ' + name);
}
const prepared = { stage: 'prepared', runId: randomUUID(), installedAcceptance: false,
  at: new Date().toISOString(), base: overlay.base_release, bundled: path.resolve(bundled), backup: path.resolve(backup),
  stamp: 'e3180bda44a3', files: overlay.files, official: expected, sourceCommit: overlay.source_commit };
function saveReceipt(value) {
  const temporaryReceipt = report + '.tmp';
  const fd = fs.openSync(temporaryReceipt, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporaryReceipt, report);
}
saveReceipt(prepared);
const temporary = name => path.join(bundled, `.private-recovery-${name}`);
try {
  for (const name of ['content.js', 'background.js']) {
    fs.copyFileSync(path.join(stage, name), temporary(name));
    fs.renameSync(temporary(name), path.join(bundled, name));
  }
  // Use the existing full extension digest; do not pretend this is the official build.
  const stamp = extensionStamp(bundled);
  fs.writeFileSync(temporary('build-stamp.txt'), stamp + '\n');
  fs.renameSync(temporary('build-stamp.txt'), path.join(bundled, 'build-stamp.txt'));
  if (extensionStamp(bundled) !== stamp || stamp !== prepared.stamp) throw new Error('Published extension stamp mismatch');
  for (const row of overlay.files) {
    if (hash(fs.readFileSync(path.join(bundled, row.file))) !== row.sha256) throw new Error(`Published file mismatch: ${row.file}`);
  }
  saveReceipt({ ...prepared, stage: 'bundled-files-published', at: new Date().toISOString() });
} catch (error) {
  const restored = spawnSync(process.execPath, [path.join(work, 'restore-local-extension.mjs'), rehearsal ? '--rehearse' : '--live'], { encoding: 'utf8', timeout: 15000 });
  if (restored.status !== 0) throw new Error('Installation failed; standalone restoration did not verify official bytes. Keep app stopped. ' + restored.stderr, { cause: error });
  throw error;
}

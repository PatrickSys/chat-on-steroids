// Private 2.1.44 compatibility trial: restore official extension bytes after a failed live trial.
// --rehearse restores only .work/rollback-rehearsal/{extension,backup}.
// --live refuses to touch installed files while *any* Chat On Steroids process exists.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extensionStamp } from '../scripts/write-extension-stamp.mjs';

const work = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
if (!['--rehearse', '--live'].includes(mode)) throw new Error('Specify --rehearse or --live explicitly');
const live = mode === '--live';
if (live) {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const processes = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Chat On Steroids.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 });
  if (processes.status !== 0 || !processes.stdout) throw new Error('Cannot establish safe process state');
  if (processes.stdout.toLowerCase().includes('chat on steroids.exe')) throw new Error('App is running: use normal Quit, never force-kill');
}
const pathRoot = live ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Chat On Steroids', 'resources', 'extension')
  : path.join(work, 'overlay-rehearsal-extension');
const backup = path.join(work, live ? 'installed-2.1.44-before-overlay' : 'overlay-rehearsal-backup');
const receipt = path.join(work, live ? 'installed-restore-receipt.json' : 'overlay-rehearsal-restore-receipt.json');
const installReceipt = path.join(work, live ? 'installed-overlay-receipt.json' : 'overlay-rehearsal-receipt.json');
const official = JSON.parse(fs.readFileSync(path.join(work, 'official-extension-2.1.44.json'), 'utf8'));
const candidate = JSON.parse(fs.readFileSync(path.join(work, 'local-extension-overlay', 'overlay.json'), 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const officialByName = new Map(official.map(x => [x.file, x]));
const candidateByName = new Map(candidate.files.map(x => [x.file, x]));
const names = ['content.js', 'background.js', 'build-stamp.txt'];
if (process.argv.includes('--verify-only')) {
  for (const row of official) {
    if (sha(path.join(pathRoot, row.file)) !== row.sha256) throw new Error('Official verification failed: ' + row.file);
  }
  if (extensionStamp(pathRoot) !== fs.readFileSync(path.join(pathRoot, 'build-stamp.txt'), 'utf8').trim()) throw new Error('Official full-tree stamp mismatch');
  console.log('OFFICIAL_2.1.44_BYTES_VERIFIED');
  process.exit(0);
}
{
  if (!fs.existsSync(installReceipt)) throw new Error('No real installed-overlay receipt; refuse unrelated repair');
  const installed = JSON.parse(fs.readFileSync(installReceipt, 'utf8'));
  if (!['prepared', 'bundled-files-published'].includes(installed.stage) || !/^[0-9a-f-]{36}$/.test(installed.runId ?? '') ||
      installed.base !== '2.1.44' || installed.stamp !== 'e3180bda44a3' || installed.sourceCommit !== candidate.source_commit ||
      JSON.stringify(installed.files) !== JSON.stringify(candidate.files) || JSON.stringify(installed.official) !== JSON.stringify(official) ||
      path.resolve(installed.bundled) !== path.resolve(pathRoot) || path.resolve(installed.backup) !== path.resolve(backup)) {
    throw new Error('Installation receipt does not identify the exact expected installation');
  }
}
if (fs.existsSync(receipt)) {
  for (const row of official) if (sha(path.join(pathRoot, row.file)) !== row.sha256) throw new Error('Restored files changed; refuse replay');
  if (extensionStamp(pathRoot) !== fs.readFileSync(path.join(pathRoot, 'build-stamp.txt'), 'utf8').trim()) throw new Error('Restored full-tree stamp mismatch');
  console.log('OFFICIAL_2.1.44_ALREADY_RESTORED_AND_VERIFIED');
  process.exit(0);
}
if (JSON.parse(fs.readFileSync(path.join(pathRoot, 'manifest.json'), 'utf8')).version !== '2.1.44') throw new Error('Bundled extension has changed versions');
for (const name of [...names, 'manifest.json']) {
  if (name === 'manifest.json') {
    if (sha(path.join(pathRoot, name)) !== officialByName.get(name).sha256) throw new Error('Installed manifest differs from pinned 2.1.44');
    continue;
  }
  const prior = path.join(backup, name);
  const bundled = path.join(pathRoot, name);
  if (sha(prior) !== officialByName.get(name).sha256) throw new Error('Backup not pristine: ' + name);
  const current = sha(bundled);
  const expected = officialByName.get(name).sha256;
  if (current !== expected && (name === 'build-stamp.txt' || current !== candidateByName.get(name)?.sha256)) {
    // Stamp differs only because of this candidate and is verified below.
    if (name !== 'build-stamp.txt') throw new Error('Foreign version in installed extension: ' + name);
    const stamp = fs.readFileSync(bundled, 'utf8').trim();
    if (stamp !== 'e3180bda44a3') throw new Error('Foreign build stamp: refuse restoration');
  }
}
for (const name of names) {
  const intermediate = path.join(pathRoot, `.private-recovery-${name}`);
  if (!fs.existsSync(intermediate)) continue;
  const digest = sha(intermediate);
  const officialHash = officialByName.get(name).sha256;
  const candidateHash = name === 'build-stamp.txt'
    ? createHash('sha256').update('e3180bda44a3\n').digest('hex') : candidateByName.get(name)?.sha256;
  if (digest !== officialHash && digest !== candidateHash) throw new Error('Foreign install intermediate: ' + name);
}
// Stage every official file before publishing any of them. An interrupted pass is recoverable.
for (const name of names) {
  const intermediate = path.join(pathRoot, `.private-restore-${name}`);
  if (!fs.existsSync(intermediate)) fs.copyFileSync(path.join(backup, name), intermediate);
  if (sha(intermediate) !== officialByName.get(name).sha256) throw new Error('Restore intermediate is not official: ' + name);
}
for (const name of names) {
  fs.renameSync(path.join(pathRoot, `.private-restore-${name}`), path.join(pathRoot, name));
}
for (const name of names) {
  const intermediate = path.join(pathRoot, `.private-recovery-${name}`);
  if (fs.existsSync(intermediate)) fs.unlinkSync(intermediate);
}
for (const name of [...names, 'manifest.json']) {
  if (sha(path.join(pathRoot, name)) !== officialByName.get(name).sha256) throw new Error('Restoration verification failed: ' + name);
}
if (extensionStamp(pathRoot) !== fs.readFileSync(path.join(pathRoot, 'build-stamp.txt'), 'utf8').trim()) throw new Error('Restored full-tree stamp mismatch');
fs.writeFileSync(receipt, JSON.stringify({ stage: 'official-bytes-restored', at: new Date().toISOString(), mode, pathRoot, backup, files: names }, null, 2));
console.log(JSON.stringify({ result: 'OFFICIAL_2.1.44_RESTORED_AND_VERIFIED', mode, files: names }));

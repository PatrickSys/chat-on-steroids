import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const work = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(work, 'rollback-rehearsal', 'gap-cases-' + Date.now());
fs.mkdirSync(root, { recursive: true });
const bundle = path.join(process.env.LOCALAPPDATA, 'Programs', 'Chat On Steroids', 'resources', 'extension');
const official = JSON.parse(fs.readFileSync(path.join(work, 'official-extension-2.1.44.json')));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cases = [];
function fixture(name) {
  const base = path.join(root, name);
  const local = path.join(base, '.work');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(path.join(base, 'scripts'));
  fs.copyFileSync(path.join(work, '..', 'scripts', 'write-extension-stamp.mjs'), path.join(base, 'scripts', 'write-extension-stamp.mjs'));
  for (const file of ['install-local-extension.mjs', 'restore-local-extension.mjs', 'official-extension-2.1.44.json']) fs.copyFileSync(path.join(work, file), path.join(local, file));
  fs.cpSync(path.join(work, 'local-extension-overlay'), path.join(local, 'local-extension-overlay'), { recursive: true });
  fs.cpSync(bundle, path.join(local, 'overlay-rehearsal-extension'), { recursive: true });
  return local;
}
function run(local, file, ...args) {
  return spawnSync(process.execPath, [path.join(local, file), '--rehearse', ...args], { encoding: 'utf8', timeout: 20000 });
}
function verify(local) {
  for (const row of official) assert.equal(hash(path.join(local, 'overlay-rehearsal-extension', row.file)), row.sha256, row.file);
  assert.equal(run(local, 'restore-local-extension.mjs', '--verify-only').status, 0);
}
function crashInstall(local) {
  const file = path.join(local, 'install-local-extension.mjs');
  const text = fs.readFileSync(file, 'utf8');
  const anchor = 'fs.renameSync(temporary(name), path.join(bundled, name));';
  assert.equal(text.split(anchor).length, 2);
  fs.writeFileSync(file, text.replace(anchor, anchor + '\n    process.exit(86); // disposable crash after first published replacement'));
  assert.equal(run(local, 'install-local-extension.mjs').status, 86);
  assert.equal(JSON.parse(fs.readFileSync(path.join(local, 'overlay-rehearsal-receipt.json'))).stage, 'prepared');
  assert.notEqual(hash(path.join(local, 'overlay-rehearsal-extension', 'content.js')), official[0].sha256);
}
{
  const local = fixture('normal');
  assert.equal(run(local, 'install-local-extension.mjs').status, 0);
  const published = JSON.parse(fs.readFileSync(path.join(local, 'overlay-rehearsal-receipt.json')));
  assert.equal(published.stage, 'bundled-files-published');
  assert.equal(fs.readFileSync(path.join(local, 'overlay-rehearsal-extension', 'build-stamp.txt'), 'utf8').trim(), published.stamp);
  for (const row of published.files) assert.equal(hash(path.join(local, 'overlay-rehearsal-extension', row.file)), row.sha256);
  assert.equal(run(local, 'restore-local-extension.mjs').status, 0);
  verify(local);
  cases.push('normal publication and standalone restoration');
}
{
  const local = fixture('crashed-install'); crashInstall(local);
  assert.equal(run(local, 'restore-local-extension.mjs').status, 0);
  verify(local);
  cases.push('crash after first replacement recovers from prepared receipt');
}
{
  const local = fixture('corrupt-backup'); crashInstall(local);
  const target = path.join(local, 'overlay-rehearsal-extension');
  const before = official.map(row => hash(path.join(target, row.file)));
  fs.appendFileSync(path.join(local, 'overlay-rehearsal-backup', 'background.js'), 'corrupt');
  assert.notEqual(run(local, 'restore-local-extension.mjs').status, 0);
  assert.deepEqual(official.map(row => hash(path.join(target, row.file))), before);
  assert.notEqual(run(local, 'restore-local-extension.mjs', '--verify-only').status, 0);
  cases.push('corrupt backup refused without changing targets; official verification refuses restart');
}
{
  const local = fixture('crashed-restore'); crashInstall(local);
  const file = path.join(local, 'restore-local-extension.mjs');
  const original = fs.readFileSync(file, 'utf8');
  const anchor = "fs.renameSync(path.join(pathRoot, `.private-restore-${name}`), path.join(pathRoot, name));";
  assert.equal(original.split(anchor).length, 2);
  fs.writeFileSync(file, original.replace(anchor, anchor + '\n  process.exit(87);'));
  assert.equal(run(local, 'restore-local-extension.mjs').status, 87);
  fs.writeFileSync(file, original);
  assert.equal(run(local, 'restore-local-extension.mjs').status, 0);
  verify(local);
  cases.push('interrupted restoration resumes from verified staged files');
}
fs.writeFileSync(path.join(work, 'rollback-gap-test-receipt.json'), JSON.stringify({ at: new Date().toISOString(), root, cases }, null, 2));
console.log(JSON.stringify({ result: 'PASS', cases }, null, 2));

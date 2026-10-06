import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sourceViolation } from './source-policy.mjs';

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const mode = process.argv[2] ?? '--staged';
const violations = [];
const seen = new Set();
function check(path, data, context) {
  const reason = sourceViolation(path, data);
  if (reason) violations.push(`${context}: ${path}: ${reason}`);
}
if (mode === '--files') {
  for (const path of process.argv.slice(3)) check(path, readFileSync(path), 'file');
} else if (mode === '--staged') {
  for (const path of git('ls-files', '-z').toString().split('\0').filter(Boolean)) check(path, git('show', `:${path}`), 'index');
} else if (mode === '--history') {
  // Check every reachable snapshot: deleting a firmware file in a later commit is insufficient.
  for (const revision of git('rev-list', '--all').toString().trim().split('\n').filter(Boolean)) {
    const entries = git('ls-tree', '-rz', revision).toString().split('\0').filter(Boolean);
    for (const entry of entries) {
      const [meta, path] = entry.split('\t');
      const [mode, type, oid] = meta.split(' ');
      if (type !== 'blob' || mode === '120000') { violations.push(`${revision}: ${path}: submodules and symlinks are forbidden`); continue; }
      const key = `${oid}:${path}`;
      if (!seen.has(key)) { seen.add(key); check(path, git('cat-file', 'blob', oid), revision.slice(0, 8)); }
    }
  }
} else throw new Error('Use --staged, --history or --files <paths>.');
if (violations.length) {
  console.error('Commit/push blocked: firmware images and backups must never enter Git.\n' + violations.join('\n'));
  process.exitCode = 1;
} else console.log('Source policy passed. No firmware artifacts found.');

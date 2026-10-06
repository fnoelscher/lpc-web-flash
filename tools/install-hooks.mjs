import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

try { execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }); }
catch { console.log('No Git repository yet. Run npm run hooks after git init.'); process.exit(0); }
for (const path of ['.githooks/pre-commit', '.githooks/pre-push']) chmodSync(path, 0o755);
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
console.log('Firmware checks installed for commits and pushes.');

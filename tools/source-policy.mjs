import { extname, basename } from 'node:path';

const rootFiles = new Set(['README.md', 'LICENSE', '.gitignore', '.nvmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts']);
const sourceExtensions = new Set(['.ts', '.css', '.html', '.md', '.mjs', '.py', '.s', '.yml', '.yaml', '.json']);
const artifacts = /(^|\/)(firmware|backups?|captures?|outputs|dist|node_modules|generated|test-results|playwright-report)(\/|$)/i;

export function sourceViolation(path, data) {
  if (artifacts.test(path)) return 'generated files, firmware and device captures are forbidden';
  if (path === 'index.html') { /* Application entry point. */ }
  else if (path.startsWith('.githooks/') && ['pre-commit', 'pre-push'].includes(basename(path))) { /* Git hooks. */ }
  else if (rootFiles.has(path)) { /* Project configuration. */ }
  else if (!/^(src|tests|tools|docs|\.github)\//.test(path) || !sourceExtensions.has(extname(path).toLowerCase())) return 'only reviewed source files are allowed';
  if (data.length > 1024 * 1024) return 'source file exceeds the 1 MiB limit';
  if (data.includes(0) || !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) return 'binary content is forbidden, regardless of filename';
  if (/^:[0-9a-f]{10,}\s*$/im.test(data.toString('utf8'))) return 'Intel HEX firmware records are forbidden, regardless of filename';
  if (/^S[0-9][0-9a-f]{8,}\s*$/im.test(data.toString('utf8'))) return 'S-record firmware is forbidden, regardless of filename';
}

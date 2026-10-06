import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceViolation } from './source-policy.mjs';

test('firmware guard rejects images, captures, disguised binary and HEX records', () => {
  for (const path of ['firmware.bin', 'src/image.BIN', 'tests/data.hex', 'docs/board.elf', 'backups/board.md', 'src/generated/flash-map.ts', 'outputs/diagnostics.txt', 'src/a.zip']) assert.ok(sourceViolation(path, Buffer.from('data')), path);
  assert.ok(sourceViolation('src/hidden.ts', Buffer.from([1, 2, 0, 3])));
  assert.ok(sourceViolation('docs/capture.md', Buffer.from(':00000001FF\n')));
  assert.ok(sourceViolation('docs/capture.md', Buffer.from('S9030000FC\n')));
  assert.ok(sourceViolation('src/big.ts', Buffer.alloc(1024 * 1024 + 1, 65)));
});
test('firmware guard accepts project source, helper assembly and configuration', () => {
  for (const path of ['src/main.ts', 'tools/flash-map.S', '.github/workflows/pages.yml', '.githooks/pre-commit', 'README.md', 'LICENSE', 'package-lock.json', 'index.html']) assert.equal(sourceViolation(path, Buffer.from('ordinary source text')), undefined, path);
});

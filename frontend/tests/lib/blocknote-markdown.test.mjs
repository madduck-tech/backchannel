// blocksToMarkdownSafely wraps BlockNote's lossy markdown export so a
// conversion failure degrades to the previous markdown instead of throwing
// into the save path. Ported from bun:test to node:test: the module is loaded
// through the same transpile + vm technique as transcribe-sort.test.mjs, and
// the vm context carries a test-owned `console`, because the module logs the
// failure through the context's global and the assertion must see that call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadModule(consoleObject) {
  const source = fs.readFileSync(path.join(root, 'src', 'lib', 'blocknote-markdown.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    // The only import is `import type { Block }`, which transpilation erases.
    require: () => ({}),
    console: consoleObject,
  });
  return module.exports;
}

describe('blocksToMarkdownSafely', () => {
  test('returns markdown when conversion succeeds', async () => {
    const consoleError = mock.fn(() => {});
    const { blocksToMarkdownSafely } = loadModule({ error: consoleError });
    const editor = { blocksToMarkdownLossy: mock.fn(async () => '# Summary') };

    const result = await blocksToMarkdownSafely(editor, [], { source: 'test-success' });

    // Spread first: the result object comes from the vm realm, and strict
    // deepEqual compares prototypes.
    assert.deepEqual({ ...result }, { markdown: '# Summary', ok: true });
    assert.equal(editor.blocksToMarkdownLossy.mock.callCount(), 1);
    assert.equal(consoleError.mock.callCount(), 0);
  });

  test('returns fallback markdown when conversion throws', async () => {
    const consoleError = mock.fn(() => {});
    const { blocksToMarkdownSafely } = loadModule({ error: consoleError });
    const error = new Error('conversion failed');
    const editor = {
      blocksToMarkdownLossy: mock.fn(async () => {
        throw error;
      }),
    };

    const result = await blocksToMarkdownSafely(editor, [{ id: 'block-1' }], {
      source: 'test-fallback',
      fallbackMarkdown: 'existing markdown',
    });

    assert.deepEqual({ ...result }, { markdown: 'existing markdown', ok: false });
    assert.equal(consoleError.mock.callCount(), 1);
    const [message, details] = consoleError.mock.calls[0].arguments;
    assert.equal(message, 'Failed to convert BlockNote blocks to markdown');
    assert.equal(details.source, 'test-fallback');
    assert.equal(details.blocksCount, 1);
    assert.equal(details.error, error);
  });

  test('omits markdown when conversion throws without fallback', async () => {
    const consoleError = mock.fn(() => {});
    const { blocksToMarkdownSafely } = loadModule({ error: consoleError });
    const editor = {
      blocksToMarkdownLossy: mock.fn(async () => {
        throw new Error('conversion failed');
      }),
    };

    const result = await blocksToMarkdownSafely(editor, [], { source: 'test-empty-fallback' });

    assert.deepEqual({ ...result }, { markdown: undefined, ok: false });
    assert.equal(consoleError.mock.callCount(), 1);
  });
});

// A meeting without a folder cannot store its summary language in metadata,
// so the preference falls back to localStorage. Ported from bun:test to
// node:test: the module is loaded through the transpile + vm technique used by
// the sibling tests. `@tauri-apps/api/core` is stubbed with a mock `invoke`;
// `@/lib/summary-languages` is the real module, loaded through the same
// loader, so `normaliseLanguageCode` is exercised rather than faked. The module
// gates every localStorage access on `typeof window`, and inside the vm that is
// the context's global, so the context object is kept and `window` is swapped
// on it per test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function transpile(file) {
  const source = fs.readFileSync(path.join(root, 'src', 'lib', file), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

// The sandbox object is the module's global: it must be the same object the
// tests later mutate, not a copy, or a swapped `window` would never be seen.
function loadInContext(file, sandbox) {
  const module = { exports: {} };
  sandbox.exports = module.exports;
  sandbox.module = module;
  vm.runInNewContext(transpile(file), sandbox);
  return module.exports;
}

const invokeMock = mock.fn(async () => null);

// One shared context: its `window` is what the module sees as the global.
const context = {
  window: undefined,
  console,
  require: (id) => {
    if (id === '@tauri-apps/api/core') return { invoke: invokeMock };
    if (id === '@/lib/summary-languages') return summaryLanguages;
    throw new Error(`unexpected import in summary-language-preferences.ts: ${id}`);
  },
};
const summaryLanguages = loadInContext('summary-languages.ts', context);
const prefs = loadInContext('summary-language-preferences.ts', context);

function installLocalStorage() {
  const values = new Map();
  context.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
  };
  return values;
}

function installFailingLocalStorage() {
  context.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
      clear: () => {},
    },
  };
}

const folderless = { language: null, storage: 'local_fallback' };

describe('summary language local fallback', () => {
  let storageValues;

  beforeEach(() => {
    invokeMock.mock.resetCalls();
    invokeMock.mock.mockImplementation(async () => null);
    storageValues = installLocalStorage();
  });

  test('reads summary language from local fallback when meeting has no folder', async () => {
    storageValues.set('summaryLanguageFallback:meeting-1', 'fr');
    invokeMock.mock.mockImplementationOnce(async () => folderless);

    // Spread first: results come from the vm realm, and strict deepEqual
    // compares prototypes.
    assert.deepEqual({ ...(await prefs.readMeetingSummaryLanguage('meeting-1')) }, {
      language: 'fr',
      storage: 'local_fallback',
    });
  });

  test('saves summary language locally when command reports no folder', async () => {
    invokeMock.mock.mockImplementationOnce(async () => folderless);

    assert.deepEqual({ ...(await prefs.saveMeetingSummaryLanguage('meeting-1', 'es')) }, {
      language: 'es',
      storage: 'local_fallback',
    });
    assert.equal(storageValues.get('summaryLanguageFallback:meeting-1'), 'es');
  });

  test('clears local fallback when Auto is saved for a folderless meeting', async () => {
    storageValues.set('summaryLanguageFallback:meeting-1', 'de');
    invokeMock.mock.mockImplementationOnce(async () => folderless);

    assert.deepEqual({ ...(await prefs.saveMeetingSummaryLanguage('meeting-1', null)) }, {
      language: null,
      storage: 'local_fallback',
    });
    assert.equal(storageValues.has('summaryLanguageFallback:meeting-1'), false);
  });

  test('caches detected language locally when meeting has no folder', async () => {
    invokeMock.mock.mockImplementationOnce(async () => folderless);

    await prefs.saveCachedDetectedSummaryLanguage('meeting-1', 'pt');

    assert.equal(storageValues.get('detectedSummaryLanguageFallback:meeting-1'), 'pt');
  });

  test('rejects when folderless summary language cannot be persisted locally', async () => {
    installFailingLocalStorage();
    invokeMock.mock.mockImplementationOnce(async () => folderless);

    await assert.rejects(
      prefs.saveMeetingSummaryLanguage('meeting-1', 'it'),
      /Failed to save summary language on this device/,
    );
  });
});

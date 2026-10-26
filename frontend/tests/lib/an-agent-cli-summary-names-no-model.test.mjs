// A summary on Claude Code or Codex names the CLI and no model. (#226)
//
// The stored config held `model: ''` for Codex, as first run writes it (#181); ConfigContext loaded
// `data.model || prev.model`, so the empty string became the on-device default, and the toast read
// "Using codex/gemma4:e2b" while the summary ran on Codex. The rules live in `lib/summary-engine.ts`;
// this file holds them, and that the two sites that showed the defect call them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom } from './dom-harness.mjs';

await setupDom();
const { loadTsx } = await import('./render-tsx.mjs');
const { loadedSummaryModel, summaryEngineLabel, isAgentCliProvider } = loadTsx('src/lib/summary-engine.ts');

// Condition 1: an agent CLI's empty model loads empty; another provider keeps today's fallback.
assert.equal(loadedSummaryModel('codex', '', 'gemma4:e2b'), '', 'Codex loaded with the on-device default');
assert.equal(loadedSummaryModel('claude-code', '', 'gemma4:e2b'), '', 'Claude Code loaded with the on-device default');
assert.equal(loadedSummaryModel('codex', 'gemma4:e2b', 'x'), '', 'a stale model written before the fix is not loaded either');
assert.equal(loadedSummaryModel('builtin-ai', '', 'gemma4:e2b'), 'gemma4:e2b', 'sentinel: another provider still falls back');
assert.equal(loadedSummaryModel('claude', 'claude-sonnet-4-5', 'gemma4:e2b'), 'claude-sonnet-4-5');

// Condition 3: the toast's label.
assert.equal(summaryEngineLabel('codex', 'gemma4:e2b'), 'Codex');
assert.equal(summaryEngineLabel('claude-code', ''), 'Claude Code');
assert.equal(summaryEngineLabel('claude', 'claude-sonnet-4-5'), 'claude/claude-sonnet-4-5', 'sentinel: another provider keeps its model');
assert.equal(isAgentCliProvider('toString'), false, 'an inherited property is not a provider');

// The sites call the rules, rather than carrying a copy of them.
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
assert.match(read('src/hooks/meeting-details/useSummaryGeneration.ts'), /description: `Using \$\{summaryEngineLabel\(modelConfig\.provider, modelConfig\.model\)\}`/,
  "the generation toast does not use summaryEngineLabel");
assert.doesNotMatch(read('src/hooks/meeting-details/useSummaryGeneration.ts'), /Using \$\{modelConfig\.provider\}\/\$\{modelConfig\.model\}/,
  'the provider/model template is back in the generation toast');
assert.match(read('src/contexts/ConfigContext.tsx'), /model: loadedSummaryModel\(data\.provider, data\.model, prev\.model\)/,
  'ConfigContext does not load the summary model through loadedSummaryModel');
assert.doesNotMatch(read('src/contexts/ConfigContext.tsx'), /model: data\.model \|\| prev\.model/,
  "ConfigContext's `data.model || prev.model` is back");

console.log('ok - an agent CLI loads and is named with no model; other providers keep theirs; both sites call the rules');

// What the summariser is handed, asserted on the input.
//
// #113. The application records which side of the conversation every sentence came from and then
// flattened it away before the summary saw it: `useSummaryGeneration.ts` passed `t.speaker` — a
// model's guess — and dropped `t.channel`, the one that is known for certain.
//
// **Why this asserts the input and not the output.** v1's control was *"generate a summary, swap the
// two channels, generate again; the two summaries must differ"*. It could not fail. The built-in
// summariser is stochastic by construction: `models.rs:42-53` sets `temperature: 1.0`,
// `llama-helper/src/main.rs:565` seeds the sampler from the wall clock, and `Request::Generate` has
// no `seed` field at all. Measured on the reference recording — three runs on identical input, same
// template, same model, same language, all single-chunk — produced 8742 / 9836 / 7609 characters and
// three different extracted meeting titles. An implementation that concatenates flat text and never
// reads `channel` passes "the summaries differ" every time.
//
// So the assertion moved to the string that reaches `generate_meeting_summary`. Deterministic,
// offline, milliseconds — and the swap is a `map` over a fixture rather than a re-recording.
//
// Four conditions, five controls — condition 3 owes two, one per channel-less state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Compile one TS module and run it in a vm, resolving the two imports it has by hand. */
function load(rel, requires = {}) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requires) return requires[id];
      // `@/types` is types only and erases to nothing at runtime.
      if (id === '@/types') return {};
      throw new Error(`unstubbed import: ${id}`);
    },
  });
  return module.exports;
}

const speaker = load('src/lib/speaker.ts');
const {
  buildSummaryTranscriptPayload,
  payloadCarriesSides,
  sideAwareCustomPrompt,
  SIDE_INSTRUCTION,
} = load('src/lib/summary-payload.ts', { '@/lib/speaker': speaker });

const row = (i, over = {}) => ({
  id: `r${i}`,
  text: `line${i}`,
  timestamp: '10:00:00',
  audio_start_time: i * 10,
  ...over,
});

const lines = (rows, names) => buildSummaryTranscriptPayload(rows, names).transcriptText.split('\n');

// --- 1: the input carries the side, and swapping the column swaps every mark ---------------------
{
  const rows = [
    row(0, { channel: 'you' }),
    row(1, { channel: 'others' }),
    row(2, { channel: 'you' }),
  ];
  const before = lines(rows);
  assert.deepEqual(
    before.map((l) => l.replace(/^\[\d+:\d+\] /, '').split(':')[0]),
    ['You', 'Others', 'You'],
    'each line must be prefixed with the capture channel that carried it'
  );
  assert.ok(
    before[0].startsWith('[00:00] You: line0'),
    `the timestamp survives in front of the mark; got ${JSON.stringify(before[0])}`
  );

  // The swap is a map over the fixture, not a re-recording. That is the whole reason this
  // assertion lives on the input.
  const swapped = rows.map((r) => ({ ...r, channel: r.channel === 'you' ? 'others' : 'you' }));
  const after = lines(swapped);
  assert.deepEqual(
    after.map((l) => l.replace(/^\[\d+:\d+\] /, '').split(':')[0]),
    ['Others', 'You', 'Others'],
    'flipping `channel` on every row must flip every mark'
  );
  assert.deepEqual(
    after.map((l) => l.replace(/^\[\d+:\d+\] \w+: /, '')),
    before.map((l) => l.replace(/^\[\d+:\d+\] \w+: /, '')),
    'and must move only the mark — the words are unchanged'
  );
}

// --- 2: the model is told what the marks mean, and only when there are two sides -----------------
{
  const twoSided = [row(0, { channel: 'you' }), row(1, { channel: 'others' })];
  assert.equal(payloadCarriesSides(twoSided), true);
  assert.equal(
    sideAwareCustomPrompt('', true),
    SIDE_INSTRUCTION,
    'with two sides the model is told what the marks mean'
  );
  assert.match(SIDE_INSTRUCTION, /"You:"/, 'the instruction must name the marks it explains');
  assert.match(SIDE_INSTRUCTION, /"Others:"/);
  assert.match(
    SIDE_INSTRUCTION,
    /not a guess about identity|which device carried/i,
    'and must say what the channel is, or the model will read it as speaker identification'
  );

  // Never in place of what the user typed.
  const mine = 'Focus on the API design.';
  const combined = sideAwareCustomPrompt(mine, true);
  assert.ok(combined.startsWith(mine), "the user's own prompt must survive, first");
  assert.ok(combined.includes(SIDE_INSTRUCTION), 'and the instruction is appended to it');
}

// --- 3: three states, and the third is the current product ---------------------------------------
{
  // No channel on any row — every recording made on the streaming path (`streaming.rs:168`).
  const none = [row(0), row(1)];
  assert.equal(payloadCarriesSides(none), false);
  assert.deepEqual(
    lines(none),
    ['[00:00] line0', '[00:10] line1'],
    "with no channel the lines carry no mark — this is today's summary, unchanged"
  );
  assert.equal(
    sideAwareCustomPrompt('', false),
    '',
    'and the side instruction is not sent at all. A static template section would be requested on ' +
      'every recording, and "you promised 12 things, they promised 0" is a lie told by structure'
  );

  // One side only — a microphone-only recording.
  const one = [row(0, { channel: 'you' }), row(1, { channel: 'you' })];
  assert.equal(payloadCarriesSides(one), false, 'one distinct channel is not two sides');
  assert.equal(sideAwareCustomPrompt('kept', false), 'kept', 'and the user prompt passes through');
}

// --- 4: one attribution per line, and the fact beats the guess -----------------------------------
{
  const mixed = [
    row(0, { channel: 'you', speaker: '1' }), // both present — the channel must win
    row(1, { speaker: '2' }), // only the guess
    row(2, { channel: 'others' }), // only the fact
    row(3), // neither
  ];
  const out = lines(mixed);
  assert.ok(out[0].includes('You: line0'), 'where the channel exists it is used');
  assert.ok(
    !out[0].includes('Speaker 1'),
    'and the guess is NOT also passed. Handing the model a fact and a guess on one line invites it ' +
      'to choose between them'
  );
  assert.ok(out[1].includes('Speaker 2: line1'), 'where there is no channel, `speaker` still speaks');
  assert.ok(out[2].includes('Others: line2'));
  assert.equal(out[3], '[00:30] line3', 'and a row with neither carries no prefix');

  // A renamed speaker still reaches the model, on the rows that use `speaker` at all.
  const named = lines([row(0, { speaker: '1' })], { 1: 'Marina' });
  assert.ok(named[0].includes('Marina: line0'), 'speaker renames must survive into the summary input');
}

// --- 5: the hook actually uses it ---------------------------------------------------------------
//
// The four checks above hold a pure module. Nothing in them notices if `useSummaryGeneration` stops
// calling it — and the first attempt at a control for exactly that scored a red from `tsc` that was
// not a type error at all: mutated, `tsc --noEmit` exits **0**, because the replacement object is
// structurally compatible and unused imports are not denied here. A red that proves nothing.
//
// So this is a declaration check over the assembly site, and it says so. Driving the hook itself
// would need React plus stubs for eight contexts; the boundary it guards is two call sites.
{
  const hook = fs.readFileSync(
    path.join(root, 'src/hooks/meeting-details/useSummaryGeneration.ts'),
    'utf8'
  );
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.match(
    code,
    /buildSummaryTranscriptPayload\(allTranscripts, speakerNames\)/,
    'the hook must build its payload with the module asserted above, and pass `speakerNames` — ' +
      'without them a renamed speaker stops reaching the model on channel-less rows'
  );
  const sideCalls = [...code.matchAll(/sideAwareCustomPrompt\(/g)].length;
  assert.equal(
    sideCalls,
    2,
    `both summary paths must send the side instruction; found ${sideCalls}. ` +
      '`handleGenerateSummary` and `handleRegenerateSummary` are separate call sites and a ' +
      'regenerated summary that loses the marks is the defect nobody would look for'
  );
  assert.ok(
    !/withSpeaker/.test(code),
    'and the hook must no longer reach for `withSpeaker` directly — attribution is one decision now, ' +
      'made in one place'
  );
}

console.log(
  'ok - summary payload: lines carry the capture channel and every mark moves when the column is ' +
    'swapped, the instruction is sent only when two sides exist and never replaces the user prompt, ' +
    'the two channel-less states send no marks and no instruction, and each line carries exactly ' +
    'one attribution with the fact beating the guess'
);

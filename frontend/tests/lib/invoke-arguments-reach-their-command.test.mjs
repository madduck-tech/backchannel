// Every argument the frontend sends reaches its command. (#242, condition 1)
//
// tauri-macros names a command's parameters in camelCase unless the command says otherwise
// (`rename_all`), and tauri turns a key it does not know into `None` for an `Option` without a word.
// So `{ mic_device_name: … }` sent to `start_recording_with_devices_and_meeting` arrived as nothing,
// on 8 of 8 of the product owner's starts on 2026-10-26, and nothing anywhere said so.
//
// This parses every `invoke` / `invokeTauri` call under src/ with the TypeScript parser, and every
// function under src-tauri/src marked `#[tauri::command]` or a bare `#[command]`, and fails when a
// top-level key names no parameter of its command under that command's casing, or when a call names
// a command it cannot find. It does not require an optional parameter to be sent: plenty of calls
// leave `authToken` out, and that is legitimate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { root, sourceFiles, rel } from './reachability-shared.mjs';

const rustRoot = path.join(root, 'src-tauri', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// Parameters Tauri fills itself; the frontend never names them.
const INJECTED = /^(?:tauri::)?(?:AppHandle|State|Window|WebviewWindow|Webview|ipc::Request|Request|ipc::CommandScope|CommandScope|ipc::GlobalScope|GlobalScope)\b/;
// tauri-macros names a key with heck (`to_lower_camel_case`, or `to_snake_case` under
// `rename_all = "snake_case"`), and heck drops underscores at the edges: `_chunk_size` is `chunkSize`.
const words = (s) => s.split('_').filter(Boolean).map((w) => w.toLowerCase());
const camel = (s) => words(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
const snakeCase = (s) => words(s).join('_');

/** Split a parameter list at its top-level commas. */
function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if ('(<['.includes(ch)) depth++;
    if (')>]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Every command function: its name, the keys it accepts, and where it is. */
export function commandSignatures() {
  const commands = new Map();
  for (const f of walk(rustRoot).filter((f) => f.endsWith('.rs'))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/#\[(?:tauri::)?command(\s*\(([^)]*)\))?\]/g)) {
      const after = text.slice(m.index + m[0].length);
      const fn = after.match(/^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^{(]*>)?\s*\(/);
      if (!fn) continue;
      // The parameter list, bracket-balanced from the opening parenthesis.
      let i = fn.index + fn[0].length; let depth = 1; const start = i;
      while (depth > 0 && i < after.length) { if (after[i] === '(') depth++; if (after[i] === ')') depth--; i++; }
      const params = splitTop(after.slice(start, i - 1).replace(/\/\/[^\n]*/g, ''))
        .filter((p) => !/^&?\s*(mut\s+)?self$/.test(p))
        .map((p) => { const c = p.indexOf(':'); return { name: p.slice(0, c).trim().replace(/^mut\s+/, ''), type: p.slice(c + 1).trim() }; })
        .filter((p) => !INJECTED.test(p.type));
      const snake = /rename_all\s*=\s*"snake_case"/.test(m[2] ?? '');
      commands.set(fn[1], { keys: new Set(params.map((p) => (snake ? snakeCase(p.name) : camel(p.name)))), where: `${path.relative(root, f)}`, snake });
    }
  }
  return commands;
}

/** Every invoke call: the command it names and the top-level keys of its argument object. */
export function invokeCalls(files = sourceFiles()) {
  const calls = [];
  for (const f of files.filter((f) => /\.(ts|tsx)$/.test(f))) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['invoke', 'invokeTauri'].includes(node.expression.text)) {
        const [first, second] = node.arguments;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          let keys = []; let opaque = false;
          if (second && ts.isObjectLiteralExpression(second)) {
            for (const p of second.properties) {
              if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.push(p.name.text);
              else opaque = true;
            }
          } else if (second) opaque = true;
          calls.push({ command: first.text, keys, opaque, at: `${rel(f)}:${line}` });
        } else {
          calls.push({ command: null, keys: [], opaque: true, at: `${rel(f)}:${line}` });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return calls;
}

const commands = commandSignatures();
const calls = invokeCalls().filter((c) => !(c.command ?? '').startsWith('plugin:'));
const bare = [...commands.values()].length;

test(`every invoke names a command, and every key it sends names a parameter (${calls.length} calls, ${bare} commands)`, () => {
  assert.ok(calls.length >= 200, `only ${calls.length} invoke calls parsed`);
  assert.ok(commands.size >= 120, `only ${commands.size} commands parsed`);
  const unknown = calls.filter((c) => c.command && !commands.has(c.command)).map((c) => `${c.at}: ${c.command}`);
  assert.deepEqual(unknown, [], 'calls naming a command that does not exist');
  const unnamed = calls.filter((c) => !c.command).map((c) => c.at);
  assert.deepEqual(unnamed, [], 'calls whose command is not a literal, which this census cannot check');
  const stray = calls.filter((c) => c.command && commands.has(c.command)).flatMap((c) => {
    const cmd = commands.get(c.command);
    return c.keys.filter((k) => !cmd.keys.has(k)).map((k) => `${c.at}: ${c.command} receives '${k}', which it would drop; it takes ${[...cmd.keys].map((x) => `'${x}'`).join(', ') || 'nothing'} (${cmd.snake ? 'snake_case' : 'camelCase'}, ${cmd.where})`);
  });
  assert.deepEqual(stray, [], 'keys no parameter receives');
});

test('the census reads both command forms and every casing it can meet', () => {
  const sources = walk(rustRoot).filter((f) => f.endsWith('.rs')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const bareForm = (sources.match(/^\s*#\[command\]/gm) ?? []).length;
  assert.ok(bareForm >= 15, `only ${bareForm} bare #[command] functions in the source`);
  assert.ok(commands.has('transcribe_load_model'), 'a bare-#[command] function was not read');
  assert.ok(commands.get('start_recording_with_devices_and_meeting')?.keys.has('meetingName'), 'the start command is not read with its camelCase key');
  assert.ok([...commands.values()].every((c) => ![...c.keys].some((k) => /^(app|state|window)$/.test(k))), 'an injected parameter was counted as a key');
});

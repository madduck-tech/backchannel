// The core pass's two summary oracles, run over BlockNote's own HTML. (#171)
//
// `scripts/lib/summary-prose.js` says whether the summary panel holds prose, and
// `scripts/lib/action-item-blocks.js` counts the action items it shows. `stage2-core-check.sh` sends
// both files to the running application, and this test runs the same text, over the HTML BlockNote
// 0.53 itself produces from a summary's markdown (`tryParseMarkdownToBlocks`, then
// `blocksToFullHTML`), so a structure the editor renders differently from a hand-written fixture is
// what the oracles meet here too.
//
// Both oracles were wrong once in #171's gate. The prose bar passed four translated titles alone in
// `unscored`, because it filtered four English titles and counted bytes. The item count counted a
// nested line as an item, where the counter reads it as part of the item above.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDom } from './dom-harness.mjs';

await setupDom();
const { BlockNoteEditor } = await import('@blocknote/core');
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROSE = fs.readFileSync(path.join(repo, 'scripts', 'lib', 'summary-prose.js'), 'utf8');
const ITEMS = fs.readFileSync(path.join(repo, 'scripts', 'lib', 'action-item-blocks.js'), 'utf8');
const BAR = 120; // `stage2-core-check.sh`'s bar, in characters

const editor = BlockNoteEditor.create();
function render(markdown) {
  document.body.innerHTML = editor.blocksToFullHTML(editor.tryParseMarkdownToBlocks(markdown));
}
const prose = () => JSON.parse(new Function(PROSE)());
const items = () => JSON.parse(new Function(ITEMS)());
const failures = [];
const check = (name, cond, detail) => { if (!cond) failures.push(`${name}: ${detail}`); };

const EN_TITLES = ['Summary', 'Key Decisions', 'Action Items', 'Discussion Highlights'];
const RU_TITLES = ['Резюме', 'Ключевые решения', 'Задачи', 'Основные моменты обсуждения'];
const doc = (titles, bodies) => `# A meeting\n\n${titles.map((t, i) => `**${t}**\n\n${bodies[i]}`).join('\n\n')}\n`;
const PROSE_EN = 'The speaker asked the audience to think about what they could do for their country, and not what their country could do for them.';

// --- prose -------------------------------------------------------------------------------------------
render(doc(EN_TITLES, EN_TITLES.map(() => 'None noted in this section.')));
let p = prose();
check('English titles and placeholders alone stay under the bar', p.chars < BAR, `${p.chars} characters: '${p.prose}'`);
check('precondition: the four titles were found as titles', p.titles === 4, `${p.titles} titles`);

render(doc(RU_TITLES, RU_TITLES.map(() => 'В этом разделе ничего не отмечено.')));
p = prose();
check('translated titles and placeholders alone stay under the bar (unscored)', p.chars < BAR, `${p.chars} characters: '${p.prose}'`);
check('the translated placeholder counts once', p.repeats === 3, `${p.repeats} repeats`);

// 69 Cyrillic letters without whitespace, 136 bytes; with the placeholder, 100 characters and 193 bytes:
// under a bar of 120 characters, over one of 120 bytes.
const SHORT_RU = 'Докладчик просил слушателей подумать о стране и о том, что они могут сделать сами.';
render(doc(RU_TITLES, [SHORT_RU, 'В этом разделе ничего не отмечено.', 'В этом разделе ничего не отмечено.', 'В этом разделе ничего не отмечено.']));
p = prose();
check('characters are counted, not bytes', p.chars < BAR, `${p.chars} counted for ${SHORT_RU.replace(/\s/g, '').length} letters of prose and one placeholder`);

render(doc(EN_TITLES, [PROSE_EN, 'None noted in this section.', '- [ ] **Anna** — Send the budget by November 7', 'None noted in this section.']));
p = prose();
check('a real summary is over the bar', p.chars >= BAR, `${p.chars} characters`);
check('its prose holds the summary and the action item', p.prose.includes('think about what they could do') && p.prose.includes('Send the budget'), `'${p.prose}'`);

// --- action items ------------------------------------------------------------------------------------
const sections = (actionItems) => doc(EN_TITLES, [PROSE_EN, 'None noted in this section.', actionItems, '- A point about the venue.']);
render(sections('- [ ] **Anna** — Send the budget by November 7\n- [ ] **Someone** — Look at the venue'));
check('two checklist items are two', items().items === 2, JSON.stringify(items()));
render(sections('- [ ] Look at the venue\n  - Due: None\n- [ ] Send the budget'));
let i = items();
check('a nested line is not an item of its own', i.items === 2 && i.nested === 1, JSON.stringify(i));
render(sections('1. Look at the venue\n2. Send the budget'));
check('numbered items are items', items().items === 2, JSON.stringify(items()));
render(sections('None noted in this section.'));
check('no items, and the Discussion bullet after the next title is not one', items().items === 0, JSON.stringify(items()));

assert.deepEqual(failures, [], `RED CONDITIONS:\n${failures.join('\n')}`);
console.log('ok - the prose bar and the item count read BlockNote 0.53\'s own HTML as the core pass needs');

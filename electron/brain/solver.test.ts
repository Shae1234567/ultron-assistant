import { describe, expect, it, vi } from 'vitest';

// What the "model" writes, in order - each test queues its own programs.
let replies: string[] = [];
const js = (code: string) => '```js\n' + code + '\n```';
vi.mock('./llm', () => ({ chat: async () => ({ text: replies.shift() ?? js('console.log("out of replies")'), toolCalls: [], provider: 'ollama', model: 'test' }) }));

const { answerKey, normalizeAnswer, sameAnswer, solveWithPrograms, solverNote, statesAnswer, wantsSolver } = await import('./solver');

// Three programs for the average-speed trap: two right, one falling for the trap.
const RIGHT_1 = js('const d1 = 60, v1 = 30, d2 = 60, v2 = 90;\nconsole.log((d1 + d2) / (d1 / v1 + d2 / v2));');
const RIGHT_2 = js('const total = 120; const time = 60 / 30 + 60 / 90;\nconsole.log(total / time);');
const TRAP = js('console.log((30 + 90) / 2);');

describe('the program solver (v3)', () => {
  it('answers with what most independent programs agree on - not the trap', async () => {
    replies = [RIGHT_1, RIGHT_2, TRAP];
    const r = await solveWithPrograms('I bike 60 km at 30 km/h and then 60 km at 90 km/h. What is my average speed?', { k: 3 });
    expect(r).toMatchObject({ answer: '45', agree: 2, tried: 3 });
    expect(r.outputs).toEqual(['45', '45', '60']);
    expect(solverNote(r)).toMatch(/2 of them agree: 45\. Start your reply with this answer/);
  });

  it('says so when the programs disagree', async () => {
    replies = [RIGHT_2, TRAP];
    const r = await solveWithPrograms('x', { k: 2 });
    expect(r.answer).toBeNull();
    expect(solverNote(r)).toMatch(/disagree \(45 \| 60\)/);
  });

  it('lets a crashed or NaN program fix itself, then draws more when fewer than two agree (hard set, trains-meet)', async () => {
    replies = [
      js('console.log(hRounded)'), // crashes
      js('console.log(NaN + ":" + NaN + " am")'), // prints NaN - a failure, not an answer
      js('console.log("16:01 pm")'), // right, but alone
      js('console.log("4:01 pm")'), // repair of the crash
      js('console.log("4:02 pm")'), // repair of the NaN one (rounded the other way)
    ];
    const r = await solveWithPrograms('Two trains...', { k: 3, extra: 2 });
    expect(r.outputs).toEqual(['4:01 pm', '4:02 pm', '4:01 pm']);
    expect(r).toMatchObject({ answer: '4:01 pm', agree: 3, tried: 3 });
    expect(replies).toHaveLength(0);
  });

  it('draws extra programs only when it has to', async () => {
    replies = [TRAP, RIGHT_1, js('console.log(50)'), RIGHT_2, js('console.log(30)')];
    const r = await solveWithPrograms('average speed', { k: 3, extra: 2 });
    expect(r).toMatchObject({ answer: '45', agree: 2, tried: 5 });
    // 44.9 is 45 rounded differently - the same answer.
    replies = [TRAP, RIGHT_1, js('console.log(44.9)')];
    expect(await solveWithPrograms('average speed', { k: 3, extra: 2 })).toMatchObject({ answer: '45', agree: 2, tried: 3 });
  });

  it('compares answers the way a person would', () => {
    expect(normalizeAnswer(' 4:02 PM. ')).toBe('4:02 pm');
    expect(normalizeAnswer('45.00000001')).toBe(normalizeAnswer('45'));
    const same = (a: string, b: string) => sameAnswer(answerKey(a), answerKey(b));
    expect(same('16:01', '4:01 pm')).toBe(true);
    expect(same('4:02 pm', '4:01 PM')).toBe(true);
    expect(same('4:05 pm', '4:01 pm')).toBe(false);
    expect(same('13.3', '13.33 km/h')).toBe(true);
    expect(same('$41.91', '41.9')).toBe(true);
    expect(same('5/36', '0.1389')).toBe(true);
    expect(same('-5', '-5 minutes')).toBe(true);
    expect(same('45', '60')).toBe(false);
    expect(same('56', '57')).toBe(false);
    expect(same('0', '0.4')).toBe(false);
    expect(same('Friday', 'friday.')).toBe(true);
    // A label in front doesn't change the answer (hard set, trains-meet: "Meeting Time: 4:02 pm").
    expect(same('Meeting Time: 4:02 pm', '4:01 pm')).toBe(true);
    expect(same('Answer: 45 km/h', '45')).toBe(true);
    expect(same('Ana: 1, Bo: 4', 'Ana: 1, Bo: 4')).toBe(true);
    expect(same('4:02 am', '4:02 pm')).toBe(false);
    // One assignment, whatever order it is printed in (fresh hard set, race).
    expect(same('Wes 1, Zoe 2, Xia 3, Yan 4', 'Zoe 2, Yan 4, Xia 3, Wes 1')).toBe(true);
    expect(same('Zoe: 2nd, Wes: 1st, Xia: 3rd and Yan: 4th', 'Wes 1, Zoe 2, Xia 3, Yan 4')).toBe(true);
    expect(same('Zoe 1, Xia 2, Wes 3, Yan 4', 'Wes 1, Zoe 2, Xia 3, Yan 4')).toBe(false);
  });

  it('checks the reply leads with the agreed answer', () => {
    expect(statesAnswer("You're wrong: there's **90 minutes** left for gaming. Start with 180 minutes...", '-5')).toBe(false);
    expect(statesAnswer("You're 5 minutes short - there's no time for gaming.", '-5')).toBe(true);
    expect(statesAnswer('You would have **–5** minutes: not enough.', '-5')).toBe(true);
    expect(statesAnswer('They meet at about 4:01, just after four.', '4:01 pm')).toBe(true);
    expect(statesAnswer('They meet at 2:56 PM.', '4:01 pm')).toBe(false);
    expect(statesAnswer('December 25, 2026 is a **Friday**.', 'Friday')).toBe(true);
    expect(statesAnswer('Ana wears 1, Bo wears 4, Cy wears 3 and Di wears 2.', 'Ana 1, Bo 4, Cy 3, Di 2')).toBe(true);
    expect(statesAnswer('It comes to $41.91 for the trip.', '41.905')).toBe(true);
  });

  it('is used for maths and puzzles, not for everything', () => {
    expect(wantsSolver('Four players wear jerseys 1 to 4. Ana is odd... who wears what?')).toBe(true);
    expect(wantsSolver('What day of the week is December 25, 2026?')).toBe(true);
    expect(wantsSolver('I am three times as old as my cousin. How old am I?')).toBe(true);
    // Geometry word problems too (hard set: a rectangle's area was worked out in the lead's head, wrongly).
    expect(wantsSolver('A garden is twice as long as it is wide and its perimeter is 36 m. What is its area?')).toBe(true);
    expect(wantsSolver('what should I make for dinner?')).toBe(false);
    expect(wantsSolver('play some lofi music')).toBe(false);
  });
});

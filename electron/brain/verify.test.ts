import { describe, expect, it } from 'vitest';
import { checkCitations, checkEquations, isMathAsk } from './verify';

describe('isMathAsk', () => {
  it('spots answers that are worked-out numbers', () => {
    expect(isMathAsk('I got 78, 91, 85 and 66 on my quizzes. What is my average?')).toBe(true);
    expect(isMathAsk('If I save $15 a week, how long until I have $400?')).toBe(true);
    expect(isMathAsk('what is 15% of 240')).toBe(true);
  });
  it('does not treat a lookup with numbers in its address or labels as maths', () => {
    expect(isMathAsk('Read the league rules at http://127.0.0.1:65184/league-rules.html and tell me how many substitutes a U15 team can dress.')).toBe(false);
    expect(isMathAsk('How many students are in Grade 9 at Division 2 schools?')).toBe(false);
    expect(isMathAsk('Practice runs from 6:45 pm to 8:20 pm, three times a week. How many hours is that?')).toBe(true);
    expect(isMathAsk('A soccer field is 105 metres long. How long is that in feet?')).toBe(true);
    expect(isMathAsk('What is 72 degrees Fahrenheit in Celsius?')).toBe(true);
    expect(isMathAsk('Who won the game in 2022?')).toBe(false);
  });

  it('leaves everything else alone', () => {
    expect(isMathAsk('how many files are in my Downloads folder?')).toBe(false);
    expect(isMathAsk('add a task for tomorrow at 7:30am')).toBe(false);
    expect(isMathAsk('who won the 2022 world cup?')).toBe(false);
  });
});

describe('checkEquations', () => {
  it('catches a wrong step in worked maths (LaTeX and unicode too)', () => {
    const r = checkEquations('Total needed: $82 \\times 5 = 400$. Current: 78 + 91 + 85 + 66 = 320, so 400 − 320 = 80.');
    expect(r.checked).toBe(3);
    expect(r.wrong).toEqual([{ shown: '82 * 5 = 400', stated: 400, actual: 410 }]);
  });

  it('accepts correct chains and results rounded to the decimals shown', () => {
    expect(checkEquations('(78 + 91 + 85 + 66) / 4 = 320 / 4 = 80').wrong).toEqual([]);
    expect(checkEquations('That is 10 / 3 = 3.33 hours, or 1,000 * 1.05 = 1,050.').wrong).toEqual([]);
  });

  it('ignores things that are not arithmetic', () => {
    const r = checkEquations('On 2026-09-28 at 10:30 the score was 3-1; x = 5 and 15% of 240 = 36.');
    expect(r.checked).toBe(0);
  });
});

describe('checkCitations', () => {
  const sources = [
    { n: 1, text: 'The Treaty of Paris was signed on 10 February 1763, ending the Seven Years\' War between Britain and France.' },
    { n: 2, text: 'Canada\'s population passed 41 million people in 2025 according to Statistics Canada.' },
  ];

  it('supports statements whose figures and words are in the cited source, and keeps the passage', () => {
    const r = checkCitations('The Treaty of Paris ended the Seven Years\' War in 1763 [1]. Canada passed 41 million people in 2025 [2].', sources);
    expect(r).toMatchObject({ checked: 2, supported: 2, flagged: [] });
    expect(r.evidence[0].passage).toMatch(/10 February 1763/);
  });

  it('flags a figure that is not in its source, and a citation to no source', () => {
    const r = checkCitations('Canada passed 45 million people in 2025 [2]. Britain won 12 battles [7].', sources);
    expect(r.supported).toBe(0);
    expect(r.flagged.map((f) => f.missing)).toEqual([['45'], ['(cites a source that does not exist)']]);
  });
});

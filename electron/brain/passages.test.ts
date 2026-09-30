import { describe, expect, it } from 'vitest';
import { focusText, splitPassages } from './passages';

const filler = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `Paragraph ${i + from} is about the club's history, kit colours, sponsors and the stadium renovation that finished in ${1990 + i}. It goes on for a while so that it reads like a real paragraph on a long club page.`).join('\n\n');
const page = `Riverside FC - Club news\nPublished September 12, 2026\n\n${filler(40)}\n\nThe Division 2 tryout results will be posted on October 4, 2026, and every player will be emailed by the technical director.\n\n${filler(40, 40)}`;

describe('focusText (reading the part of a long page that answers the question)', () => {
  it('finds an answer the old cut-off never showed', () => {
    const at = page.indexOf('The Division 2 tryout results');
    expect(at).toBeGreaterThan(5000);
    const r = focusText(page, 'When are the Division 2 tryout results posted?', 5000);
    expect(r.focused).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5000);
    expect(r.text).toContain('posted on October 4, 2026');
    // The opening stays, so the reader still knows the page and its date.
    expect(r.text.startsWith('Riverside FC - Club news')).toBe(true);
    expect(r.text).toContain('[...]');
  });

  it('keeps passages in page order', () => {
    const r = focusText(page, 'stadium renovation 1995 tryout results October', 5000);
    const order = [...r.text.matchAll(/Paragraph (\d+) is/g)].map((m) => Number(m[1]));
    expect(order.length).toBeGreaterThan(2);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('leaves short pages alone, and falls back to the start when nothing matches', () => {
    expect(focusText('short page', 'anything', 5000)).toMatchObject({ text: 'short page', focused: false });
    const r = focusText(page, 'zzqx', 3000);
    expect(r.focused).toBe(false);
    expect(r.text).toBe(page.slice(0, 3000));
  });

  it('splits long paragraphs on sentences and keeps headings with what follows', () => {
    const parts = splitPassages(`Heading\n\n${'A sentence that is long enough to count as real text here. '.repeat(40)}`);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0].startsWith('Heading\n')).toBe(true);
  });
});

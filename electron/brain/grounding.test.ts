import { describe, expect, it } from 'vitest';
import { addressesIn, linksIn, plainSpoken, verifyLinks } from './grounding';

describe('verifyLinks', () => {
  const seen = [
    'https://news.ycombinator.com/item?id=45321987',
    'https://github.com/paperclipai/paperclip',
    'https://www.reddit.com/r/popular/',
  ];

  it('keeps links the team actually saw, however they are punctuated', () => {
    const answer = 'Top story: https://news.ycombinator.com/item?id=45321987. Repo (https://github.com/paperclipai/paperclip) and https://reddit.com/r/popular';
    expect(verifyLinks(answer, seen)).toEqual({ text: answer, removed: [], repaired: 0 });
  });

  it('removes invented links and says so (a real answer from testing)', () => {
    const answer = '1. F-Droid 2.0: https://news.ycombinator.com/item?id=15847652 (huge engagement)';
    const r = verifyLinks(answer, seen);
    expect(r.removed).toEqual(['https://news.ycombinator.com/item?id=15847652']);
    expect(r.text).toBe('1. F-Droid 2.0: [unverified link removed] (huge engagement)');
  });

  it('trusts addresses the operator typed without https (a real answer from testing)', () => {
    const asked = addressesIn('Open codepen.io/pen and build a page, then email me at alex@example.com.');
    expect(asked).toEqual(['codepen.io/pen']);
    expect(verifyLinks('I could not get into https://codepen.io/pen.', asked).removed).toEqual([]);
  });

  it('finds every link in a reply', () => {
    expect(linksIn('see https://a.com/x, and https://b.org/y.')).toEqual(['https://a.com/x', 'https://b.org/y']);
  });
});

describe('withoutTabClaims', async () => {
  const { withoutTabClaims } = await import('./grounding');

  it('removes claims that pages are open in the operator\'s browser (real answers from testing)', () => {
    expect(withoutTabClaims('Here are the top three items from Hacker News and GitHub Trending, all opened in your browser tabs for review.\n\nOn Hacker News, F-Droid 2.0 leads.'))
      .toBe('Here are the top three items from Hacker News and GitHub Trending.\n\nOn Hacker News, F-Droid 2.0 leads.');
    expect(withoutTabClaims('Paperclip tops GitHub. All six links are ready for you to review in your own browser tabs.'))
      .toBe('Paperclip tops GitHub.');
  });

  it('leaves normal sentences alone', () => {
    const text = 'F-Droid 2.0 leads Hacker News with 1,399 points. Open the link to read the thread.';
    expect(withoutTabClaims(text)).toBe(text);
  });
});

describe('link repair', async () => {
  const { titledLinksIn } = await import('./grounding');

  it('reads titled links out of tool output, JSON-escaped or not', () => {
    const snapshot = JSON.stringify({ links: ['Anthropic wins supply chain ruling -> https://example.com/ruling'], text: 'LINKS ON THIS PAGE (title -> address):\nOllaya: open-source decision models -> https://github.com/ollaya/ollaya' });
    const search = JSON.stringify({ results: [{ title: 'First principles thinking, explained', url: 'https://fs.blog/first-principles/', snippet: '' }] });
    expect(titledLinksIn(snapshot + search)).toEqual([
      { title: 'Anthropic wins supply chain ruling', url: 'https://example.com/ruling' },
      { title: 'Ollaya: open-source decision models', url: 'https://github.com/ollaya/ollaya' },
      { title: 'First principles thinking, explained', url: 'https://fs.blog/first-principles/' },
    ]);
  });

  it('swaps an invented link for the real one to the same story (a real answer from testing)', () => {
    const titled = [
      { title: 'Anthropic wins supply chain ruling', url: 'https://example.com/ruling' },
      { title: 'Ollaya: open-source decision models', url: 'https://github.com/ollaya/ollaya' },
    ];
    const answer = 'The Anthropic supply chain ruling: https://news.ycombinator.com/item?id=38052786. And a cat video: https://news.ycombinator.com/item?id=38051648.';
    const r = verifyLinks(answer, titled.map((t) => t.url), titled);
    expect(r.repaired).toBe(1);
    expect(r.text).toBe('The Anthropic supply chain ruling: https://example.com/ruling. And a cat video: [unverified link removed].');
  });
});

describe('plainSpoken', () => {
  it('turns a markdown report into something to say out loud', () => {
    const report = ['**REPORT**', '- **Built**: the page on JSFiddle.', '- Preview: shows `ULTRON`.', '', '## Next', '1. Save it.'].join('\n');
    expect(plainSpoken(report)).toBe(['Built: the page on JSFiddle.', 'Preview: shows ULTRON.', 'Next', 'Save it.'].join('\n'));
  });
});

describe('looksInvented (made-up deep links)', async () => {
  const { looksInvented, linkKey } = await import('./grounding');

  it('catches an invented document ID (a real attempt from testing)', () => {
    expect(looksInvented('https://docs.google.com/document/d/1BxiMVs0XRAqNtWgBk-AuGq3rBcAKlsAs', new Set())).toBe(true);
    expect(looksInvented('https://app.notion.com/p/3bdd8578b19e80af8703cd13a2c7b096', new Set())).toBe(true);
  });

  it('allows links someone actually gave, and ordinary page addresses', () => {
    const real = 'https://docs.google.com/document/d/1_XbCB_798iE7Oc1hSlBhjQZeEV8MH5ODIFwNShrILGM/edit';
    expect(looksInvented(real, new Set([linkKey(real)]))).toBe(false);
    expect(looksInvented('https://en.wikipedia.org/wiki/World_War_II_casualties_1939', new Set())).toBe(false);
    expect(looksInvented('https://www.reddit.com/r/popular/', new Set())).toBe(false);
    expect(looksInvented('https://docs.google.com/', new Set())).toBe(false);
  });
});

describe('links built around an ID a tool returned', () => {
  it('keeps the real new-document link (removed by mistake in a live test)', () => {
    const answer = 'Your doc is live at https://docs.google.com/document/d/1b6416DsIVIFRdezmt_1uT7k7QyuNDVzU53Fb0-OGBWI/edit.';
    const ids = new Set(['1b6416DsIVIFRdezmt_1uT7k7QyuNDVzU53Fb0-OGBWI']);
    expect(verifyLinks(answer, [], [], ids).removed).toEqual([]);
    expect(verifyLinks(answer, [], [], new Set()).removed).toHaveLength(1);
  });
});

describe('withAskedLink', async () => {
  const { withAskedLink } = await import('./grounding');
  const titled = [{ title: 'Go Concurrency Distilled', url: 'https://antonz.org/go-concurrency/' }];

  it('adds the real link the answer dropped when one was asked for (live test, 27 Sep 2026)', () => {
    expect(withAskedLink('Give me its title and link.', 'The top story is Go Concurrency Distilled on antonz.org, at 155 points.', titled))
      .toBe('The top story is Go Concurrency Distilled on antonz.org, at 155 points.\nhttps://antonz.org/go-concurrency/');
  });

  it('leaves answers alone when no link was asked for, or one is already there', () => {
    expect(withAskedLink('what is the top story?', 'Go Concurrency Distilled.', titled)).toBe('Go Concurrency Distilled.');
    expect(withAskedLink('link please', 'See https://antonz.org/go-concurrency/', titled)).toBe('See https://antonz.org/go-concurrency/');
  });
});

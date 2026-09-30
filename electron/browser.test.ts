import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('./store', () => ({ getSettings: () => ({ browser: { visible: false } }) }));

const { pageWarning, isChallengeFrame, engineOrder } = await import('./browser');

describe('pageWarning (when an agent should back off a page)', () => {
  it('flags bot checks and CAPTCHAs', () => {
    expect(pageWarning('Just a moment...', 'Checking your browser before accessing reddit.com')).toMatch(/bot check/);
    expect(pageWarning('Google', 'Our systems have detected unusual traffic from your computer network.')).toMatch(/bot check/);
    // The page an agent once tried to solve (September 2026).
    expect(pageWarning('Reddit - Prove your humanity', 'Complete the challenge below to continue.')).toMatch(/bot check/);
    expect(pageWarning('Reddit', "You've been blocked by network security. To continue, log in to your Reddit account.")).toMatch(/bot check/);
  });

  it('knows CAPTCHA widgets by their frames - but not the invisible score badge', () => {
    expect(isChallengeFrame('https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=6Lfirr&size=normal')).toBe(true);
    expect(isChallengeFrame('https://www.google.com/recaptcha/api2/bframe?hl=en&k=6Le')).toBe(true);
    expect(isChallengeFrame('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox')).toBe(true);
    expect(isChallengeFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc')).toBe(true);
    expect(isChallengeFrame('https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc&size=invisible')).toBe(false);
    expect(isChallengeFrame('https://fiddle.jshell.net/_display/')).toBe(false);
  });

  it('flags short login walls but not long pages that merely mention signing in', () => {
    expect(pageWarning('TikTok', 'Log in to continue watching')).toMatch(/login/);
    const article = `${'Real content about the topic. '.repeat(200)} Sign in to see more from this author.`;
    expect(pageWarning('An article', article)).toBeUndefined();
  });

  it('leaves normal pages alone', () => {
    expect(pageWarning('r/popular', 'Top posts today: a cat learns to skateboard, 45.2k upvotes')).toBeUndefined();
  });
});

describe('toIsoDay (a page\'s publication date, for research)', async () => {
  const { toIsoDay } = await import('./browser');
  it('reads the formats sites use and rejects nonsense', () => {
    expect(toIsoDay('2026-03-04T10:00:00Z')).toBe('2026-03-04');
    expect(toIsoDay('20250115')).toBe('2025-01-15');
    expect(toIsoDay('2026-03-04')).toBe('2026-03-04');
    expect(toIsoDay('1970-01-01')).toBeUndefined();
    expect(toIsoDay('not a date')).toBeUndefined();
    expect(toIsoDay('2099-01-01')).toBeUndefined();
  });
});

describe('normalizeUrl (what an agent types into the address bar)', async () => {
  const { normalizeUrl } = await import('./browser');

  it('adds https:// to bare addresses', () => {
    expect(normalizeUrl('news.ycombinator.com')).toBe('https://news.ycombinator.com/');
    expect(normalizeUrl('trends.google.com/trending?geo=CA')).toBe('https://trends.google.com/trending?geo=CA');
  });

  it('keeps Reddit links on the layout that works logged-out', () => {
    expect(normalizeUrl('reddit.com/r/all')).toBe('https://www.reddit.com/r/all');
    expect(normalizeUrl('https://www.reddit.com/r/popular/top/?t=day')).toBe('https://www.reddit.com/r/popular/top/?t=day');
  });

  it('refuses things that are not web addresses', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('top posts on reddit')).toBeNull();
    expect(normalizeUrl('file:///C:/Windows')).toBeNull();
  });
});

describe('looksGuessed (deep links nobody actually saw)', async () => {
  const { looksGuessed, normalizeUrl } = await import('./browser');

  it('flags an item ID that never appeared on a page', () => {
    const seen = new Set(['https://news.ycombinator.com/item?id=45123456']);
    expect(looksGuessed('https://news.ycombinator.com/item?id=39456789', seen)).toBe(true);
    expect(looksGuessed('https://news.ycombinator.com/item?id=45123456', seen)).toBe(false);
  });

  it('leaves ordinary addresses alone', () => {
    expect(looksGuessed('https://news.ycombinator.com/', new Set())).toBe(false);
    expect(looksGuessed('https://www.reddit.com/r/popular/', undefined)).toBe(false);
  });

  it('sends old and new Reddit to the layout that works logged-out', () => {
    expect(normalizeUrl('old.reddit.com/r/popular')).toBe('https://www.reddit.com/r/popular');
  });
});

describe('looksGuessed catches small and video IDs too', async () => {
  const { looksGuessed } = await import('./browser');
  it('flags item?id=9 and made-up video links that never appeared', () => {
    expect(looksGuessed('https://news.ycombinator.com/item?id=9', new Set())).toBe(true);
    expect(looksGuessed('https://www.youtube.com/watch?v=abcdefghijk', new Set())).toBe(true);
    expect(looksGuessed('https://github.com/trending', new Set())).toBe(false);
  });
});

describe('isTracker (what the agents never need to load)', async () => {
  const { isTracker } = await import('./browser');
  it('blocks ad and analytics hosts but not the sites themselves', () => {
    expect(isTracker('https://www.googletagmanager.com/gtm.js?id=X')).toBe(true);
    expect(isTracker('https://securepubads.g.doubleclick.net/tag/js/gpt.js')).toBe(true);
    expect(isTracker('https://static.hotjar.com/c/hotjar-1.js')).toBe(true);
    expect(isTracker('https://www.google.com/search?q=x')).toBe(false);
    expect(isTracker('https://www.reddit.com/r/popular/')).toBe(false);
    expect(isTracker('https://docs.google.com/document/d/abc')).toBe(false);
  });
});

describe('engineOrder (which search engines to try)', () => {
  it('tries the preferred engine first, then the rest', () => {
    expect(engineOrder('auto', 0, new Map())).toEqual(['bing', 'startpage', 'yahoo', 'duckduckgo', 'brave']);
    expect(engineOrder('yahoo', 0, new Map())[0]).toBe('yahoo');
  });

  it('benches engines that just refused automated searches, but never runs out of engines', () => {
    const now = 1_000_000;
    const blocked = new Map([['duckduckgo', now + 60_000], ['brave', now + 60_000], ['bing', now - 1]] as const);
    expect(engineOrder('auto', now, blocked)).toEqual(['bing', 'startpage', 'yahoo']);
    const all = new Map((['bing', 'startpage', 'yahoo', 'duckduckgo', 'brave'] as const).map((e) => [e, now + 60_000] as const));
    expect(engineOrder('auto', now, all)).toHaveLength(5);
  });
});

describe('looksUnrelated (junk results served to suspected bots)', async () => {
  const { looksUnrelated } = await import('./browser');
  const r = (title: string, url: string) => ({ title, url, snippet: '' });

  it('throws out a page where nothing matches the question (seen live on Bing)', () => {
    expect(looksUnrelated('Riverside High School advanced placement', [r('Oceanfront Restaurant and Lounge in Vancouver | Sylvia Hotel', 'https://sylviahotel.com/restaurant-lounge/')])).toBe(true);
  });

  it('keeps real answers and short questions alone', () => {
    expect(looksUnrelated('Riverside High School advanced placement', [r('Advance Placement', 'https://rhs.example.edu/advanced-placement')])).toBe(false);
    expect(looksUnrelated('AI', [r('Anything', 'https://example.com')])).toBe(false);
  });
});

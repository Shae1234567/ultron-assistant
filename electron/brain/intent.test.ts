import { describe, expect, it } from 'vitest';
import { buildsOnSite, needsAction } from './intent';

describe('needsAction', () => {
  it('spots requests to act on a website', () => {
    expect(needsAction('Open codepen.io/pen and build a small web page there')).toBe(true);
    expect(needsAction('make a poster in canva for the bake sale')).toBe(true);
    expect(needsAction('Make a slideshow on Google Slides about the Mongols')).toBe(true);
    expect(needsAction('read https://example.com/article and sum it up')).toBe(true);
    expect(needsAction('check what is trending on reddit')).toBe(true);
  });

  it('leaves conversation alone', () => {
    expect(needsAction('write me a poem about reddit')).toBe(false);
    expect(needsAction('I built a site on github.com last year')).toBe(false);
    expect(needsAction('what do you think of the Mongol empire?')).toBe(false);
  });
});

describe('buildsOnSite', () => {
  it('is the making kind of action', () => {
    expect(buildsOnSite('Open codepen.io/pen and build a small web page there')).toBe(true);
    expect(buildsOnSite('check what is trending on reddit')).toBe(false);
  });
});

describe('connected apps', async () => {
  const { actsInApp, connectedAppIn } = await import('./intent');
  const apps = ['googlesuper', 'gmail', 'googledocs', 'notion', 'canva', 'github'];

  it('sends "make it in a connected app" to the app (a real request from 26 Sep 2026)', () => {
    expect(actsInApp('Create a Google Doc yourself', apps)).toBe('googledocs');
    expect(actsInApp('put the plan in a new spreadsheet', apps)).toBe('googlesheets'); // covered by googlesuper
    expect(actsInApp('email Coach Ryan that I will be late', apps)).toBe('gmail');
    expect(actsInApp('make a poster in Canva', apps)).toBe('canva');
  });

  it('leaves questions, and apps that are not connected, alone', () => {
    expect(actsInApp('what is in my Google Doc about the Mongols?', apps)).toBeNull();
    expect(actsInApp('create a Figma mockup', apps)).toBeNull();
    expect(connectedAppIn('play something on Spotify', apps)).toBeNull();
  });

  it('knows Twitch, Instagram and TikTok once they are connected (added 30 Sep 2026)', () => {
    const social = [...apps, 'twitch', 'instagram', 'tiktok'];
    expect(connectedAppIn('who is live on twitch right now?', social)).toBe('twitch');
    expect(connectedAppIn('how many likes did my last insta post get', social)).toBe('instagram');
    expect(connectedAppIn('what are my TikTok stats', social)).toBe('tiktok');
    expect(connectedAppIn('who is live on twitch right now?', apps)).toBeNull();
    expect(connectedAppIn('I dig this song', social)).toBeNull();
  });
});

describe('usesApp (the operator asking about their own app data)', async () => {
  const { usesApp } = await import('./intent');
  const apps = ['gmail', 'googlecalendar', 'notion'];

  it('sends "how many unread emails do I have" to the app (a live-test miss)', () => {
    expect(usesApp('How many unread emails do I have in Gmail? Just the number.', apps)).toBe('gmail');
    expect(usesApp("what's on my calendar tomorrow?", apps)).toBe('googlecalendar');
  });

  it('leaves general questions about an app alone', () => {
    expect(usesApp('what is Notion good for?', apps)).toBeNull();
  });

  it('sends running a Discord server to the app', () => {
    expect(usesApp('kick Sam from the discord server', ['discord'])).toBe('discord');
    expect(usesApp('set up a Mods role on the discord', ['discord'])).toBe('discord');
    expect(usesApp('is discord down?', ['discord'])).toBeNull();
  });
});

describe('usesPc (the operator asking about their own computer)', async () => {
  const { usesPc } = await import('./intent');
  it('catches questions about their files and folders (a live-test miss)', () => {
    expect(usesPc('How many files are in my Downloads folder? Just the number.')).toBe(true);
    expect(usesPc('how much disk space do I have left?')).toBe(true);
  });
  it('leaves other questions alone', () => {
    expect(usesPc('what is a computer?')).toBe(false);
    expect(usesPc('what is 15 percent of 240?')).toBe(false);
  });
});

describe('asksContent (a question only reading can answer)', async () => {
  const { asksContent } = await import('./intent');
  it('spots questions about what something says', () => {
    expect(asksContent('Use the YouTube transcript tool on the Kurzgesagt video about black holes and tell me one specific thing the narrator says.')).toBe(true);
    expect(asksContent('What does the new school dress code say about hoodies?')).toBe(true);
    expect(asksContent('summarize this article for me')).toBe(true);
  });
  it('leaves other questions alone', () => {
    expect(asksContent('play some lofi on youtube')).toBe(false);
    expect(asksContent('what is 15% of 240')).toBe(false);
  });
});

describe('readsPage (a page at a given address to read)', async () => {
  const { readsPage } = await import('./intent');
  it('spots a read or check of a bare address that the site-name checks miss', () => {
    expect(readsPage('Check the school events calendar at http://127.0.0.1:5000/school-calendar.html - when is the Grade 9 science fair?')).toBe(true);
    expect(readsPage('read https://intranet.example.edu/notice and tell me what changed')).toBe(true);
  });
  it('leaves other messages alone', () => {
    expect(readsPage('here is a cool site https://example.com')).toBe(false);
    expect(readsPage('when is the science fair?')).toBe(false);
  });
});

describe('thinksHard / thinksDeep (how much reasoning an ask deserves)', async () => {
  const { thinksHard, thinksDeep } = await import('./intent');

  it('spots maths, logic, "why" and planning', () => {
    for (const t of [
      'Solve 3x + 7 = 22 and show the steps',
      'Why did the Mongol empire split apart so fast after Kublai Khan?',
      'Compare the iPad and a Chromebook for school and tell me which I should get',
      'Make me a strategy to raise my math mark from 70 to 85 before December',
      'If I save $15 a week how long until I have $400? 400 / 15',
    ]) expect(thinksHard(t), t).toBe(true);
  });

  it('leaves small talk and quick actions quick', () => {
    for (const t of ['hey ultron', 'what time is it', 'add a task to pack my soccer bag', 'play lofi on youtube', "what's the weather"]) {
      expect(thinksHard(t), t).toBe(false);
    }
  });

  it('saves the strongest, slower model for substantial problems', () => {
    expect(thinksDeep('why is the sky blue')).toBe(false);
    expect(thinksDeep('Why did the Mongol empire split apart so fast after Kublai Khan died, and could anyone have held it together?')).toBe(true);
  });
});

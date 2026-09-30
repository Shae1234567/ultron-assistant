import { describe, expect, it } from 'vitest';
import { hintNote, planAddons } from './addonRouter';

const skills = (q: string) => (/t-?test|groups/i.test(q) ? [{ name: 'statistical-analysis', description: 'Run t-tests, ANOVA and regressions.' }] : []);
const plan = (text: string, gemini = true) => planAddons(text, { gemini, skills });

describe('planAddons (the right add-on without being asked)', () => {
  it('reads a video instead of just playing it', () => {
    expect(plan('what does this video say about black holes? https://www.youtube.com/watch?v=e-P5IFTqB98').picked).toEqual(['YouTube transcript']);
    expect(plan('summarize the kurzgesagt video on black holes').picked).toEqual(['YouTube transcript']);
    expect(plan('play the kurzgesagt video on black holes').picked).toEqual([]);
    // His own channel is not a video to read (live check on the installed app, 30 Sep 2026).
    expect(plan('I need some ideas for a name for my history YouTube channel about empires.').picked).not.toContain('YouTube transcript');
    expect(plan('what does the latest video on my favourite youtube channel say about Rome? https://youtu.be/abc123').picked).toContain('YouTube transcript');
  });

  it('reads a feed', () => {
    expect(plan('what are the newest posts on https://www.cbc.ca/webfeed/rss/rss-topstories').picked).toEqual(['RSS reader']);
  });

  it('brings in a matching science guide', () => {
    const p = plan('run a t-test to see if my two groups of scores are different');
    expect(p.picked).toEqual(['skill: statistical-analysis']);
    expect(hintNote(p)).toMatch(/skill_read/);
    expect(plan('what should I eat before a game').picked).toEqual([]);
  });

  it('sends a many-step look-up on one site to the browser agent - on Gemini only', () => {
    const p = plan('go to bestbuy.ca and compare all the gaming headsets under $100');
    expect(p).toMatchObject({ specialist: 'argus', picked: ['browser agent'] });
    expect(plan('go to bestbuy.ca and compare all the gaming headsets under $100', false).picked).toEqual([]);
    expect(plan('build a page on jsfiddle.net that compares two colours').picked).toEqual([]);
  });

  it('adds nothing to ordinary requests', () => {
    expect(hintNote(plan('hey, how are you?'))).toBe('');
    expect(hintNote(plan('add a task to pack my soccer bag'))).toBe('');
  });
});

describe('Spotify on this PC (Spotify Free)', () => {
  const sp = (text: string, spotifyLocal = true) => planAddons(text, { gemini: true, skills, spotifyLocal });
  it('uses the desktop app for playing, pausing, skipping and "what is playing"', () => {
    for (const ask of ['play travis scott on spotify', 'pause the music', 'skip this song', "what's playing?", 'go back to the last song']) {
      expect(sp(ask).picked, ask).toContain('Spotify (this PC)');
    }
    expect(hintNote(sp('play lofi on spotify'))).toMatch(/call open with it.*never call play after open/);
  });

  it('not when Spotify is a connected app, and not for YouTube', () => {
    expect(sp('play travis scott on spotify', false).picked).toEqual([]);
    expect(sp('pause the youtube video').picked).not.toContain('Spotify (this PC)');
    expect(sp('what should I eat before a game').picked).toEqual([]);
  });
});

describe('lateral thinking (danium/lateral-thinking), picked without being asked', () => {
  const loops: Record<string, string> = { 'six-hats': 'Take the decision through six unblended passes.', 'random-stimulus': 'Pick 8-12 random unrelated things.', 'worst-idea': 'Design 5-8 terrible solutions.', scamper: 'Run the idea through SCAMPER.', provocation: 'State 4-6 deliberately wrong assertions.' };
  const lat = (text: string, gemini = true) => planAddons(text, { gemini, skills, lateral: (t) => loops[t] ?? null, maths: /\d+\s*[+*/x-]\s*\d+|how many|average/i.test(text) });

  it('picks the technique that fits how the operator is stuck', () => {
    expect(lat('I need ideas for my history fair project on the Mongols').picked).toEqual(['lateral thinking: random-stimulus']);
    expect(lat('should I join the Division 2 team or stay with my friends in Division 3? help me decide').picked).toEqual(['lateral thinking: six-hats']);
    expect(lat('my business ideas all feel so safe and boring, I need something different').picked).toEqual(['lateral thinking: worst-idea']);
    expect(lat("I'm stuck - we only have 20 dollars for the club fundraiser, what can we do").picked).toEqual(['lateral thinking: provocation']);
    expect(lat('help me come up with versions of my idea for a study app').picked).toEqual(['lateral thinking: scamper']);
  });

  it('on Gemini reads the whole technique; on the local model gets it condensed in the note', () => {
    expect(hintNote(lat('brainstorm names for my YouTube history channel'))).toMatch(/skill_read \(name "random-stimulus"\)/);
    const local = hintNote(lat('brainstorm names for my YouTube history channel', false));
    expect(local).toMatch(/random-stimulus": Pick 8-12 random unrelated things\./);
    expect(local).not.toMatch(/skill_read/);
    expect(local).toMatch(/show the ideas that went nowhere/);
  });

  it('drafts a social post but never posts it', () => {
    const p = lat('write a tweet about my team winning the tournament');
    expect(p.picked).toEqual(['lateral thinking: post']);
    expect(hintNote(p)).toMatch(/Drafts only - never post, send or publish/);
  });

  it('stays out of maths, look-ups and ordinary chat - and when it is not installed', () => {
    expect(lat('how many ideas can 3 people come up with if each has 4?').picked).toEqual([]);
    expect(lat("what's the weather tomorrow?").picked).toEqual([]);
    expect(lat('play some lofi music').picked).toEqual([]);
    expect(plan('I need ideas for my history fair project').picked).toEqual([]);
  });
});

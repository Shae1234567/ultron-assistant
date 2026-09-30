import type { AgentId } from './types';
import { asksContent, needsAction, buildsOnSite } from './intent';

/**
 * Picks the add-on that fits a request - so the operator never has to name
 * one ("use the browser agent", "use the transcript tool"): say what you want,
 * and the right open-source project gets used. Small models don't reliably reach for a tool described
 * only in their system prompt, but they do follow a note placed right next to
 * the task - so the choice is made here, in code, and spelled out there.
 */

export interface AddonPlan {
  /** Notes to put beside the task, one per add-on that fits. */
  hints: string[];
  /** A specialist to send the job straight to, when one add-on clearly owns it. */
  specialist?: AgentId;
  /** Short names for the HUD: "YouTube transcript", "browser agent"... */
  picked: string[];
}

export interface SkillMatch { name: string; description: string }

const YOUTUBE_LINK = /\b(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)\S*/i;
const VIDEO_TALK = /\b(youtube|video|vid|vlog|youtuber|lecture|ted talk|documentary|kurzgesagt|mrbeast|crash course|khan academy)\b/i;
const VIDEO_ASK = /\b(what|summari[sz]e|explain|learn|about|says?|said|talks? about|key points|main points|notes|takeaways|quote|according)\b/i;
const FEED = /\b(rss|atom feed|news feed|feed (url|link|address))\b|\S+\.(rss|atom)\b|\S+\/(feed|rss)(\/|\b)/i;
const SCIENCE = /\b(statistic\w*|t-?test|anova|regression|p-?value|standard deviation|variance|correlation|histogram|scatter ?plot|box ?plot|dataset|data set|experiment\w*|hypothes[ie]s|lab (report|protocol)|chemical|molecule\w*|reaction\w*|stoichiometr\w*|molar|dna|gene\w*|protein\w*|cells?|enzyme\w*|physics|velocity|acceleration|kinematic\w*|newton|momentum|scientific|literature review|research paper|peer review|citation\w*|biology|chemistry|ecolog\w*|photosynthesis|periodic table)\b/i;
// Many steps on ONE site: comparing, filtering, paging through, finding every / the cheapest.
const MANY_STEPS = /\b(compare|comparison|cheapest|lowest price|best (price|deal)|all (the )?(items|products|listings|results|options|courses|events)|go through|every (page|item|listing|option)|filter(ed)? by|sort(ed)? by|in stock|what('s| is) available|find (all|every)|list (all|every)|browse|dig through|across the site)\b/i;

// Lateral thinking (github.com/danium/lateral-thinking): being stuck, wanting ideas, weighing a decision, a social post.
const CREATIVE = /\b(brainstorm\w*|ideas? (for|about|to|on)|come up with|think of (some|a few|new|an?)|fresh (ideas?|angle|take)|(a )?different angle|(out|outside) (of )?the box|lateral thinking|i'?m stuck|we'?re stuck|i'?m out of ideas|going (round |around )?in circles|creative|names? (for|ideas)|slogans?|taglines?|business ideas?|project ideas?|(my|our) ideas|something (different|new|original|fresh)|what (should|could|can) i (build|make|create|start)|make (it|this|my \w+) (stand out|more (interesting|original|fun|creative)|less boring))\b/i;
const DECISION = /\b(help me decide|should i (do|pick|choose|go with|take|join|quit|switch|try out)|which (one )?should i (pick|choose|go with|do)|pros and cons|(weigh|think through) (up )?(the |this |my )?(decision|options|choice))\b/i;
const SOCIAL_POST = /\b(tweet|write (a |an )?(social|x|twitter|linkedin|instagram|bluesky|threads)? ?post|post (on|to|for) (x|twitter|linkedin|bluesky|threads|instagram)|reply to (this|his|her|their|a) (post|tweet))\b/i;

/** Which technique fits which symptom - the router skill's own decision table, in code. */
const LATERAL_TABLE: [RegExp, string][] = [
  [DECISION, 'six-hats'],
  [/\b(all (feel|look|sound|seem) the same|predictable|same old|repetitive)\b/i, 'random-stimulus'],
  [/\b(can'?t|cannot|impossible|no way to|not allowed|stuck with|constraint|only have)\b/i, 'provocation'],
  [/\b(assum\w+|everyone (thinks|does|says)|always been done)\b/i, 'inversion'],
  [/\b(wrong problem|what'?s the point|why (do|are) (we|i))\b/i, 'concept-fan'],
  [/\b(derivative|copy|like everyone else|generic|unoriginal)\b/i, 'analogy'],
  [/\b(my idea|one idea|variations?|versions? of|improve (my|this|the) (idea|plan|project|design))\b/i, 'scamper'],
  [/\b(safe|timid|boring|bland|cautious)\b/i, 'worst-idea'],
];

export function lateralTechnique(text: string): string {
  return LATERAL_TABLE.find(([re]) => re.test(text))?.[1] ?? 'random-stimulus';
}

// Music in the Spotify app on this PC (spotifyLocal.ts) - Spotify Free, so no connected Spotify app.
const SPOTIFY_ASK = /\bspotify\b|\b(pause|resume|stop|skip|next|previous|last|replay|restart) (this |the |that )?(song|track|music|tune)\b|\bwhat('s| is) (this |the )?song\b|\bwhat('s| is) playing\b|\bunpause\b/i;

/** Which add-ons fit this request. `skills` looks a request up in the science skills library, `lateral` gives a technique's condensed loop (both null/empty when not installed). `spotifyLocal`: the Spotify app is on this PC and Spotify is not a connected app. */
export function planAddons(text: string, opts: { gemini: boolean; skills?: (q: string) => SkillMatch[]; lateral?: (technique: string) => string | null; maths?: boolean; spotifyLocal?: boolean }): AddonPlan {
  const plan: AddonPlan = { hints: [], picked: [] };
  const t = text.trim();

  // A video: read what it says (Agent-Reach's YouTube channel), don't just play it. Not the operator's own
  // channel ("ideas for a name for my history YouTube channel" picked the transcript reader in a live check, 30 Sep).
  const ownChannel = /\b(my|our|a new|start(ing)? a) (\w+ ){0,3}(youtube )?channel\b/i.test(t);
  if (YOUTUBE_LINK.test(t) || (VIDEO_TALK.test(t) && !ownChannel && (VIDEO_ASK.test(t) || asksContent(t)) && !/\b(play|put on|listen to)\b/i.test(t))) {
    plan.hints.push('This is about what a video says: read it with youtube_transcript (a link, or a search like "kurzgesagt black holes"), give it a focus, and answer only from the transcript. play_on_youtube only plays a video - it reads nothing.');
    plan.picked.push('YouTube transcript');
  }

  // A feed: read it (Agent-Reach's RSS channel).
  if (FEED.test(t)) {
    plan.hints.push('There is an RSS/Atom feed here: read it with read_feed and answer from its entries.');
    plan.picked.push('RSS reader');
  }

  // A science or data job with a matching guide in the skills library.
  if (opts.skills && SCIENCE.test(t)) {
    const found = opts.skills(t).slice(0, 2);
    if (found.length) {
      plan.hints.push(`The scientific skills library has a guide for this: ${found.map((s) => `"${s.name}" (${s.description.slice(0, 140)})`).join('; ')}. Read the best one with skill_read and follow its method - work any numbers out with run_code.`);
      plan.picked.push(`skill: ${found[0].name}`);
    }
  }

  // Spotify on this PC: the operator has Spotify Free, so it is the desktop app, not a connected app.
  if (opts.spotifyLocal && SPOTIFY_ASK.test(t) && !/\b(youtube|video)\b/i.test(t)) {
    plan.hints.push('This is Spotify on this PC - use the spotify tool: now_playing, play (resume), pause, next, previous, or open with a query (a song, artist, album or playlist). For "play <something>", call open with it and tell the operator to press play on the one they want - never call play after open, it would resume the last song instead.');
    plan.picked.push('Spotify (this PC)');
  }

  // Creative thinking (lateral-thinking skills): stuck, ideas, a decision, a social post - never for maths or look-ups.
  const post = SOCIAL_POST.test(t);
  if (opts.lateral && !opts.maths && (post || CREATIVE.test(t) || DECISION.test(t))) {
    const technique = post ? 'post' : lateralTechnique(t);
    const loop = post ? null : opts.lateral(technique);
    const honest = 'Keep its honesty rules: show the ideas that went nowhere as abandoned, and leave the choice to the operator.';
    const draftOnly = post ? ' Drafts only - never post, send or publish anything; the operator does that.' : '';
    if (opts.gemini || !loop) {
      // Gemini can read the full technique (5-9k characters) and follow it.
      plan.hints.push(`This is creative thinking - use the lateral-thinking skill "${technique}": read it with skill_read (name "${technique}") and follow its steps yourself. When it says to read "../<name>/SKILL.md", call skill_read with that name. ${honest}${draftOnly}`);
    } else {
      // The local model sees ~2,800 characters of a tool result - hand it the condensed technique directly.
      plan.hints.push(`This is creative thinking - use the lateral-thinking technique "${technique}": ${loop} ${honest}`);
    }
    plan.picked.push(`lateral thinking: ${technique}`);
  }

  // A long look-up on one website: the autonomous browser agent (browser-use), which works best on Gemini.
  if (opts.gemini && needsAction(t) && MANY_STEPS.test(t) && !buildsOnSite(t)) {
    plan.hints.push('This is a many-step job on one website: hand it to browser_agent with the site\'s start address and the full task - it works through the pages and reports back.');
    plan.specialist = 'argus';
    plan.picked.push('browser agent');
  }
  return plan;
}

/** The hints as one note to put under a task. */
export function hintNote(plan: AddonPlan): string {
  return plan.hints.length ? `\n\n[ADD-ONS - use them, the operator should not have to ask] ${plan.hints.join(' ')}` : '';
}

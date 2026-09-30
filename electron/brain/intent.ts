/**
 * "Open codepen.io/pen and build a page there" has to be DONE - and in
 * testing the lead once answered it in four seconds, in words, by retelling
 * a similar run from memory. These spot requests to act on a website, so a
 * reply with no tool behind it can be caught.
 */

const VERB = /\b(open|go to|visit|build|make|create|draw|design|fill( in| out)?|post|type|edit|write|add|set up|check|look up|find|search|research|download|upload|send|reply|read|sign up)\b/i;
const DOMAIN = /\b[a-z0-9-]+\.(com|org|net|io|dev|app|ai|co|ca|edu|gov|me|tv|gg|xyz)\b/i;
const SITES = 'codepen|jsfiddle|playcode|onecompiler|w3schools|replit|canva|figma|excalidraw|notion|google (docs|slides|sheets|drive|forms)|github|reddit|youtube|discord|spotify|wikipedia|d2l|brightspace|gmail|outlook|a website|the website|the site|the browser|my browser';
const ON_SITE = new RegExp(`\\b(on|in|at|into|to|using|from)\\s+(the\\s+)?(${SITES})\\b`, 'i');
const BUILD = /\b(build|make|create|draw|design|fill( in| out)?|post|type|edit|write|add|set up)\b/i;

const PAGE_ADDRESS = /\bhttps?:\/\/[^\s<>"']+/i;
const READ_ASK = /\b(read|check|look (at|through|over)|go through|what does|what's on|whats on|tell me|summari[sz]e|find|when is|when are|how many|according to)\b/i;

/**
 * "Check the calendar at http://.../school-calendar.html - when is the science fair?" - a page to read, which
 * is Argus's job. The site-name checks above miss bare addresses (an IP, localhost, a school intranet), and in
 * an evaluation (29 Sep 2026) the lead then tried to fetch the page from the code sandbox, which has no internet.
 */
export function readsPage(text: string): boolean {
  return PAGE_ADDRESS.test(text) && READ_ASK.test(text);
}

const CONTENT_ASK = /\b(what (does|did|do) .{1,80}\b(say|says|mention|mentions|cover|covers|explain|explains)\b|one (specific |interesting )?thing .{0,60}\b(says|said|mentions)\b|tell me what .{0,80}\b(says|said)\b|summari[sz]e|transcript|according to (the|this|that|it)|what'?s (in|on) (the|this|that) (video|page|feed|article|guide|doc))/i;

/**
 * "Tell me one thing the narrator says in the Kurzgesagt video" - a question about what something SAYS, which only
 * reading it can answer. In a live check (29 Sep 2026) the lead played the video on the operator's screen and then
 * wrote a quote "based on their typical style".
 */
export function asksContent(text: string): boolean {
  return CONTENT_ASK.test(text);
}

/** Asks Ultron to act on a website or web app (not just talk about one). */
export function needsAction(text: string): boolean {
  return VERB.test(text) && (DOMAIN.test(text) || ON_SITE.test(text));
}

/** ...and specifically to make or change something there - Daedalus's job. */
export function buildsOnSite(text: string): boolean {
  return needsAction(text) && BUILD.test(text);
}

/* The everyday names of apps the operator connects through Composio, by toolkit slug. */
const APP_NAMES: [RegExp, string][] = [
  [/\bgoogle docs?\b|\bg-?docs?\b|\ba doc\b|\bthe docs?\b/i, 'googledocs'],
  [/\bgoogle sheets?\b|\bspreadsheets?\b/i, 'googlesheets'],
  [/\bgoogle slides?\b|\bslide ?(deck|show)s?\b|\bpresentations?\b/i, 'googleslides'],
  [/\bgmail\b|\be-?mails?\b|\binbox\b/i, 'gmail'],
  [/\bcalendar\b|\bmeeting invites?\b/i, 'googlecalendar'],
  [/\bgoogle drive\b|\bmy drive\b/i, 'googledrive'],
  [/\bgoogle tasks\b/i, 'googletasks'],
  [/\b(google )?classroom\b/i, 'google_classroom'],
  [/\bgoogle meet\b|\bmeet link\b/i, 'googlemeet'],
  [/\bgoogle photos\b/i, 'googlephotos'],
  [/\bnotion\b/i, 'notion'],
  [/\bcanva\b/i, 'canva'],
  [/\bfigma\b/i, 'figma'],
  [/\bgithub\b/i, 'github'],
  [/\bdiscord\b/i, 'discord'],
  [/\bspotify\b/i, 'spotify'],
  [/\btwitch\b/i, 'twitch'],
  [/\b(instagram|insta)\b|\bmy ig\b|\bon ig\b/i, 'instagram'],
  [/\btik ?toks?\b/i, 'tiktok'],
];
const GOOGLE_APPS = new Set(['googledocs', 'googlesheets', 'googleslides', 'gmail', 'googlecalendar', 'googledrive', 'googletasks', 'google_classroom', 'googlemeet', 'googlephotos']);
// "email Coach Ryan that..." - the app's name used as the verb counts too, when it opens the request.
const APP_ACTION = /\b(create|make|write|draft|add|put|insert|fill|edit|update|change|send|reply|forward|schedule|book|invite|share|upload|save|copy|move|rename|delete|remove|post|comment|archive|label|build|design|set up|kick|ban|unban|mute|timeout|time out|manage|organi[sz]e)\b|^\s*(please\s+|can you\s+|could you\s+)?(e-?mail|message|dm|text)\s/i;

/** The connected app a request is about ("make a Google Doc", "email Sam") - null when that app isn't connected. */
export function connectedAppIn(text: string, apps: string[]): string | null {
  for (const [re, slug] of APP_NAMES) {
    if (!re.test(text)) continue;
    // "googlesuper" covers every Google app; Discord can come through the bot toolkit.
    if (apps.includes(slug) || (GOOGLE_APPS.has(slug) && apps.includes('googlesuper')) || (slug === 'discord' && apps.includes('discordbot'))) return slug;
  }
  return null;
}

/**
 * Making or changing something IN a connected app - Hermes's job, through the
 * app itself. In testing, "Create a Google Doc yourself" went to the browser
 * builder, who would have needed a Google login in its own browser; the doc
 * was never made and Ultron said its tools "cannot write files".
 */
export function actsInApp(text: string, apps: string[]): string | null {
  const slug = connectedAppIn(text, apps);
  return slug && APP_ACTION.test(text) ? slug : null;
}

const OWN = /\b(my|mine|i have|i've got|do i|did i|have i|am i)\b/i;

/**
 * Anything done with, or asked about, the operator's OWN connected-app data -
 * "make a Google Doc", but also "how many unread emails do I have?". In a
 * live test the lead answered that one itself from memory, with no number.
 */
export function usesApp(text: string, apps: string[]): string | null {
  const slug = connectedAppIn(text, apps);
  return slug && (APP_ACTION.test(text) || OWN.test(text)) ? slug : null;
}

const PC_THINGS = /\b(downloads|desktop|documents folder|pictures|videos folder|music folder|files?|folders?|pc|computer|laptop|hard drive|disk space|storage)\b/i;

/**
 * A question or job about the operator's OWN computer - Hephaestus's. In a
 * live test the lead answered "how many files are in my Downloads folder?"
 * itself, with no number. Checked after usesApp, so "files in my Google
 * Drive" still goes to the app.
 */
export function usesPc(text: string): boolean {
  return OWN.test(text) && PC_THINGS.test(text);
}

/* Worth full reasoning: maths and logic, "why" and "how does it work", comparisons, plans and
   strategies, code, writing that argues something, and anything long enough to be a real problem. */
const HARD = /\b(why|explain|prove|solve|calculate|work out|figure out|compare|comparison|analy[sz]e|evaluate|assess|strateg(y|ies|i[sz]e)|design|debug|optimi[sz]e|essay|argue|argument|pros and cons|trade-?offs?|step by step|equations?|formula|derivative|integral|probability|puzzle|riddle|logic|algorithm|should i|what would happen|what if|best way|how (does|do|did|would|could) .{3,60} work)\b/i;

/** A question that deserves the model's full reasoning (not small talk or a quick lookup). */
export function thinksHard(text: string): boolean {
  const t = text.trim();
  if (t.length > 300) return true;
  if (/\d\s*[-+*/^=×÷]\s*\(?\d/.test(t) && t.length > 25) return true;
  return HARD.test(t);
}

/** ...and hard enough to be worth the strongest, slower model (a substantial problem, not a one-liner). */
export function thinksDeep(text: string): boolean {
  return thinksHard(text) && text.trim().length >= 90;
}

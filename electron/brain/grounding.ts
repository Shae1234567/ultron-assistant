/**
 * The last line of defence against invented links. Models - small local ones
 * especially - "complete" an answer with plausible URLs (a Hacker News item
 * ID from 2017, a repo that doesn't exist). Every link in Ultron's final
 * answer must be one the team actually saw: in a report, on a page it opened,
 * or in search results. Anything else is removed and marked.
 */

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

export function linkKey(url: string): string {
  return url
    .replace(/[.,;:!?*]+$/, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '')
    .replace(/^https?:\/\/(www\.)?/i, '')
    .toLowerCase();
}

/**
 * A deep link carrying a long document/post ID that nobody supplied. Models
 * invent these ("docs.google.com/document/d/1BxiMVs0XR..." - a real attempt to
 * open a doc that was never created). Plain site addresses are fine.
 */
export function looksInvented(url: string, known: Set<string>): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  return (path.match(/[A-Za-z0-9_-]{16,}/g) ?? []).some(idLike) && !known.has(linkKey(url));
}

/** Document/post IDs in a piece of text (tool output, a link). */
export function idsIn(text: string): string[] {
  return (text.match(/[A-Za-z0-9_-]{16,}/g) ?? []).filter(idLike);
}

/* Random-looking: IDs flip between digits, capitals and lowercase all the time ("1BxiMVs0XRAqNtWg",
   "3bdd8578b19e80af"); page names ("World_War_II_casualties_1939") hardly ever do. */
function idLike(run: string): boolean {
  const s = run.replace(/[_-]/g, '');
  if (s.length < 16) return false;
  const kind = (c: string) => (/\d/.test(c) ? 0 : c === c.toUpperCase() ? 1 : 2);
  let changes = 0;
  for (let i = 1; i < s.length; i++) if (kind(s[i]) !== kind(s[i - 1])) changes++;
  return changes / s.length >= 0.3;
}

export function linksIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?*]+$/, ''));
}

/** Addresses in the operator's own words - "codepen.io/pen" counts as much as https://codepen.io/pen. */
export function addressesIn(text: string): string[] {
  const bare = (text.match(/(?<![@\w./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`)\]]*)?/gi) ?? []).map((u) => u.replace(/[.,;:!?*]+$/, ''));
  return [...linksIn(text), ...bare];
}

/**
 * "All six links are ready for you in your browser tabs" - the agents browse
 * in Ultron's own tabs, which close when the task ends, so unless Ultron
 * actually opened something on the operator's screen, that sentence is false.
 * Trailing clauses are cut; sentences that are nothing but the claim go.
 */
const TAB_CLAIM = /\b(opened|open|ready|waiting|pulled up|loaded)\b[^.!?\n]*\b(in|on)\s+(your|the operator's)\s+(own\s+)?(browser|tabs?)\b|\b(browser\s+)?tabs\b[^.!?\n]*\b(for you|for your review|to review)\b|\b(for|in|into) your (own )?(browser )?tabs\b/i;

export function withoutTabClaims(text: string): string {
  const pieces = text.split(/(?<=[.!?])(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const sentence = pieces[i];
    const gap = pieces[i + 1] ?? '';
    if (!TAB_CLAIM.test(sentence)) { out.push(sentence + gap); continue; }
    // "Here are the top three, all opened in your browser tabs for review." -> keep what comes before the claim
    const cut = sentence.search(/,\s*(all\s+|and\s+|now\s+)?(opened|open|ready|waiting|loaded)\b/i);
    if (cut > 20) out.push(`${sentence.slice(0, cut).trimEnd()}.${gap}`);
    else if (/\n/.test(gap)) out.push(gap);
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** A report made fit to say out loud: no headings, bullets, bold or code marks. */
export function plainSpoken(text: string): string {
  return text
    .replace(/^\s*(\*\*|__)?REPORT(\*\*|__)?:?[ \t]*/gim, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*([-*\u2022]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export interface TitledLink { title: string; url: string }

/** Links with their titles in tool output: "Title -> https://..." lines and {title|text, url} objects. */
export function titledLinksIn(text: string): TitledLink[] {
  const out: TitledLink[] = [];
  // Tool output arrives as JSON - undo its escaped line breaks so "\nTitle -> url" doesn't read as "nTitle".
  const plain = text.replace(/\\[nrt]/g, '\n');
  for (const m of plain.matchAll(/([^\n"\\>]{8,160}?) -> (https?:\/\/[^\s"\\]+)/g)) out.push({ title: m[1].trim(), url: m[2] });
  for (const m of text.matchAll(/"(?:title|text)":"([^"\\]{8,200})","url":"(https?:[^"\\]+)"/g)) out.push({ title: m[1], url: m[2] });
  return out;
}

const STOP = new Set(['this', 'that', 'with', 'from', 'your', 'about', 'what', 'their', 'there', 'which', 'have', 'into', 'more', 'most', 'just', 'than', 'then', 'they', 'were', 'will', 'link', 'links', 'here', 'post', 'story', 'top', 'the', 'and', 'for']);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** The real link a sentence is talking about - the seen title sharing the most words with it (at least two). */
function bestMatch(context: string, titled: TitledLink[], used: Set<string>): string | null {
  const ctx = words(context);
  let best: { url: string; score: number } | null = null;
  for (const t of titled) {
    if (used.has(linkKey(t.url))) continue;
    let score = 0;
    for (const w of words(t.title)) if (ctx.has(w)) score++;
    if (score >= 2 && (!best || score > best.score)) best = { url: t.url, score };
  }
  return best?.url ?? null;
}

/**
 * Keeps links the team saw and drops invented ones. When an invented link
 * sits next to a story the team really did see ("the Ollaya project: <made-up
 * item link>"), the real link for that story takes its place.
 */
export function verifyLinks(answer: string, known: Iterable<string>, titled: TitledLink[] = [], knownIds: ReadonlySet<string> = new Set()): { text: string; removed: string[]; repaired: number } {
  const ok = new Set<string>();
  for (const k of known) ok.add(linkKey(k));
  const used = new Set<string>((answer.match(URL_RE) ?? []).map(linkKey).filter((k) => ok.has(k)));
  const removed: string[] = [];
  let repaired = 0;
  const text = answer.replace(URL_RE, (raw: string, offset: number, whole: string) => {
    const url = raw.replace(/[.,;:!?*]+$/, '');
    const tail = raw.slice(url.length);
    if (ok.has(linkKey(url))) return raw;
    // A tool returned this document's ID ("documentId": "1b64...") and the answer built the address around it.
    if (idsIn(url).some((id) => knownIds.has(id))) return raw;
    removed.push(url);
    // The words just before the link, back to the previous link or line break, name what it was meant to be.
    const before = whole.slice(Math.max(0, offset - 160), offset).split(/https?:\/\/\S+|\n/).pop() ?? '';
    const real = bestMatch(before, titled, used);
    if (real) {
      used.add(linkKey(real));
      repaired++;
      return `${real}${tail}`;
    }
    return `[unverified link removed]${tail}`;
  });
  return { text, removed, repaired };
}

/**
 * "Give me its title and link" - and the answer named the story but dropped the
 * link (live test, 27 Sep 2026). When the operator asked for links and the
 * answer has none, add the real link the team saw for what it names.
 */
export function withAskedLink(question: string, answer: string, titled: TitledLink[]): string {
  if (!/\b(links?|urls?)\b/i.test(question) || new RegExp(URL_RE.source).test(answer)) return answer;
  const url = bestMatch(answer, titled, new Set());
  return url ? `${answer.trimEnd()}\n${url}` : answer;
}

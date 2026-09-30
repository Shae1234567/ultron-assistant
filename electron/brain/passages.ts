import MiniSearch from 'minisearch';

/**
 * The parts of a long page that are about the question. Pages used to be cut
 * at their first 5,000-9,000 characters, so an answer further down was never
 * seen (in a test page, the tryout-results date sat at character 5,510). Like
 * the BM25 content filters in GPT Researcher and Crawl4AI, the page is split
 * into passages and ranked against the question - with MiniSearch
 * (github.com/lucaong/minisearch), a small full-text engine with BM25-style
 * scoring - and the best passages are kept, in page order, within the budget.
 */

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'been', 'what', 'when',
  'who', 'how', 'why', 'which', 'that', 'this', 'it', 'its', 'with', 'as', 'at', 'by', 'from', 'do', 'does', 'did', 'i',
  'my', 'me', 'you', 'your', 'will', 'can', 'about', 'there', 'their', 'they', 'has', 'have', 'had', 'not', 'but',
]);

const term = (t: string): string | null => {
  const w = t.toLowerCase();
  return w.length < 2 || STOP.has(w) ? null : w;
};

/** Passages of roughly `target` characters, on paragraph and then sentence boundaries. */
export function splitPassages(text: string, target = 700): string[] {
  const out: string[] = [];
  let carry = '';
  for (const para of text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)) {
    const pieces = para.length > target * 1.6
      ? para.split(/(?<=[.!?])\s+/).reduce<string[]>((acc, sentence) => {
        const last = acc[acc.length - 1];
        if (last !== undefined && last.length + sentence.length < target) acc[acc.length - 1] = `${last} ${sentence}`;
        else acc.push(sentence);
        return acc;
      }, [])
      : [para];
    for (const piece of pieces) {
      // Headings and one-liners ride along with what follows them.
      if (piece.length < 120) { carry = carry ? `${carry}\n${piece}` : piece; continue; }
      out.push(carry ? `${carry}\n${piece}` : piece);
      carry = '';
    }
  }
  if (carry) out.push(carry);
  return out;
}

export interface Focused { text: string; focused: boolean; kept: number; total: number }

/**
 * A page cut down to `maxChars`: its opening (title, date, intro) plus the
 * passages that best match the query, in page order, with "[...]" where parts
 * were left out. A page that already fits, or that nothing in the query
 * matches, comes back as before (the start of the page).
 */
export function focusText(text: string, query: string, maxChars: number, keepLead = 600): Focused {
  if (text.length <= maxChars) return { text, focused: false, kept: 1, total: 1 };
  const passages = splitPassages(text);
  const cut = { text: text.slice(0, maxChars), focused: false, kept: 0, total: passages.length };
  if (passages.length < 3) return cut;
  const ms = new MiniSearch<{ id: number; text: string }>({ fields: ['text'], processTerm: term });
  ms.addAll(passages.map((p, id) => ({ id, text: p })));
  const hits = ms.search(query, { fuzzy: 0.15, prefix: true, combineWith: 'OR' });
  if (!hits.length) return cut;

  const chosen = new Set<number>();
  let used = 0;
  // The opening keeps what the page is and when it was written.
  for (let i = 0; i < passages.length && used < keepLead; i++) {
    chosen.add(i);
    used += passages[i].length;
  }
  for (const h of hits) {
    const id = Number(h.id);
    if (chosen.has(id)) continue;
    if (used + passages[id].length > maxChars) continue;
    chosen.add(id);
    used += passages[id].length;
    if (used >= maxChars * 0.95) break;
  }
  const order = [...chosen].sort((a, b) => a - b);
  const parts: string[] = [];
  order.forEach((id, i) => {
    if (i > 0 && id !== order[i - 1] + 1) parts.push('[...]');
    parts.push(passages[id]);
  });
  return { text: parts.join('\n\n'), focused: true, kept: order.length, total: passages.length };
}

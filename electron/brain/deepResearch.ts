import { chat, chatJson, preferredProvider } from './llm';
import { cloud } from './types';
import { readPage, webSearch, type WebSearchResult } from '../browser';
import { isoDate, safeName, writeNote } from '../memory/vault';
import { syncIndex } from '../memory/semantic';
import { workflow } from './workflow';
import { deepResearch2 } from './research2';

/**
 * Multi-source research: plan searches, gather and read the best pages in
 * parallel, then write a brief with numbered citations. Every report is
 * saved to the vault's Research/ folder so the work is never lost.
 */

export type Depth = 'quick' | 'standard' | 'deep';

export interface Source { n: number; title: string; url: string; text: string }

export interface DeepResearchResult {
  ok: boolean;
  report: string;
  sources: { n: number; title: string; url: string; published?: string }[];
  notePath?: string;
  error?: string;
  /** What was checked (workflow v2): "7 of 8 cited statements found in their sources; ..." */
  verification?: string;
}

export const SIZES: Record<Depth, { queries: number; sources: number }> = {
  quick: { queries: 3, sources: 4 },
  standard: { queries: 5, sources: 7 },
  deep: { queries: 6, sources: 10 },
};

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) url.searchParams.delete(k);
    return url.href.replace(/\/$/, '');
  } catch {
    return u;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function planQueries(question: string, count: number, signal?: AbortSignal, avoid: string[] = []): Promise<string[]> {
  const res = await chatJson<{ queries?: string[] }>({
    system: [
      'You plan web searches for a research question.',
      `Today is ${isoDate()}. Prefer queries that surface current, authoritative sources.`,
      `Return JSON {"queries": [...]} with ${count} distinct search-engine queries that together cover the question from different angles.`,
      avoid.length ? `Do not repeat these already-run queries: ${avoid.join(' | ')}` : '',
    ].filter(Boolean).join('\n'),
    messages: [{ role: 'user', content: question }],
    temperature: 0.3,
    signal,
  }).catch(() => null);
  const qs = (res?.queries ?? []).filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim());
  return qs.length ? qs.slice(0, count) : [question];
}

export async function gather(
  queries: string[],
  maxSources: number,
  seen: Set<string>,
  perDomain: Map<string, number>,
  progress?: (msg: string) => void,
): Promise<WebSearchResult[]> {
  const batches = await mapLimit(queries, 2, async (q) => {
    progress?.(`searching: ${q}`);
    const r = await webSearch(q, 8);
    return r.ok ? r.results : [];
  });
  const picked: WebSearchResult[] = [];
  // Round-robin across queries so one query's results don't crowd out the rest.
  for (let rank = 0; rank < 8 && picked.length < maxSources; rank++) {
    for (const batch of batches) {
      const r = batch[rank];
      if (!r || picked.length >= maxSources) continue;
      const url = normalizeUrl(r.url);
      if (seen.has(url) || !/^https?:/.test(url)) continue;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
      if ((perDomain.get(host) ?? 0) >= 2) continue;
      seen.add(url);
      perDomain.set(host, (perDomain.get(host) ?? 0) + 1);
      picked.push({ ...r, url });
    }
  }
  return picked;
}

async function readAll(results: WebSearchResult[], startN: number, maxChars: number, progress?: (msg: string) => void): Promise<Source[]> {
  const pages = await mapLimit(results, 3, async (r) => {
    progress?.(`reading: ${r.title.slice(0, 70)}`);
    const page = await readPage(r.url, maxChars);
    return { r, page };
  });
  const sources: Source[] = [];
  for (const { r, page } of pages) {
    const text = page.ok && page.text && page.text.length > 300 ? page.text : r.snippet;
    if (!text || text.length < 80) continue;
    sources.push({ n: startN + sources.length, title: page.title || r.title, url: page.url || r.url, text });
  }
  return sources;
}

async function condense(question: string, s: Source, signal?: AbortSignal): Promise<Source> {
  const res = await chat({
    system: 'Extract only the facts, figures, dates and claims from this page that help answer the question. Up to 12 terse bullet points. If nothing is relevant, reply "irrelevant".',
    messages: [{ role: 'user', content: `QUESTION: ${question}\n\nPAGE: ${s.title}\n${s.text}` }],
    temperature: 0.1,
    effort: 'low',
    signal,
  }).catch(() => null);
  return { ...s, text: res?.text && !/^irrelevant/i.test(res.text) ? res.text : '' };
}

async function synthesize(question: string, sources: Source[], signal?: AbortSignal): Promise<string> {
  const corpus = sources
    .filter((s) => s.text)
    .map((s) => `[${s.n}] ${s.title}\n${s.url}\n${s.text}`)
    .join('\n\n---\n\n');
  const res = await chat({
    system: [
      'You are Argus, the research specialist on a personal AI team. Write a research brief that answers the question',
      'using ONLY the numbered sources provided. Cite every claim inline with [n]. Structure in markdown:',
      '## Bottom line (2-4 sentences)',
      '## Key findings (bullets, specific numbers/dates/names)',
      '## Details (short sections as needed)',
      '## Gaps and disagreements (where sources conflict, are thin, or may be out of date)',
      'Be precise and concrete. If the sources do not answer something, say so plainly instead of filling the gap.',
      `Today is ${isoDate()}.`,
    ].join('\n'),
    messages: [{ role: 'user', content: `QUESTION: ${question}\n\nSOURCES:\n\n${corpus}` }],
    temperature: 0.3,
    // Weighing sources against each other is the hard part of research - full reasoning here.
    effort: 'high',
    signal,
  });
  return res.text;
}

export async function deepResearch(
  question: string,
  opts: { depth?: Depth; signal?: AbortSignal; progress?: (msg: string) => void } = {},
): Promise<DeepResearchResult> {
  // v2 (perspectives, follow-ups, dated sources, citation check) - v1 below stays for comparison and rollback.
  if (workflow().research2) return deepResearch2(question, opts);
  const depth = opts.depth ?? 'standard';
  const size = SIZES[depth];
  try {
    const provider = await preferredProvider('main');
    const local = !cloud(provider);
    const maxChars = local ? 5000 : 9000;
    const seen = new Set<string>();
    const perDomain = new Map<string, number>();

    const queries = await planQueries(question, size.queries, opts.signal);
    const results = await gather(queries, size.sources, seen, perDomain, opts.progress);
    if (!results.length) return { ok: false, report: '', sources: [], error: 'Search returned nothing usable.' };
    let sources = await readAll(results, 1, maxChars, opts.progress);

    if (depth === 'deep' && sources.length) {
      opts.progress?.('checking for gaps');
      const gapsRes = await chatJson<{ queries?: string[] }>({
        system: `Given a question and what has been found so far, return JSON {"queries": [...]} with up to 3 NEW search queries that would fill the most important gaps. Today is ${isoDate()}.`,
        messages: [{ role: 'user', content: `QUESTION: ${question}\n\nFOUND SO FAR:\n${sources.map((s) => `- ${s.title}: ${s.text.slice(0, 300)}`).join('\n')}` }],
        temperature: 0.3,
        signal: opts.signal,
      }).catch(() => null);
      const more = (gapsRes?.queries ?? []).filter((q) => typeof q === 'string').slice(0, 3);
      if (more.length) {
        const extra = await gather(more, 4, seen, perDomain, opts.progress);
        sources = sources.concat(await readAll(extra, sources.length + 1, maxChars, opts.progress));
      }
    }

    if (local) {
      // A small local model can't hold every page at once - boil each down first.
      opts.progress?.('condensing sources');
      sources = await mapLimit(sources, 2, (s) => condense(question, s, opts.signal));
    }
    const usable = sources.filter((s) => s.text);
    if (!usable.length) return { ok: false, report: '', sources: [], error: 'Could not read any of the sources found.' };

    opts.progress?.('writing the brief');
    const body = await synthesize(question, usable, opts.signal);
    const list = usable.map((s) => ({ n: s.n, title: s.title, url: s.url }));
    const title = safeName(question.replace(/[?]+$/, '').slice(0, 70));
    const rel = `Research/${isoDate()} ${title}.md`;
    const note = [
      '---',
      'type: research',
      `created: ${new Date().toISOString()}`,
      `depth: ${depth}`,
      'tags: [ultron/research]',
      '---',
      `# ${question.trim()}`,
      '',
      body.trim(),
      '',
      '## Sources',
      ...list.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`),
      '',
    ].join('\n');
    try {
      writeNote(rel, note);
      void syncIndex([rel]).catch(() => {});
    } catch { /* the report still goes back to the team even if the vault is unwritable */ }
    return { ok: true, report: body, sources: list, notePath: rel };
  } catch (e) {
    return { ok: false, report: '', sources: [], error: e instanceof Error ? e.message : String(e) };
  }
}

import { evaluate } from '../calculator';

/**
 * Checks that run before a result is shown - deterministic ones, in code,
 * because the model that wrote an answer is the worst judge of it. Found in
 * testing (28 Sep 2026): asked for a quiz average, the local model answered
 * "82.5, so you need 76", then "wait, that's not right" and recomputed in the
 * same reply - maths done in its head, never with a tool.
 */

/* ── Maths ─────────────────────────────────────────────────────────── */

const QUANT = /\b(t-?test|statistic\w*|significan\w*|standard deviation|variance|correlation|regression|probability|average|mean|median|total|sum|percent(age)?|how (much|many|long|far)|need (on|to get|to score)|per (hour|day|week|month|year|km|kg|person)|ratio|convert|interest|discount|tax|tip|split|each|times|multiply|divide|equation|solve|calculate|work out|score|days? (until|between|from|left)|cost|price|budget|save|saving|profit|speed|distance)\b|%|\d\s*[-+*/×÷^=]\s*\d/i;

/**
 * A request whose answer is a number someone has to work out - the kind small models get wrong in their heads.
 * Numbers inside web addresses and labels ("U15", "Grade 9", "3v3") don't count: "how many substitutes can a
 * U15 team dress, per http://127.0.0.1:65184/rules" is a lookup, and treating it as maths sent the answer back
 * to be "computed" - and the reply to that replaced the answer (evaluation, 29 Sep 2026).
 */
export function isMathAsk(text: string): boolean {
  const plainText = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[a-z]+\d+[a-z\d]*\b/gi, ' ')
    .replace(/\b(grade|tier|level|u|under|room|route|bus|week|chapter|unit|page|version|v)\s*\d+\b/gi, ' ');
  const numbers = plainText.match(/\d+(?:[.,:]\d+)?/g) ?? [];
  if (numbers.length >= 2 && QUANT.test(plainText)) return true;
  // One number to convert ("105 metres in feet", "72 degrees Fahrenheit in Celsius") is maths too.
  return numbers.length === 1 && CONVERT.test(plainText);
}

const CONVERT = /\bconvert\b|\b(in|to|into)\s+(feet|foot|ft|miles?|km|kilomet(re|er)s?|met(re|er)s?|cm|centimet(re|er)s?|inch(es)?|pounds|lbs?|kg|kilograms?|grams?|celsius|fahrenheit|hours?|minutes?|seconds?|litres?|liters?|gallons?|cups|yards?)\b/i;

export const COMPUTE_FIRST = '[VERIFY] This answer depends on numbers you worked out in your head. Compute them with run_code (or calculate for one expression) now, then answer from the tool\'s result.';

/** Model maths notation -> plain arithmetic the checker can evaluate. */
function plain(text: string): string {
  let t = text
    .replace(/\\left|\\right/g, '')
    .replace(/\\times|\\cdot|[×·✕]/g, '*')
    .replace(/\\div|÷/g, '/')
    .replace(/[−–]/g, '-')
    .replace(/\*\*/g, '')
    .replace(/\$/g, '');
  // 1,200 -> 1200 (twice, for 1,200,000)
  for (let i = 0; i < 2; i++) t = t.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  return t;
}

export interface WrongStep { shown: string; stated: number; actual: number }
export interface EquationCheck { checked: number; wrong: WrongStep[] }

function decimals(s: string): number {
  const m = /\.(\d+)\s*$/.exec(s.trim());
  return m ? m[1].length : 0;
}

/**
 * Every worked equation in a text ("320 / 4 = 80", "(78 + 91) / 2 = 84.5 = ...")
 * is recomputed. A rounded result counts as right when it is right to the
 * decimals shown.
 */
export function checkEquations(text: string): EquationCheck {
  const src = plain(text);
  const chains = src.match(/[\d(][\d\s.+\-*/^()]*(?:=[\d\s.+\-*/^()]*\d\)?)+/g) ?? [];
  const wrong: WrongStep[] = [];
  let checked = 0;
  for (const chain of chains) {
    const parts = chain.split('=').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || !parts.some((p) => /\d\s*[-+*/^]\s*[\d(]/.test(p))) continue;
    const values = parts.map((p) => evaluate(p));
    if (values.some((v) => !v.ok)) continue;
    checked++;
    for (let i = 0; i + 1 < parts.length; i++) {
      const a = values[i].result!;
      const b = values[i + 1].result!;
      // The side written as a bare number is the claim; its decimals set the tolerance.
      const claimSide = /^-?[\d.]+$/.test(parts[i + 1]) ? i + 1 : /^-?[\d.]+$/.test(parts[i]) ? i : i + 1;
      const tol = 0.5 * 10 ** -decimals(parts[claimSide]) + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
      if (Math.abs(a - b) > tol) {
        const actual = claimSide === i + 1 ? a : b;
        wrong.push({ shown: `${parts[i]} = ${parts[i + 1]}`, stated: claimSide === i + 1 ? b : a, actual });
        break;
      }
    }
  }
  return { checked, wrong };
}

export function describeWrong(w: WrongStep): string {
  const actual = Number.isInteger(w.actual) ? String(w.actual) : String(Number(w.actual.toFixed(6)));
  return `"${w.shown}" is wrong - it is ${actual}`;
}

/* ── Citations ─────────────────────────────────────────────────────── */

export interface CitedSource { n: number; text: string }
export interface CitationFlag { sentence: string; sources: number[]; missing: string[] }
export interface CitationCheck {
  checked: number;
  supported: number;
  flagged: CitationFlag[];
  /** The passage in each source that best supports each checked sentence - kept as evidence. */
  evidence: { n: number; sentence: string; passage: string }[];
}

const STOP = new Set(['about', 'after', 'again', 'also', 'among', 'because', 'been', 'before', 'being', 'between', 'both', 'could', 'during', 'each', 'even', 'from', 'have', 'into', 'more', 'most', 'much', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your', 'said', 'says']);

const numbersIn = (s: string) => (plain(s).match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.length >= 2 || n.includes('.'));
const wordsIn = (s: string) => [...new Set((s.toLowerCase().match(/[a-z][a-z'-]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];

/** The stretch of a source around the most of a sentence's words - the passage that would back it up. */
function bestPassage(sentence: string, source: string): string {
  const words = wordsIn(sentence);
  const nums = numbersIn(sentence);
  const pieces = source.split(/(?<=[.!?])\s+|\n+/).filter((p) => p.trim().length > 20);
  let best = { score: -1, text: '' };
  for (let i = 0; i < pieces.length; i++) {
    const win = pieces.slice(i, i + 2).join(' ');
    const low = plain(win).toLowerCase();
    const score = words.filter((w) => low.includes(w)).length + 2 * nums.filter((n) => low.includes(n)).length;
    if (score > best.score) best = { score, text: win };
  }
  return best.text.replace(/\s+/g, ' ').trim().slice(0, 320);
}

/**
 * Does each cited statement appear in the sources it cites? Numbers must be
 * there exactly (a figure not in its source is the classic invented
 * citation); for the rest, most of the statement's key words must be.
 */
export function checkCitations(report: string, sources: CitedSource[]): CitationCheck {
  const byN = new Map(sources.map((s) => [s.n, s.text]));
  const sentences = report.split(/(?<=[.!?])\s+(?=[A-Z*(#-])|\n+/).map((s) => s.trim()).filter((s) => /\[\d+(?:\s*[,-]\s*\d+)*\]/.test(s));
  const flagged: CitationFlag[] = [];
  const evidence: CitationCheck['evidence'] = [];
  let supported = 0;
  for (const sentence of sentences) {
    const cites = [...sentence.matchAll(/\[(\d+(?:\s*[,-]\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).flatMap((part) => {
      const [a, b] = part.split('-').map(Number);
      return b ? Array.from({ length: Math.min(b - a + 1, 6) }, (_, k) => a + k) : [a];
    }));
    const texts = cites.map((n) => byN.get(n)).filter((t): t is string => Boolean(t));
    const claim = sentence.replace(/\[[\d,\s-]+\]/g, '');
    if (!texts.length) {
      flagged.push({ sentence: claim, sources: cites, missing: ['(cites a source that does not exist)'] });
      continue;
    }
    const corpus = plain(texts.join('\n')).toLowerCase();
    const missingNums = numbersIn(claim).filter((n) => !corpus.includes(n));
    const words = wordsIn(claim);
    const found = words.filter((w) => corpus.includes(w)).length;
    const wordsOk = words.length < 3 || found / words.length >= 0.5;
    if (!missingNums.length && wordsOk) {
      supported++;
      const n = cites.find((c) => byN.has(c))!;
      evidence.push({ n, sentence: claim, passage: bestPassage(claim, byN.get(n)!) });
    } else {
      flagged.push({ sentence: claim, sources: cites, missing: missingNums.length ? missingNums : ['most of its wording'] });
    }
  }
  return { checked: sentences.length, supported, flagged, evidence };
}

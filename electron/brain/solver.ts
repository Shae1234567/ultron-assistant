import { chat } from './llm';
import { runCode } from '../sandbox';
import { isMathAsk } from './verify';

/**
 * Hard problems solved by programs, with a vote (workflow v3).
 *
 * Program-aided reasoning (PAL, Gao et al. 2022) plus self-consistency (Wang
 * et al. 2022): instead of reasoning in words, the model writes a short
 * program that computes the answer; that is done several times
 * independently, every program is run in the sandbox, and the answer most of
 * them agree on wins. It targets exactly where the small local model failed
 * in the evaluations: setting a problem up (8:20 pm written as 8.33 h), the
 * trap in a word problem, and logic puzzles "reasoned" instead of checked.
 * The lead then answers with the agreed result and explains the method.
 *
 * Found on the hard set's opt tasks (29 Sep 2026): one program crashed, one
 * printed "NaN:NaN am" and one got it right ("16:01 pm") - no two agreed, and
 * the lead then guessed. So a crashed program gets one repair with its error
 * (self-debugging), NaN counts as a failure, answers are compared by value
 * (16:01 = 4:01 pm, 13.3 = 13.33), and when fewer than two agree a couple
 * more programs are drawn before giving up.
 */

const PUZZLE = /\b(puzzle|riddle|logic|each (player|student|person|friend)|who (wears|has|plays|owns|sits|gets)|arrangement|probability|chance of|odds|how many (ways|different|combinations|committees|arrangements)|what day of the week|angle between|next number|sequence|twice as old|times as old|work(ing)? together|meet\b|average speed|area|perimeter|volume|rectangle|triangle|circle|radius|diameter)\b/i;

/** A question worth solving by program: a worked-out number, or a puzzle whose answer can be checked in code. */
export function wantsSolver(text: string): boolean {
  return isMathAsk(text) || PUZZLE.test(text);
}

const PAL_SYSTEM = [
  'You solve problems by writing a short JavaScript program that computes the answer. Rules:',
  '- Put every quantity from the problem into a named const with its exact value. Convert clock times exactly with clock("8:20 pm") (= 20.333 hours) and never round until the final line. To print a time of day, use timeOfDay(hours) (timeOfDay(16.025) -> "4:02 pm") - never format am/pm yourself.',
  '- Do the logic in code: equations, loops, or trying every case. For a puzzle about who has what, loop over every possible arrangement, test it against every clue, and print the one that fits.',
  '- Watch for traps: an average speed is total distance / total time; a percent change applies to the new amount; time may run out (a negative result means "not enough").',
  '- The last line must be console.log(...) of the final answer only: a number (to a sensible number of decimals), a fraction like "5/36", a time like "4:02 pm", a day, or a short assignment like "Ana 1, Bo 4, Cy 3, Di 2".',
  '- Plain JavaScript (let/const, for loops, Math). No Python, no imports, no input(). mathjs is available as `math` if you need it. minutesBetween("6:45 pm", "8:20 pm") gives minutes.',
  'Reply with only the program, in one ```js code block.',
].join('\n');

function codeOf(text: string): string {
  const fenced = /```(?:js|javascript)?\s*\n([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/** "4:02 PM" / "4:02 pm" / " 45 km/h " - answers compared the way a person would. */
export function normalizeAnswer(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.,;!]+$/, '');
  // Numbers to a common precision so 45 and 45.00000001 agree.
  s = s.replace(/-?\d+\.\d+/g, (n) => String(Math.round(Number(n) * 1e4) / 1e4));
  return s;
}

type Key = { kind: 'time'; v: number } | { kind: 'num'; v: number; dp: number } | { kind: 'text'; v: string };

const decimals = (n: string) => (n.includes('.') ? n.split('.')[1].length : 0);

/** What an answer means, for comparing: a time of day in minutes, a number, or the words. */
export function answerKey(raw: string): Key {
  const s = normalizeAnswer(raw).replace(/[–−]/g, '-');
  // "Meeting time: 4:01 pm" / "Answer: 45" - compare the value, not the label.
  const label = /^[a-z][a-z '()-]{0,40}:\s*(?=\S)/.exec(s);
  if (label) {
    const inner = valueKey(s.slice(label[0].length));
    if (inner) return inner;
  }
  return valueKey(s) ?? { kind: 'text', v: assignment(s) ?? s };
}

/**
 * "Wes 1, Zoe 2, Xia 3, Yan 4" and "Zoe 2, Yan 4, Xia 3, Wes 1" are one answer (fresh hard set, 30 Sep 2026:
 * two programs agreed but printed the runners in a different order, so the vote failed). Sorted "name n" pairs,
 * when the answer is nothing but such pairs.
 */
function assignment(s: string): string | null {
  const pair = /([a-z]+)\s*(?:[:=(-]|is|in|wears|has|gets|finishes)?\s*(\d+)(?:st|nd|rd|th)?\)?/g;
  const pairs = [...s.matchAll(pair)];
  if (pairs.length < 2 || s.replace(pair, '').replace(/\band\b/g, '').replace(/[\s,;.]/g, '') !== '') return null;
  return pairs.map((m) => `${m[1]} ${m[2]}`).sort().join(', ');
}

function valueKey(s: string): Key | null {
  const t = /^(?:at |about |around )?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (t) {
    let h = Number(t[1]);
    const ap = t[4]?.[0];
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    return { kind: 'time', v: h * 60 + Number(t[2]) + Number(t[3] ?? 0) / 60 };
  }
  const f = /^(-?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (f && Number(f[2])) return { kind: 'num', v: Number(f[1]) / Number(f[2]), dp: 6 };
  // A number with at most a short unit: "$41.91", "45 km/h", "-5 minutes", "130°", "12%".
  const n = /^(-)?\s*\$?\s*(-?[\d,]*\.?\d+)\s*([a-z°%/ .]{0,24})$/.exec(s);
  if (n && !/\d/.test(n[3])) {
    const num = n[2].replace(/,/g, '');
    const v = Number(num) * (n[1] ? -1 : 1);
    if (Number.isFinite(v)) return { kind: 'num', v, dp: decimals(num) };
  }
  return null;
}

/** The same answer, allowing for how it was written or rounded. */
export function sameAnswer(a: Key, b: Key): boolean {
  if (a.kind === 'time' && b.kind === 'time') {
    const d = Math.abs(a.v - b.v) % (24 * 60);
    return Math.min(d, 24 * 60 - d) <= 1;
  }
  if (a.kind === 'num' && b.kind === 'num') {
    if (a.v === b.v) return true;
    const dp = Math.min(a.dp, b.dp);
    if (a.dp === 0 && b.dp === 0) return false;
    const diff = Math.abs(a.v - b.v);
    // Within the rounding of the less precise one, and within 2% (so 0 and 0.4 never "agree").
    return diff <= 0.5 * 10 ** -dp + 1e-9 && diff <= 0.02 * Math.max(Math.abs(a.v), Math.abs(b.v));
  }
  return a.kind === 'text' && b.kind === 'text' && a.v === b.v;
}

/** "16:01 pm" -> "4:01 pm": a 24-hour time some programs print with am/pm anyway. */
function tidy(answer: string): string {
  return answer.replace(/\b(1[3-9]|2[0-3]):(\d{2})\s*(am|pm)\b/i, (_, h, m) => `${Number(h) - 12}:${m} pm`);
}

export interface SolverResult {
  /** The answer most programs gave (as the first of them printed it), or null when none ran or none agreed. */
  answer: string | null;
  agree: number;
  /** How many programs were run in all (repairs not counted). */
  tried: number;
  /** What each program printed (or its error). */
  outputs: string[];
}

type Attempt = { ok: true; answer: string; code: string } | { ok: false; answer: string; code?: string };

async function attempt(question: string, signal: AbortSignal | undefined, fix?: { code: string; error: string }): Promise<Attempt> {
  let code: string | undefined;
  try {
    const res = await chat({
      system: PAL_SYSTEM,
      messages: fix
        ? [
          { role: 'user', content: question },
          { role: 'assistant', content: '```js\n' + fix.code + '\n```' },
          { role: 'user', content: `That program failed: ${fix.error}. Find the mistake and reply with only the corrected program.` },
        ]
        : [{ role: 'user', content: question }],
      // Different programs, not the same one k times - that's the point of the vote.
      temperature: fix ? 0.3 : 0.8,
      effort: 'medium',
      signal,
    });
    code = codeOf(res.text);
    const run = await runCode(code, { timeoutMs: 6000 });
    const printed = (run.output.length ? run.output[run.output.length - 1] : run.result)?.trim();
    if (!run.ok) return { ok: false, answer: `error: ${run.error ?? 'failed'}`.slice(0, 160), code };
    if (!printed || /^(undefined|null)$|\bNaN\b|Infinity|\[object /.test(printed)) return { ok: false, answer: `error: printed ${printed || 'nothing'}`.slice(0, 160), code };
    return { ok: true, answer: tidy(printed.slice(0, 200)), code };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, answer: `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160), code };
  }
}

function tally(good: string[]): { first: string; n: number } | undefined {
  const groups: { key: Key; first: string; n: number }[] = [];
  for (const a of good) {
    const key = answerKey(a);
    const g = groups.find((x) => sameAnswer(x.key, key));
    if (g) g.n++;
    else groups.push({ key, first: a, n: 1 });
  }
  return groups.sort((a, b) => b.n - a.n)[0];
}

export async function solveWithPrograms(question: string, opts: { k: number; extra?: number; signal?: AbortSignal }): Promise<SolverResult> {
  let attempts = await Promise.all(Array.from({ length: opts.k }, () => attempt(question, opts.signal)));
  // A program that crashed or printed NaN gets one go at fixing itself, with its error.
  attempts = await Promise.all(attempts.map((a) => (!a.ok && a.code ? attempt(question, opts.signal, { code: a.code, error: a.answer.replace(/^error: /, '') }) : a)));
  const answers = () => attempts.filter((a) => a.ok).map((a) => a.answer);
  let best = tally(answers());
  // Fewer than two agree: draw a few more before giving up.
  const extra = opts.extra ?? 0;
  if (opts.k > 1 && extra > 0 && (!best || best.n < 2)) {
    attempts = attempts.concat(await Promise.all(Array.from({ length: extra }, () => attempt(question, opts.signal))));
    best = tally(answers());
  }
  // An answer counts when at least two programs agree - or the only program that ran, when just one was asked for.
  const agreed = best && (best.n >= 2 || (opts.k === 1 && best.n === 1));
  return { answer: agreed ? best!.first : null, agree: best?.n ?? 0, tried: attempts.length, outputs: attempts.map((a) => a.answer) };
}

/** The note the lead (or the team) gets with the solver's result. */
export function solverNote(r: SolverResult): string {
  if (r.answer) {
    const key = answerKey(r.answer);
    const negative = key.kind === 'num' && key.v < 0
      ? ' It is negative: if it is an amount left over (time, money), that means there is NOT enough - say so, and by how much.'
      : '';
    // Short on purpose: long explanations are where the local model re-did the sum in words and got it wrong
    // ("Wait, that can't be right. Actually, let me recalculate..." - hard set, 29-30 Sep 2026).
    return `\n\n[SOLVER] ${r.tried} independent programs worked this out and ${r.agree} of them agree: ${r.answer}.${negative} Start your reply with this answer in plain words, then explain the method in two or three short sentences - no step-by-step working, no re-doing the sum. If you find a real mistake in it, check with run_code before saying so.`;
  }
  const ran = r.outputs.filter((o) => !o.startsWith('error:'));
  if (ran.length === 1) return `\n\n[SOLVER] Only one of ${r.tried} programs ran cleanly, and it got ${ran[0]} - unconfirmed. Check it with run_code (set the problem up step by step) before answering.`;
  return ran.length
    ? `\n\n[SOLVER] ${r.tried} programs worked this out but disagree (${ran.join(' | ')}). Work it out carefully with run_code and say which is right.`
    : '';
}

/** Does the start of a reply give the agreed answer? (For a negative "left over", its size is enough: "5 minutes short".) */
export function statesAnswer(reply: string, answer: string): boolean {
  const head = reply.replace(/\*\*/g, '').replace(/[–−](?=\s*\d)/g, '-').slice(0, 400);
  const key = answerKey(answer);
  if (key.kind === 'time') {
    return [...head.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?(\s*(?:am|pm|a\.m\.|p\.m\.))?/gi)].some((m) => {
      const k = answerKey(m[0]);
      if (k.kind !== 'time') return false;
      if (sameAnswer(key, k)) return true;
      // "4:01" with no am/pm: compare on a 12-hour clock.
      const d = Math.abs(key.v - k.v) % 720;
      return !m[3] && Math.min(d, 720 - d) <= 1;
    });
  }
  if (key.kind === 'num') {
    const nums = [...head.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?/g)].map((m) => answerKey(m[0].replace('$', '')));
    const want: Key[] = [key, { ...key, v: Math.abs(key.v) }];
    return nums.some((k) => want.some((w) => sameAnswer(w, k)));
  }
  // Words: every name and number in the answer ("Ana 1, Bo 4, Cy 3, Di 2", "Friday") appears.
  const words = key.v.split(/[^a-z0-9]+/i).filter((w) => /\d/.test(w) || w.length >= 2);
  // A whole sentence can be said many ways - only short answers are checked word by word.
  if (words.length > 8) return true;
  const lower = head.toLowerCase();
  return words.length > 0 && words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
}

import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import mathSource from 'mathjs/lib/browser/math.js?raw';
// The package only exports its entry points, so the prebuilt bundle is read by path.
import ceSource from '../node_modules/@cortex-js/compute-engine/dist/umd-min/compute-engine.cjs?raw';

/**
 * Exact answers instead of mental arithmetic. Language models are sure of
 * themselves and wrong about percentages, dates, sums over a list and unit
 * conversions; running a few lines of code is how the best assistants avoid
 * that. The code is written by the model - and the model may have read a
 * hostile web page - so it runs in QuickJS compiled to WebAssembly
 * (github.com/justjake/quickjs-emscripten): no files, no network, no Node,
 * a memory cap and a hard time limit. mathjs (github.com/josdejong/mathjs)
 * is loaded inside the same sandbox when the code uses `math.`: exact
 * fractions, units, algebra, derivatives, matrices and statistics.
 * The CortexJS Compute Engine (github.com/cortex-js/compute-engine) is loaded
 * when the code uses `CE.` or `ce.`: a computer-algebra system that solves
 * equations ("3(x-4) = 2x+7" -> 19), factors, expands and reads LaTeX - the
 * algebra the evaluation set showed the small model getting wrong (x = -19).
 */

let modulePromise: Promise<QuickJSWASMModule> | null = null;
const quickjs = () => (modulePromise ??= newQuickJSWASMModuleFromVariant(variant));

const MEMORY_LIMIT = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_OUTPUT = 8000;

/* console.* collects lines; __fmt shows values the way a person would read them - mathjs values in math notation. */
const PRELUDE = `
globalThis.__out = [];
globalThis.__fmt = function (v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return '[function ' + (v.name || 'anonymous') + ']';
  if (v && typeof v === 'object' && globalThis.math && (v.isFraction || v.isUnit || v.isMatrix || v.isBigNumber || v.isComplex || v.isNode)) {
    return globalThis.math.format(v, { precision: 14 });
  }
  if (typeof v === 'number') return String(v);
  try { return JSON.stringify(v, function (k, x) { return typeof x === 'bigint' ? x.toString() : x; }); } catch (e) { return String(v); }
};
(function () {
  var log = function () { globalThis.__out.push(Array.prototype.map.call(arguments, globalThis.__fmt).join(' ')); };
  globalThis.console = { log: log, info: log, warn: log, error: log, debug: log, table: log };
  // Small models reach for Python's print(); let it work rather than fail the run.
  globalThis.print = log;
})();
// Clock times, exactly - "8:20 pm" is 20 + 20/60 hours, not 8.33 (a rounding slip seen in the evaluation).
globalThis.clock = function (t) {
  var m = /^\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s*$/i.exec(String(t));
  if (!m) throw new Error('clock() needs a time like "8:20 pm" or "14:05"');
  var h = Number(m[1]) % 12, min = Number(m[2] || 0), ap = (m[3] || '').toLowerCase();
  if (ap === 'pm') h += 12; else if (!ap) h = Number(m[1]);
  return h + min / 60;
};
globalThis.minutesBetween = function (a, b) {
  var d = Math.round((globalThis.clock(b) - globalThis.clock(a)) * 60);
  return d < 0 ? d + 24 * 60 : d;
};
// Hours on a 24-hour clock as a time of day: timeOfDay(16.025) -> "4:02 pm" (programs that wrote their own
// am/pm printed "4:02 am" for the same answer - hard set, trains-meet).
globalThis.timeOfDay = function (hours) {
  // + 1e-9: 16.025 * 60 is 961.4999... in floating point, and half a minute should round up.
  var m = Math.round(Number(hours) * 60 + 1e-9);
  if (!isFinite(m)) throw new Error('timeOfDay() needs a number of hours, like 16.5');
  m = ((m % 1440) + 1440) % 1440;
  var h = Math.floor(m / 60), min = m % 60;
  return (h % 12 === 0 ? 12 : h % 12) + ':' + (min < 10 ? '0' : '') + min + ' ' + (h < 12 ? 'am' : 'pm');
};
`;

/* Python written into a JavaScript sandbox - what the small local model did in live evals (29 Sep 2026): print(f"..."), def, import. */
const PYTHON = /\bprint\s*\(\s*f["']|^\s*(def|import|from|elif|for \w+ in)\b|\bf"[^"\n]*\{|\brange\s*\(|\blen\s*\(|:\s*\n\s{2,}\S|\bTrue\b|\bFalse\b|\bNone\b/m;

function pythonHint(code: string, message: string): string {
  return PYTHON.test(code) && /SyntaxError|not defined/.test(message)
    ? ' - this sandbox runs JavaScript, not Python. Use let/const, console.log(...), template strings `${x}`, arr.length, and for (const x of arr) loops.'
    : '';
}

export interface CodeResult {
  ok: boolean;
  /** Lines from console.log. */
  output: string[];
  /** The value of the last expression, when there is one. */
  result?: string;
  error?: string;
  ms: number;
}

function evalOrThrow(vm: QuickJSContext, code: string, file: string): void {
  const r = vm.evalCode(code, file);
  if (r.error) {
    const e = vm.dump(r.error) as { message?: string };
    r.error.dispose();
    throw new Error(e?.message ?? 'sandbox setup failed');
  }
  r.value.dispose();
}

function explain(e: unknown, timeoutMs: number, code = ''): string {
  const err = (e ?? {}) as { name?: string; message?: string; stack?: string };
  const message = err.message ?? String(e);
  if (/interrupted/i.test(message)) return `Stopped after ${Math.round(timeoutMs / 1000)} s - the code took too long (an endless loop?).`;
  if (/out of memory/i.test(message)) return 'Stopped - the code used too much memory.';
  const where = /code\.js:(\d+)/.exec(err.stack ?? '')?.[1];
  const full = `${err.name ?? 'Error'}: ${message}`;
  return `${full}${where ? ` (line ${where})` : ''}${pythonHint(code, full)}`;
}

function clipLines(lines: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > MAX_OUTPUT) {
      out.push(`...[${lines.length - out.length} more lines cut]`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** Runs JavaScript in a fresh sandbox and returns what it printed and its final value. */
export async function runCode(code: string, opts: { timeoutMs?: number } = {}): Promise<CodeResult> {
  const t0 = Date.now();
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), 20_000);
  if (!code.trim()) return { ok: false, output: [], error: 'No code given.', ms: 0 };
  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(4 * 1024 * 1024);
  const vm = runtime.newContext();
  let resultHandle: QuickJSHandle | null = null;
  try {
    evalOrThrow(vm, PRELUDE, 'prelude.js');
    if (/\bmath\s*\./.test(code)) evalOrThrow(vm, mathSource, 'math.js');
    if (/\b(CE|ce)\s*\./.test(code)) {
      // UMD bundle: give it a module to fill in. About 0.9 s to load, so only when the code asks for it.
      evalOrThrow(vm, `var module = { exports: {} }; var exports = module.exports;\n${ceSource}\nglobalThis.CE = module.exports; globalThis.ce = globalThis.CE.getDefaultEngine(); delete globalThis.module; delete globalThis.exports;`, 'compute-engine.js');
    }
    // The time limit starts now, for the model's own code only.
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    // A direct eval inside a function: the code's own variables stay local, and its last expression is the result.
    const run = vm.evalCode(`globalThis.__result = (function () { return eval(${JSON.stringify(code)}); })();`, 'code.js');
    runtime.setInterruptHandler(() => false);
    let error: string | undefined;
    if (run.error) {
      error = explain(vm.dump(run.error), timeoutMs, code);
      run.error.dispose();
    } else {
      run.value.dispose();
    }
    const read = vm.evalCode('JSON.stringify({ out: globalThis.__out, result: globalThis.__result === undefined ? null : globalThis.__fmt(globalThis.__result) })');
    let out: string[] = [];
    let result: string | undefined;
    if (!read.error) {
      resultHandle = read.value;
      const parsed = JSON.parse(String(vm.dump(read.value))) as { out: string[]; result: string | null };
      out = parsed.out;
      result = parsed.result ?? undefined;
    } else {
      read.error.dispose();
    }
    return { ok: !error, output: clipLines(out), result: result?.slice(0, MAX_OUTPUT), error, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, output: [], error: explain(e, timeoutMs), ms: Date.now() - t0 };
  } finally {
    resultHandle?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

/**
 * An equation to solve - "3(x-4) = 2x+7", "solve 4t - 9 = 3t + 1 for t" - and the variable it's solved for,
 * or null when the expression is not an equation.
 */
export function asEquation(expression: string): { equation: string; variable: string } | null {
  let e = expression.trim().replace(/^solve\s*:?\s*/i, '');
  const forVar = /\s+for\s+([a-z])\s*[.?]?$/i.exec(e);
  if (forVar) e = e.slice(0, forVar.index);
  if (!/[^=<>!]=[^=]/.test(` ${e} `) || (e.match(/=/g) ?? []).length !== 1) return null;
  const letters = [...new Set((e.replace(/\b(sqrt|sin|cos|tan|log|ln|exp|abs|pi)\b/gi, '').match(/[a-z]/gi) ?? []).map((c) => c.toLowerCase()))];
  if (!letters.length) return null;
  const variable = forVar?.[1]?.toLowerCase() ?? (letters.includes('x') ? 'x' : letters[0]);
  return { equation: e.trim(), variable };
}

/** Solves one equation with the Compute Engine: "x = 19", "x = 3 or x = 2". */
export async function solveEquation(equation: string, variable: string): Promise<CodeResult> {
  const r = await runCode(`const s = CE.solve(${JSON.stringify(equation)}, ${JSON.stringify(variable)}) ?? [];
s.length ? s.map((v) => ${JSON.stringify(variable)} + ' = ' + ce.box(v).toString()).join(' or ') : 'no solution found'`, { timeoutMs: 8000 });
  return r;
}

/** One maths expression through mathjs - "5 km to miles", "sqrt(2) * 3^2", "15% of 240" style work. Equations are solved. */
export async function evaluateMath(expression: string): Promise<CodeResult> {
  const eq = asEquation(expression);
  if (eq) return solveEquation(eq.equation, eq.variable);
  // mathjs has no "x% of y"; say it the way it does.
  const expr = expression.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s+/gi, '($1 / 100) * ');
  return runCode(`math.format(math.evaluate(${JSON.stringify(expr)}), { precision: 14 })`, { timeoutMs: 4000 });
}

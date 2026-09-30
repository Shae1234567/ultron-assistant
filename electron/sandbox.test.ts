import { describe, expect, it } from 'vitest';
import { evaluateMath, runCode } from './sandbox';

describe('run_code sandbox (QuickJS in WebAssembly)', () => {
  it('returns what the code printed and its last value', async () => {
    const r = await runCode('const marks = [78, 91, 85, 66];\nconsole.log("average", marks.reduce((a, b) => a + b) / marks.length);\nMath.max(...marks)');
    expect(r).toMatchObject({ ok: true, output: ['average 80'], result: '91' });
  });

  it('works out dates exactly', async () => {
    const r = await runCode('Math.round((Date.UTC(2026, 9, 2) - Date.UTC(2026, 8, 28)) / 86400000)');
    expect(r.result).toBe('4');
  });

  it('has mathjs for fractions, units, algebra and equations', async () => {
    const r = await runCode([
      'console.log(math.format(math.add(math.fraction(1, 3), math.fraction(1, 6))));',
      'console.log(math.format(math.evaluate("5 km to miles"), 4));',
      'console.log(math.simplify("2x + 3x").toString());',
      'console.log(math.derivative("x^2 + 3x", "x").toString());',
      'math.lusolve([[2, 1], [1, 3]], [3, 5])',
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.output).toEqual(['1/2', '3.107 miles', '5 * x', '2 * x + 3']);
    expect(r.result).toBe('[[0.8],[1.4]]');
  });

  it('stops an endless loop instead of freezing Ultron', async () => {
    const r = await runCode('while (true) {}', { timeoutMs: 600 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/took too long/);
    expect(r.ms).toBeLessThan(5000);
  });

  it('has no way out to the PC or the internet', async () => {
    for (const escape of [
      'require("fs")',
      'process.env',
      'fetch("https://example.com")',
      'this.constructor.constructor("return process")()',
    ]) {
      const r = await runCode(escape);
      expect(r.ok, escape).toBe(false);
      expect(r.error, escape).toMatch(/not defined|ReferenceError|TypeError/);
    }
  });

  it('keeps each run separate', async () => {
    await runCode('globalThis.leftover = 42');
    const r = await runCode('typeof leftover');
    expect(r.result).toBe('undefined');
  });

  it('accepts print() and explains Python written by mistake (live eval, 29 Sep 2026)', async () => {
    expect((await runCode('print("avg", (78 + 91) / 2)')).output).toEqual(['avg 84.5']);
    const r = await runCode('scores = [78, 91, 85, 66]\nprint(f"Average: {sum(scores) / len(scores)}")');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/runs JavaScript, not Python/);
  });

  it('works out clock times exactly', async () => {
    const r = await runCode('console.log(minutesBetween("6:45 pm", "8:20 pm")); console.log(clock("8:20 pm")); minutesBetween("11:30 pm", "1:15 am")');
    expect(r.output).toEqual(['95', String(20 + 20 / 60)]);
    expect(r.result).toBe('105');
    const t = await runCode('console.log(timeOfDay(16.025)); console.log(timeOfDay(0.5)); console.log(timeOfDay(12)); timeOfDay(clock("11:30 pm") + 1.75)');
    expect(t.output).toEqual(['4:02 pm', '12:30 am', '12:00 pm']);
    expect(t.result).toBe('1:15 am');
  });

  it('reports mistakes with the line', async () => {
    const r = await runCode('const a = 1;\nundefinedThing + a');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ReferenceError.*undefinedThing/);
  });
});

describe('equations (CortexJS Compute Engine)', () => {
  it('solves the equations the local model got wrong in the evaluation', async () => {
    expect((await evaluateMath('3(x - 4) = 2x + 7')).result).toBe('x = 19');
    expect((await evaluateMath('solve 5x + 3 = 2(x + 9)')).result).toBe('x = 5');
    expect((await evaluateMath('x^2 - 5x + 6 = 0')).result).toBe('x = 3 or x = 2');
    expect((await evaluateMath('4t - 9 = 3t + 1 for t')).result).toBe('t = 10');
  }, 30_000);

  it('is there in run_code for algebra', async () => {
    const r = await runCode('console.log(CE.factor("x^2-5x+6").toString()); CE.expand("(x+1)^2").toString()');
    expect(r).toMatchObject({ ok: true, output: ['(x - 3) * (x - 2)'], result: 'x^2 + 2x + 1' });
  }, 30_000);

  it('tells equations from plain maths', async () => {
    const { asEquation } = await import('./sandbox');
    expect(asEquation('3(x-4) = 2x+7')).toEqual({ equation: '3(x-4) = 2x+7', variable: 'x' });
    expect(asEquation('5 km to miles')).toBeNull();
    expect(asEquation('2 + 2 = 4')).toBeNull();
    expect(asEquation('a == b')).toBeNull();
  });
});

describe('calculate (mathjs)', () => {
  it('handles units, percentages and functions', async () => {
    expect((await evaluateMath('15% of 240')).result).toBe('36');
    expect((await evaluateMath('sqrt(16) * 3^2')).result).toBe('36');
    expect((await evaluateMath('100 degF to degC')).result).toMatch(/^37\.77\d* degC$/);
    expect((await evaluateMath('180 cm to ft')).result).toMatch(/^5\.905\d* ft$/);
  });
});

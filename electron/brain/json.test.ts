import { describe, expect, it } from 'vitest';
import { extractJson } from './json';

describe('extractJson', () => {
  it('parses clean JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips code fences', () => {
    expect(extractJson<{ ok: boolean }>('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it('finds the object inside prose, including braces in strings', () => {
    const text = 'Here is the plan: {"steps":[{"id":"s1","task":"find {the} thing"}],"review":true} hope that helps';
    expect(extractJson<{ steps: { task: string }[] }>(text)?.steps[0].task).toBe('find {the} thing');
  });

  it('returns null when there is no object', () => {
    expect(extractJson('no json here')).toBeNull();
  });
});

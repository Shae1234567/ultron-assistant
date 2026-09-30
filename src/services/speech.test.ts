import { describe, expect, it } from 'vitest';
import { toSpeech } from './speech';

describe('toSpeech', () => {
  it('drops markdown, citations and raw links so the voice reads cleanly', () => {
    const text = '## Bottom line\n**Division 2** tryouts favour *first touch* [1][2]. See https://example.com/drills for more.\n- Juggle daily';
    expect(toSpeech(text)).toBe('Bottom line. Division 2 tryouts favour first touch. See the link for more. Juggle daily');
  });

  it('keeps link text from markdown links', () => {
    expect(toSpeech('Read [the guide](https://x.io/g) first.')).toBe('Read the guide first.');
  });
});

import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';
// Fake keys, assembled at runtime so the file itself never holds a complete key-shaped string.
const FAKE_GEMINI = ['AIza', 'SyD4f6gH8jK0lM2nP4qR6sT8uV0wX2yZ4aB6'].join('');
const FAKE_GITHUB = ['ghp', '_abcdefghijklmnopqrstuvwxyz0123456789'].join('');

describe('redactSecrets', () => {
  it('removes keys, tokens, passwords and card numbers', () => {
    const out = redactSecrets([
      `gemini ${FAKE_GEMINI}`,
      'composio ck_abcdefghijklmnop1234',
      `github ${FAKE_GITHUB}`,
      'my password is hunter22',
      'card 4242 4242 4242 4242',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('\n'));
    expect(out).not.toMatch(/AIza|ck_abc|ghp_|hunter22|4242 4242|eyJhbGci/);
    expect(out).toContain('password [removed]');
    expect(out).toContain('[card number removed]');
  });

  it('leaves ordinary text and numbers alone', () => {
    const text = 'Alex scored 78, 91, 85 and 66. Phone the club at 212 555 0199. Tryouts were on 2026-09-10.';
    expect(redactSecrets(text)).toBe(text);
  });
});

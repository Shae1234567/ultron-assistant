import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }));

const { cleanSecret } = await import('./secrets');

describe('cleanSecret (what people actually paste)', () => {
  it('trims whitespace, newlines and invisible characters', () => {
    expect(cleanSecret('  ck_abc123\n')).toBe('ck_abc123');
    expect(cleanSecret('\u200Bck_abc123\uFEFF')).toBe('ck_abc123');
  });

  it('keeps only the key from header, env and JSON snippets', () => {
    expect(cleanSecret('x-consumer-api-key: ck_abc123')).toBe('ck_abc123');
    expect(cleanSecret('COMPOSIO_API_KEY=ck_abc123')).toBe('ck_abc123');
    expect(cleanSecret('export COMPOSIO_API_KEY="ck_abc123"')).toBe('ck_abc123');
    expect(cleanSecret('"x-consumer-api-key": "ck_abc123",')).toBe('ck_abc123');
    expect(cleanSecret('Bearer ak_abc123')).toBe('ak_abc123');
    expect(cleanSecret("'AIzaSyD-abc_123'")).toBe('AIzaSyD-abc_123');
  });

  it('leaves keys that contain : or = alone', () => {
    expect(cleanSecret('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(cleanSecret('abcDEF123==')).toBe('abcDEF123==');
  });
});

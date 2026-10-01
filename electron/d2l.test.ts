import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) }, shell: {} }));
vi.mock('./store', () => ({ getSettings: () => ({ d2l: { baseUrl: 'https://myschool.brightspace.com' } }) }));
vi.mock('./tasks', () => ({}));
vi.mock('./brain/events', () => ({ emit: () => {} }));

const { persistentCopy, friendlyError } = await import('./d2l');

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('persistentCopy (keeping the D2L sign-in across restarts)', () => {
  it('gives a session cookie a 30-day expiry and keeps its security flags', () => {
    const copy = persistentCopy({ name: 'd2lSessionVal', value: 'abc', domain: 'myschool.brightspace.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: true }, NOW);
    expect(copy).toEqual({
      url: 'https://myschool.brightspace.com/',
      name: 'd2lSessionVal',
      value: 'abc',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: NOW / 1000 + 30 * 86400,
    });
  });

  it('keeps domain cookies as domain cookies, and host-only cookies host-only', () => {
    const sso = persistentCopy({ name: 'ESTSAUTH', value: 'x', domain: '.login.microsoftonline.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: true }, NOW);
    expect(sso.domain).toBe('.login.microsoftonline.com');
    expect(sso.url).toBe('https://login.microsoftonline.com/');
    const hostOnly = persistentCopy({ name: '__Host-t', value: 'y', domain: 'myschool.brightspace.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true }, NOW);
    expect('domain' in hostOnly).toBe(false);
  });
});

describe('D2L network errors, in words', () => {
  it('says the address is wrong, not that D2L is down', () => {
    expect(friendlyError(new Error('net::ERR_NAME_NOT_RESOLVED'), 'https://myschool.brightspace.com')).toMatch(/^There is no website at myschool.brightspace.com - check the D2L address/);
    expect(friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED'), 'https://x.brightspace.com')).toMatch(/No internet connection/);
    expect(friendlyError(new Error('something else'), 'https://x.brightspace.com')).toBe('something else');
  });
});

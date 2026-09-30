import { describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('electron', () => ({ shell: { openExternal: async (u: string) => { opened.push(u); } } }));
const sp = await import('./spotifyLocal');

describe('Spotify on this PC (Spotify Free, no Web API)', () => {
  it('turns what the operator asked for into a spotify: link - a page, or a search', () => {
    expect(sp.spotifyUri('https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn?si=abc')).toBe('spotify:playlist:37i9dQZF1DWWQRwui0ExPn');
    expect(sp.spotifyUri('https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(sp.spotifyUri('spotify:artist:0Y5tJX1MQlPlqiwlOH1tJY')).toBe('spotify:artist:0Y5tJX1MQlPlqiwlOH1tJY');
    expect(sp.spotifyUri('travis scott')).toBe('spotify:search:travis%20scott');
    expect(sp.spotifyUri('lofi & chill "beats"')).toBe('spotify:search:lofi%20%26%20chill%20%22beats%22');
    // Anything else is only ever a search - never another kind of link.
    expect(sp.spotifyUri('spotify:user:evil:run')).toMatch(/^spotify:search:/);
    expect(sp.spotifyUri('https://example.com/x')).toMatch(/^spotify:search:/);
  });

  it('builds the media-controls script only from its own actions', () => {
    expect(sp.mediaScript('next')).toContain('TrySkipNextAsync');
    expect(sp.mediaScript('pause')).toContain('TryPauseAsync');
    expect(sp.mediaScript('status')).not.toMatch(/Try(Play|Pause|Skip|Toggle)/);
    expect(sp.mediaScript('status')).toContain("-match 'spotify'");
    expect(() => sp.mediaScript('rm -rf' as never)).toThrow(/unknown action/);
  });

  it('reads what Windows says is playing', () => {
    expect(sp.parseState('noise\r\n{"session":true,"ok":true,"title":"SICKO MODE","artist":"Travis Scott","album":"ASTROWORLD","status":"Playing"}\r\n'))
      .toEqual({ session: true, ok: true, title: 'SICKO MODE', artist: 'Travis Scott', album: 'ASTROWORLD', status: 'Playing' });
    expect(sp.parseState('{"session":false}')).toEqual({ session: false, ok: undefined, title: undefined, artist: undefined, album: undefined, status: undefined });
    expect(() => sp.parseState('')).toThrow(/No answer/);
  });

  it('opens a search in the app', async () => {
    if (!sp.installed()) return;
    opened.length = 0;
    await expect(sp.openInSpotify('lofi beats')).resolves.toEqual({ opened: 'spotify:search:lofi%20beats' });
    expect(opened).toEqual(['spotify:search:lofi%20beats']);
  });

  it.runIf(process.platform === 'win32')('asks the real Windows media controls (status only - plays nothing)', async () => {
    const s = await sp.mediaState('status');
    expect(typeof s.session).toBe('boolean');
    if (s.session) expect(typeof s.status).toBe('string');
  }, 20_000);
});

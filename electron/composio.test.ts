import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {}, BrowserWindow: class {} }));
vi.mock('./secrets', () => ({ getSecret: () => '' }));
vi.mock('./store', () => ({ getSettings: () => ({ composio: { userId: 'test' } }) }));
vi.mock('./brain/events', () => ({ emit: () => {} }));

const { isWriteAction } = await import('./composio');

describe('isWriteAction (what needs the operator\'s approval)', () => {
  it('lets reads through', () => {
    for (const slug of [
      'GMAIL_FETCH_EMAILS', 'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_FIND_FREE_SLOTS', 'NOTION_SEARCH_NOTION_PAGE',
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'GOOGLE_CLASSROOM_COURSES_LIST', 'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
    ]) expect(isWriteAction(slug), slug).toBe(false);
  });

  it('lets music playback control through', () => {
    expect(isWriteAction('SPOTIFY_START_RESUME_PLAYBACK')).toBe(false);
    expect(isWriteAction('SPOTIFY_SKIP_TO_NEXT')).toBe(false);
  });

  it('gates anything that sends, creates, edits or deletes', () => {
    for (const slug of [
      'GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLEDOCS_CREATE_DOCUMENT',
      'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', 'DISCORDBOT_CREATE_MESSAGE', 'GITHUB_CREATE_AN_ISSUE', 'GOOGLEDRIVE_DELETE_FILE',
    ]) expect(isWriteAction(slug), slug).toBe(true);
  });
});

describe('Composio key routing', async () => {
  const { keyKind, keyHint } = await import('./composio');

  it('sends Connect keys to Composio Connect and everything else to the project SDK', () => {
    expect(keyKind('ck_abc')).toBe('connect');
    expect(keyKind(' ck_abc ')).toBe('connect');
    expect(keyKind('ak_abc')).toBe('project');
    expect(keyKind('')).toBe('none');
  });

  it('gives advice that matches the kind of key', () => {
    expect(keyHint('ck_abc')).toContain('regenerated');
    expect(keyHint('ak_abc')).toContain('platform.composio.dev');
    expect(keyHint('uak_abc')).toContain('"uak_"');
  });
});

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const HOME = os.homedir();
const EXTRA = path.resolve(process.platform === 'win32' ? 'D:\\Projects' : '/mnt/projects');

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => ({
      downloads: path.join(HOME, 'Downloads'),
      desktop: path.join(HOME, 'OneDrive', 'Desktop'),
      documents: path.join(HOME, 'OneDrive', 'Documents'),
      pictures: path.join(HOME, 'Pictures'),
      music: path.join(HOME, 'Music'),
      videos: path.join(HOME, 'Videos'),
    } as Record<string, string>)[k],
  },
  shell: {},
}));
vi.mock('../../store', () => ({ getSettings: () => ({ folders: [{ path: EXTRA, addedAt: 0, fileCount: 0 }], vault: { path: '' } }) }));
vi.mock('../../memory/vault', () => ({ vaultRoot: () => path.join(HOME, 'Ultron Vault') }));

const { resolveSafe } = await import('./fs');

describe('resolveSafe', () => {
  it('maps known-folder shortcuts through Windows (OneDrive-redirected Desktop)', () => {
    expect(resolveSafe('Desktop/plan.md')).toBe(path.join(HOME, 'OneDrive', 'Desktop', 'plan.md'));
    expect(resolveSafe('downloads')).toBe(path.join(HOME, 'Downloads'));
  });

  it('treats relative paths as relative to the user folder', () => {
    expect(resolveSafe('school/notes.txt')).toBe(path.join(HOME, 'school', 'notes.txt'));
  });

  it('allows folders added in the Files tab', () => {
    expect(resolveSafe(path.join(EXTRA, 'a.txt'))).toBe(path.join(EXTRA, 'a.txt'));
  });

  it('refuses anything outside the allowed roots', () => {
    expect(() => resolveSafe(path.join(HOME, '..', 'Public', 'x.txt'))).toThrow(/outside/);
    if (process.platform === 'win32') expect(() => resolveSafe('C:\\Windows\\System32')).toThrow(/outside/);
  });

  it('refuses app data and credential files even inside the user folder', () => {
    expect(() => resolveSafe(path.join(HOME, 'AppData', 'Roaming', 'Claude'))).toThrow(/off-limits/);
    expect(() => resolveSafe(path.join(HOME, '.ssh', 'id_ed25519'))).toThrow(/off-limits/);
    expect(() => resolveSafe(path.join(HOME, 'project', '.env'))).toThrow(/off-limits/);
    expect(() => resolveSafe(path.join(HOME, 'keys', 'server.pem'))).toThrow(/off-limits/);
  });

  it('rejects an empty path', () => {
    expect(() => resolveSafe('  ')).toThrow(/No path/);
  });
});

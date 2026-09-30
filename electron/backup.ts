import fs from 'node:fs';
import { dialog, type BrowserWindow } from 'electron';
import { getSettings, saveSettings, type Settings, type IndexedFolder } from './store';
import { readProfile, saveProfile } from './memory/vault';

/**
 * Settings + profile backup/restore. Never includes API keys (a backup file
 * is plain text that tends to end up in cloud storage), and never the whole
 * vault - that's a folder of markdown the operator can copy like any other.
 * Older backups (with a `memory` field) still import: it becomes the profile.
 */

export interface BackupBundle {
  version: 1;
  exportedAt: string;
  settings: Settings;
  /** Profile/Operator.md from the vault (was memory.md in older backups). */
  memory: string;
  folders: IndexedFolder[];
}

function isSettingsShape(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.profile === 'object' && s.profile !== null &&
    typeof s.news === 'object' && s.news !== null &&
    typeof s.ollama === 'object' && s.ollama !== null &&
    ['ollama', 'gemini', 'openai', 'anthropic', 'auto'].includes(String(s.brain)) &&
    typeof s.voice === 'object' && s.voice !== null &&
    Array.isArray(s.folders)
  );
}

function isBackupBundle(value: unknown): value is BackupBundle {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  return b.version === 1 && typeof b.exportedAt === 'string' && typeof b.memory === 'string' && Array.isArray(b.folders) && isSettingsShape(b.settings);
}

function defaultBackupFileName(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `ultron-backup-${date}.json`;
}

export async function exportBackup(win: BrowserWindow | null): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const opts = { defaultPath: defaultBackupFileName(), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { ok: false };
    const settings = getSettings();
    const bundle: BackupBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      memory: readProfile(),
      folders: settings.folders,
    };
    fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function importBackup(win: BrowserWindow | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const opts = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    } catch {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    if (!isBackupBundle(parsed)) return { ok: false, error: 'That file does not look like an Ultron backup.' };
    saveSettings(parsed.settings);
    if (parsed.memory.trim()) saveProfile(parsed.memory);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

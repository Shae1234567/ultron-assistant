import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, shell, BrowserWindow } from 'electron';
import { getSettings, saveSettings } from './store';

export interface IndexedFile {
  name: string;
  path: string;
  ext: string;
  size: number;
  modified: number;
  folder: string;
}

const MAX_FILES_PER_FOLDER = 5000;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', '.next', '.cache',
  'AppData', '$RECYCLE.BIN', 'System Volume Information', '.venv', '__pycache__',
]);

/** In-memory index. Rebuilt on demand - Ultron never scans anything not explicitly added. */
let index: IndexedFile[] = [];

function walk(root: string, folderLabel: string, out: IndexedFile[], depth = 0): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_FOLDER) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // permission denied on a subfolder is not fatal
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_FOLDER) return;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(full, folderLabel, out, depth + 1);
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({
          name: entry.name,
          path: full,
          ext: path.extname(entry.name).toLowerCase().replace('.', '') || 'file',
          size: st.size,
          modified: st.mtimeMs,
          folder: folderLabel,
        });
      } catch {
        /* skip unreadable file */
      }
    }
  }
}

export function rebuildIndex(): IndexedFile[] {
  const { folders } = getSettings();
  const next: IndexedFile[] = [];
  for (const f of folders) {
    const bucket: IndexedFile[] = [];
    if (fs.existsSync(f.path)) walk(f.path, f.path, bucket);
    next.push(...bucket);
  }
  index = next;
  return index;
}

export function listFiles(limit = 300): IndexedFile[] {
  if (index.length === 0) rebuildIndex();
  return [...index].sort((a, b) => b.modified - a.modified).slice(0, limit);
}

export function searchFiles(query: string, limit = 200): IndexedFile[] {
  if (index.length === 0) rebuildIndex();
  const q = query.trim().toLowerCase();
  if (!q) return listFiles(limit);
  const terms = q.split(/\s+/);
  return index
    .filter((f) => {
      const hay = `${f.name} ${f.path}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
}

/** Opens the OS folder picker. The user chooses; Ultron never scans on its own.
 *  `defaultPath` just pre-navigates the dialog (e.g. to the home folder for
 *  "grant full access") - the user still has to click Select Folder themselves,
 *  same consent gate as any other folder. */
export async function addFolder(
  win: BrowserWindow | null,
  defaultPath?: string,
): Promise<{ ok: boolean; folders: ReturnType<typeof getSettings>['folders'] }> {
  const opts = { properties: ['openDirectory'] as ('openDirectory')[], defaultPath: defaultPath || app.getPath('home') };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);

  const settings = getSettings();
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, folders: settings.folders };
  }
  const chosen = result.filePaths[0];
  if (settings.folders.some((f) => f.path === chosen)) {
    return { ok: false, folders: settings.folders };
  }
  const bucket: IndexedFile[] = [];
  walk(chosen, chosen, bucket);
  const folders = [...settings.folders, { path: chosen, addedAt: Date.now(), fileCount: bucket.length }];
  saveSettings({ folders });
  rebuildIndex();
  return { ok: true, folders };
}

export function removeFolder(folderPath: string) {
  const settings = getSettings();
  const folders = settings.folders.filter((f) => f.path !== folderPath);
  saveSettings({ folders });
  rebuildIndex();
  return folders;
}

export function indexStats() {
  const { folders } = getSettings();
  return {
    folderCount: folders.length,
    fileCount: index.length,
    capped: index.length >= MAX_FILES_PER_FOLDER * Math.max(folders.length, 1),
  };
}

/* ── Mutation: organize and edit ───────────────────────────────────────
   Everything below can change what's on disk, so every entry point is
   gated by isIndexed() first - Ultron can only touch a path that resolves
   inside a folder the operator explicitly added via the OS picker. There
   is no way to reach this from a path the operator did not opt in. */

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm',
  'xml', 'yml', 'yaml', 'csv', 'log', 'ini', 'cfg', 'conf', 'py', 'java', 'c', 'cpp',
  'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'toml', 'env',
]);
const MAX_TEXT_BYTES = 3 * 1024 * 1024; // 3MB - enough for real notes/code, not a video

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** True if `target` resolves inside one of the operator's indexed folders. */
function isIndexed(target: string): boolean {
  const resolved = realpathOrSelf(target);
  const roots = getSettings().folders.map((f) => realpathOrSelf(f.path));
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export const isTextLike = (name: string): boolean =>
  TEXT_EXTS.has(path.extname(name).toLowerCase().replace('.', ''));

export function readFileContent(target: string): { ok: boolean; content?: string; error?: string } {
  if (!isIndexed(target)) return { ok: false, error: 'That path is outside every indexed folder.' };
  if (!isTextLike(target)) return { ok: false, error: 'Only text-like files can be opened for editing.' };
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
    if (st.size > MAX_TEXT_BYTES) return { ok: false, error: `File is too large to edit here (${(st.size / 1024 / 1024).toFixed(1)} MB).` };
    return { ok: true, content: fs.readFileSync(target, 'utf8') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function writeFileContent(target: string, content: string): { ok: boolean; error?: string } {
  if (!isIndexed(target)) return { ok: false, error: 'That path is outside every indexed folder.' };
  if (!isTextLike(target)) return { ok: false, error: 'Only text-like files can be edited here.' };
  try {
    fs.writeFileSync(target, content, 'utf8');
    rebuildIndex();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function renameFile(target: string, newName: string): { ok: boolean; path?: string; error?: string } {
  if (!isIndexed(target)) return { ok: false, error: 'That path is outside every indexed folder.' };
  const clean = newName.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) return { ok: false, error: 'Invalid file name.' };
  const dest = path.join(path.dirname(target), clean);
  if (fs.existsSync(dest)) return { ok: false, error: 'A file with that name already exists.' };
  try {
    fs.renameSync(target, dest);
    rebuildIndex();
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Moves a file into a different indexed folder (or a subfolder of one). */
export function moveFile(target: string, destFolder: string): { ok: boolean; path?: string; error?: string } {
  if (!isIndexed(target)) return { ok: false, error: 'Source path is outside every indexed folder.' };
  if (!isIndexed(destFolder)) return { ok: false, error: 'Destination is outside every indexed folder.' };
  try {
    if (!fs.statSync(destFolder).isDirectory()) return { ok: false, error: 'Destination is not a folder.' };
    const dest = path.join(destFolder, path.basename(target));
    if (fs.existsSync(dest)) return { ok: false, error: 'A file with that name already exists there.' };
    fs.renameSync(target, dest);
    rebuildIndex();
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Moves to the OS Recycle Bin - reversible, never a permanent unlink. */
export async function deleteFile(target: string): Promise<{ ok: boolean; error?: string }> {
  if (!isIndexed(target)) return { ok: false, error: 'That path is outside every indexed folder.' };
  try {
    await shell.trashItem(target);
    rebuildIndex();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function createFile(folderPath: string, name: string, content = ''): { ok: boolean; path?: string; error?: string } {
  if (!isIndexed(folderPath)) return { ok: false, error: 'That folder is outside every indexed folder.' };
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) return { ok: false, error: 'Invalid file name.' };
  const dest = path.join(folderPath, clean);
  if (fs.existsSync(dest)) return { ok: false, error: 'A file with that name already exists.' };
  try {
    fs.writeFileSync(dest, content, 'utf8');
    rebuildIndex();
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function createSubfolder(folderPath: string, name: string): { ok: boolean; path?: string; error?: string } {
  if (!isIndexed(folderPath)) return { ok: false, error: 'That folder is outside every indexed folder.' };
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) return { ok: false, error: 'Invalid folder name.' };
  const dest = path.join(folderPath, clean);
  if (fs.existsSync(dest)) return { ok: false, error: 'A folder with that name already exists.' };
  try {
    fs.mkdirSync(dest);
    rebuildIndex();
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Safe reveal-in-explorer: only for paths actually inside an indexed folder. */
export function revealSafe(target: string): boolean {
  if (!isIndexed(target)) return false;
  shell.showItemInFolder(target);
  return true;
}

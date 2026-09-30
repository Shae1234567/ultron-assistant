import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { app, shell } from 'electron';
import { getSettings } from '../../store';
import { vaultRoot } from '../../memory/vault';
import { B, N, S, bool, clip, num, obj, str, type AgentTool } from './types';

/**
 * Hephaestus's hands on the operator's machine. Reach: the user folder, any
 * folder added in the Files tab, and the vault. Credential stores and app
 * data are off-limits even inside those. Anything destructive (overwrite,
 * move, rename, delete, run a command) waits for an explicit approval, and
 * deletes go to the Recycle Bin, never straight to oblivion.
 */

const DENY_DIRS = new Set(['appdata', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config', '.vscode', '.npm', '.cache', 'node_modules', '$recycle.bin']);
const DENY_FILE = /(^\.env(\..*)?$|\.pem$|\.key$|\.pfx$|\.p12$|\.kdbx$|^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|^\.git-credentials$|^ntuser\.|^secrets\.json$|^credentials(\.json)?$|^\.npmrc$|^\.netrc$)/i;
const EXEC_EXT = /\.(exe|bat|cmd|ps1|vbs|js|msi|scr|com|lnk|jar|reg|hta)$/i;
const SKIP_WALK = new Set(['node_modules', '.git', 'appdata', '$recycle.bin', '.cache', '.npm', 'venv', '.venv', '__pycache__', 'dist', 'build', 'release']);

function roots(): string[] {
  const list = [os.homedir(), vaultRoot(), ...getSettings().folders.map((f) => f.path)];
  return [...new Set(list.map((r) => path.resolve(r)))];
}

function within(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Resolves a user-supplied path and refuses anything outside Ultron's reach. */
export function resolveSafe(input: string): string {
  let p = input.trim().replace(/^["']|["']$/g, '');
  if (!p) throw new Error('No path given.');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  // Known folders resolve through Windows itself - Desktop and Documents are
  // redirected into OneDrive on many PCs, so ~/Desktop would be wrong.
  const known: Record<string, Parameters<typeof app.getPath>[0]> = {
    desktop: 'desktop', documents: 'documents', downloads: 'downloads', pictures: 'pictures', music: 'music', videos: 'videos',
  };
  const [first, ...rest] = p.split(/[\\/]/);
  if (!path.isAbsolute(p) && known[first.toLowerCase()]) p = path.join(app.getPath(known[first.toLowerCase()]), ...rest);
  if (!path.isAbsolute(p)) p = path.join(os.homedir(), p);
  const full = path.resolve(p);
  if (!roots().some((r) => within(full, r))) {
    throw new Error(`"${full}" is outside the folders Ultron may touch (your user folder, the vault, and folders added in the Files tab).`);
  }
  const segments = full.split(path.sep).map((s) => s.toLowerCase());
  const vault = path.resolve(vaultRoot()).toLowerCase();
  if (segments.some((s) => DENY_DIRS.has(s)) && !full.toLowerCase().startsWith(vault)) {
    throw new Error('That location holds app data or credentials, which are off-limits.');
  }
  if (DENY_FILE.test(path.basename(full))) throw new Error('That file looks like a credential or secrets file - off-limits.');
  return full;
}

/** Ultron's own vault is its scratch space; everywhere else, anything that adds or changes files asks first. */
function insideVault(p: string): boolean {
  return within(p, path.resolve(vaultRoot()));
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function uniqueTarget(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find a free file name.');
}

const TYPE_BUCKETS: [string, RegExp][] = [
  ['Images', /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i],
  ['Videos', /\.(mp4|mov|mkv|avi|webm|wmv|m4v)$/i],
  ['Audio', /\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i],
  ['Documents', /\.(pdf|docx?|odt|rtf|txt|md|pptx?|xlsx?|csv|epub|pages|key|numbers)$/i],
  ['Archives', /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i],
  ['Installers', /\.(exe|msi|msix|appx|dmg|pkg|apk)$/i],
  ['Code', /\.(js|ts|tsx|jsx|py|java|c|cpp|cs|go|rs|html|css|json|ya?ml|sh|ps1|ipynb)$/i],
];

export const fsTools: AgentTool[] = [
  {
    name: 'list_folder',
    owner: 'hephaestus',
    description: 'List the contents of a folder on the operator\'s PC (names, types, sizes, dates). Accepts absolute paths or shortcuts like "Downloads", "Desktop", "Documents".',
    parameters: obj({ path: S('Folder path'), depth: N('How many levels deep (1-3, default 1)') }, ['path']),
    label: (a) => `list ${str(a, 'path')}`,
    run: async (args) => {
      const root = resolveSafe(str(args, 'path'));
      const depth = Math.min(Math.max(num(args, 'depth', 1), 1), 3);
      const out: string[] = [];
      let count = 0;
      const walk = (dir: string, level: number) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { out.push(`(cannot read ${dir}: ${(e as Error).message})`); return; }
        for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
          if (count >= 250) return;
          const full = path.join(dir, e.name);
          const indent = '  '.repeat(level - 1);
          try {
            const st = fs.statSync(full);
            count++;
            out.push(e.isDirectory()
              ? `${indent}[dir] ${e.name}/`
              : `${indent}${e.name}  (${fmtSize(st.size)}, ${new Date(st.mtimeMs).toISOString().slice(0, 10)})`);
            if (e.isDirectory() && level < depth && !SKIP_WALK.has(e.name.toLowerCase())) walk(full, level + 1);
          } catch { /* unreadable entry */ }
        }
      };
      walk(root, 1);
      return { folder: root, entries: out.length ? out : ['(empty)'], truncated: count >= 250 };
    },
  },
  {
    name: 'read_file',
    owner: 'hephaestus',
    description: 'Read a text file (notes, code, CSV, markdown, JSON...) from the operator\'s PC.',
    parameters: obj({ path: S('File path'), max_chars: N('Max characters to return (default 12000)') }, ['path']),
    label: (a) => `read ${path.basename(str(a, 'path'))}`,
    run: async (args) => {
      const file = resolveSafe(str(args, 'path'));
      const st = fs.statSync(file);
      if (st.isDirectory()) return { error: 'That is a folder - use list_folder.' };
      const buf = fs.readFileSync(file);
      if (isBinary(buf)) return { path: file, size: fmtSize(st.size), note: 'Binary file (not text) - can report its details but not its contents.' };
      const text = buf.toString('utf8');
      const max = Math.min(num(args, 'max_chars', 12_000), 40_000);
      return { path: file, size: fmtSize(st.size), content: text.slice(0, max), truncated: text.length > max };
    },
  },
  {
    name: 'search_files',
    owner: 'hephaestus',
    description: 'Find files under a folder by name and/or by text inside them. Use name_contains for file names, content_contains to grep text files.',
    parameters: obj({
      folder: S('Folder to search in (default: the user folder)'),
      name_contains: S('Case-insensitive part of the file name, e.g. "essay" or ".pdf"'),
      content_contains: S('Text to find inside text files'),
      max_results: N('Default 40'),
    }),
    label: (a) => `search ${str(a, 'name_contains') || str(a, 'content_contains')} in ${str(a, 'folder') || '~'}`,
    run: async (args, ctx) => {
      const root = resolveSafe(str(args, 'folder') || os.homedir());
      const nameQ = str(args, 'name_contains').toLowerCase();
      const contentQ = str(args, 'content_contains').toLowerCase();
      if (!nameQ && !contentQ) return { error: 'Give name_contains or content_contains.' };
      const max = Math.min(num(args, 'max_results', 40), 100);
      const hits: string[] = [];
      let visited = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || hits.length >= max || visited > 25_000 || ctx.signal.aborted) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length >= max) return;
          visited++;
          if (e.name.startsWith('.') || SKIP_WALK.has(e.name.toLowerCase())) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full, depth + 1); continue; }
          if (nameQ && !e.name.toLowerCase().includes(nameQ)) continue;
          if (DENY_FILE.test(e.name)) continue;
          if (contentQ) {
            try {
              const st = fs.statSync(full);
              if (st.size > 1_500_000) continue;
              const buf = fs.readFileSync(full);
              if (isBinary(buf)) continue;
              const text = buf.toString('utf8');
              const idx = text.toLowerCase().indexOf(contentQ);
              if (idx === -1) continue;
              hits.push(`${full}  ...${text.slice(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, ' ')}...`);
            } catch { continue; }
          } else {
            hits.push(full);
          }
        }
      };
      walk(root, 0);
      return { folder: root, results: hits, note: hits.length >= max ? 'More results exist - narrow the search.' : undefined };
    },
  },
  {
    name: 'write_file',
    owner: 'hephaestus',
    description: 'Create a text file (or overwrite/append to one) on the operator\'s PC. Only write files the operator asked for. Anything outside Ultron\'s own vault asks the operator first.',
    parameters: obj({
      path: S('File path including name, e.g. "Documents/Study Plan.md"'),
      content: S('Full text content'),
      mode: S('create (default), overwrite, or append', { enum: ['create', 'overwrite', 'append'] }),
    }, ['path', 'content']),
    label: (a) => `write ${path.basename(str(a, 'path'))}`,
    run: async (args, ctx) => {
      const file = resolveSafe(str(args, 'path'));
      if (EXEC_EXT.test(file)) return { error: 'Refusing to write an executable/script file type.' };
      const mode = str(args, 'mode', 'create');
      const content = str(args, 'content');
      const exists = fs.existsSync(file);
      if (exists && mode === 'create') return { error: `${file} already exists. Use mode "overwrite" or "append", or pick another name.` };
      if (exists || !insideVault(file)) {
        const verb = !exists ? 'Create' : mode === 'append' ? 'Append to' : 'Overwrite';
        const ok = await ctx.approve(exists ? 'modify-file' : 'create-file', `${verb} ${path.basename(file)}?`, `${file}\n\n${content.slice(0, 600)}${content.length > 600 ? '...' : ''}`);
        if (!ok) return { error: 'The operator declined.' };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (mode === 'append') fs.appendFileSync(file, content, 'utf8');
      else fs.writeFileSync(file, content, 'utf8');
      return { ok: true, path: file, bytes: Buffer.byteLength(content) };
    },
  },
  {
    name: 'create_folder',
    owner: 'hephaestus',
    description: 'Create a folder (and any missing parents). Outside Ultron\'s vault this asks the operator first.',
    parameters: obj({ path: S('Folder path') }, ['path']),
    label: (a) => `mkdir ${str(a, 'path')}`,
    run: async (args, ctx) => {
      const dir = resolveSafe(str(args, 'path'));
      if (fs.existsSync(dir)) return { ok: true, path: dir, note: 'Already existed.' };
      if (!insideVault(dir) && !(await ctx.approve('create-file', `Create folder ${path.basename(dir)}?`, dir))) return { error: 'The operator declined.' };
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, path: dir };
    },
  },
  {
    name: 'move_path',
    owner: 'hephaestus',
    description: 'Move or rename a file or folder. Asks the operator first. If the destination is an existing folder the item goes inside it.',
    parameters: obj({ from: S('Source path'), to: S('Destination path or folder') }, ['from', 'to']),
    label: (a) => `move ${path.basename(str(a, 'from'))} -> ${str(a, 'to')}`,
    run: async (args, ctx) => {
      const from = resolveSafe(str(args, 'from'));
      let to = resolveSafe(str(args, 'to'));
      if (!fs.existsSync(from)) return { error: `${from} does not exist.` };
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = path.join(to, path.basename(from));
      if (fs.existsSync(to)) return { error: `${to} already exists - pick another name.` };
      const ok = await ctx.approve('move', `Move ${path.basename(from)}?`, `${from}\n-> ${to}`);
      if (!ok) return { error: 'The operator declined.' };
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return { ok: true, from, to };
    },
  },
  {
    name: 'copy_path',
    owner: 'hephaestus',
    description: 'Copy a file or folder to a new location (never overwrites). Outside Ultron\'s vault this asks the operator first.',
    parameters: obj({ from: S('Source path'), to: S('Destination path or folder') }, ['from', 'to']),
    label: (a) => `copy ${path.basename(str(a, 'from'))}`,
    run: async (args, ctx) => {
      const from = resolveSafe(str(args, 'from'));
      let to = resolveSafe(str(args, 'to'));
      if (!fs.existsSync(from)) return { error: `${from} does not exist.` };
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = path.join(to, path.basename(from));
      to = uniqueTarget(to);
      if (!insideVault(to) && !(await ctx.approve('create-file', `Copy ${path.basename(from)}?`, `${from}\n-> ${to}`))) return { error: 'The operator declined.' };
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, errorOnExist: true });
      return { ok: true, from, to };
    },
  },
  {
    name: 'delete_path',
    owner: 'hephaestus',
    description: 'Send a file or folder to the Recycle Bin (recoverable). Asks the operator first.',
    parameters: obj({ path: S('Path to delete') }, ['path']),
    label: (a) => `recycle ${path.basename(str(a, 'path'))}`,
    run: async (args, ctx) => {
      const target = resolveSafe(str(args, 'path'));
      if (!fs.existsSync(target)) return { error: `${target} does not exist.` };
      if (roots().some((r) => r.toLowerCase() === target.toLowerCase())) return { error: 'Refusing to delete a whole root folder.' };
      const ok = await ctx.approve('delete', `Send ${path.basename(target)} to the Recycle Bin?`, target);
      if (!ok) return { error: 'The operator declined.' };
      await shell.trashItem(target);
      return { ok: true, recycled: target };
    },
  },
  {
    name: 'organize_folder',
    owner: 'hephaestus',
    description: 'Tidy a messy folder (e.g. Downloads) by moving its loose files into subfolders by type (Images, Documents, Videos, Audio, Archives, Installers, Code, Other) or by month. Run with dry_run true first to see the plan; running for real asks the operator once.',
    parameters: obj({
      folder: S('Folder to organize'),
      scheme: S('"type" (default) or "month"', { enum: ['type', 'month'] }),
      dry_run: B('true = only report the plan (default true)'),
    }, ['folder']),
    label: (a) => `organize ${str(a, 'folder')}${bool(a, 'dry_run', true) ? ' (plan)' : ''}`,
    run: async (args, ctx) => {
      const folder = resolveSafe(str(args, 'folder'));
      const scheme = str(args, 'scheme', 'type') === 'month' ? 'month' : 'type';
      const dry = bool(args, 'dry_run', true);
      const moves: { from: string; bucket: string }[] = [];
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.') || /^desktop\.ini$/i.test(e.name)) continue;
        const full = path.join(folder, e.name);
        let bucket = 'Other';
        if (scheme === 'type') bucket = TYPE_BUCKETS.find(([, re]) => re.test(e.name))?.[0] ?? 'Other';
        else bucket = new Date(fs.statSync(full).mtimeMs).toISOString().slice(0, 7);
        moves.push({ from: full, bucket });
      }
      const counts: Record<string, number> = {};
      for (const m of moves) counts[m.bucket] = (counts[m.bucket] ?? 0) + 1;
      if (!moves.length) return { folder, note: 'No loose files to organize.' };
      if (dry) return { folder, plan: counts, files: moves.length, note: 'Dry run - nothing moved. Call again with dry_run false to do it.' };
      const ok = await ctx.approve('organize', `Organize ${moves.length} files in ${path.basename(folder)}?`,
        `${folder}\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('\n')}`);
      if (!ok) return { error: 'The operator declined.' };
      let moved = 0;
      for (const m of moves) {
        try {
          const dest = uniqueTarget(path.join(folder, m.bucket, path.basename(m.from)));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(m.from, dest);
          moved++;
        } catch { /* file in use - leave it */ }
      }
      return { ok: true, folder, moved, plan: counts };
    },
  },
  {
    name: 'open_path',
    owner: 'hephaestus',
    description: 'Open a file or folder on the operator\'s screen with its default app (e.g. open a document, show a folder in Explorer).',
    parameters: obj({ path: S('File or folder path') }, ['path']),
    label: (a) => `open ${path.basename(str(a, 'path'))}`,
    run: async (args, ctx) => {
      const target = resolveSafe(str(args, 'path'));
      if (!fs.existsSync(target)) return { error: `${target} does not exist.` };
      if (EXEC_EXT.test(target)) {
        const ok = await ctx.approve('run-program', `Run ${path.basename(target)}?`, `${target}\nOpening this runs a program or script.`);
        if (!ok) return { error: 'The operator declined.' };
      }
      const err = await shell.openPath(target);
      return err ? { error: err } : { ok: true, opened: target };
    },
  },
  {
    name: 'file_info',
    owner: 'hephaestus',
    description: 'Size, dates and type of a file or folder (folders: total size and file count, capped).',
    parameters: obj({ path: S('Path') }, ['path']),
    label: (a) => `info ${path.basename(str(a, 'path'))}`,
    run: async (args) => {
      const target = resolveSafe(str(args, 'path'));
      const st = fs.statSync(target);
      if (!st.isDirectory()) return { path: target, size: fmtSize(st.size), modified: new Date(st.mtimeMs).toISOString(), created: new Date(st.birthtimeMs).toISOString() };
      let total = 0;
      let files = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 6 || files > 50_000) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else { try { total += fs.statSync(full).size; files++; } catch { /* skip */ } }
        }
      };
      walk(target, 0);
      return { path: target, folder: true, files, size: fmtSize(total), modified: new Date(st.mtimeMs).toISOString() };
    },
  },
  {
    name: 'run_command',
    owner: 'hephaestus',
    description: 'Run a PowerShell command on the operator\'s PC and return its output (60s limit). ALWAYS asks the operator first and shows them the exact command. Prefer the file tools when they can do the job.',
    parameters: obj({ command: S('PowerShell command'), working_dir: S('Folder to run it in (default: user folder)'), why: S('One line: why this command is needed') }, ['command', 'why']),
    label: (a) => `powershell: ${str(a, 'command').slice(0, 60)}`,
    run: async (args, ctx) => {
      const command = str(args, 'command').trim();
      if (!command) return { error: 'Empty command.' };
      const cwd = str(args, 'working_dir') ? resolveSafe(str(args, 'working_dir')) : os.homedir();
      const ok = await ctx.approve('command', 'Run this PowerShell command?', `${str(args, 'why')}\n\n> ${command}\n\n(in ${cwd})`);
      if (!ok) return { error: 'The operator declined.' };
      return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          resolve({
            exitCode: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
            stdout: clip(stdout, 8000),
            stderr: clip(stderr, 3000),
            timedOut: Boolean(err && (err as { killed?: boolean }).killed),
          });
        });
      });
    },
  },
];

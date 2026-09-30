import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { ultron } from '../services/bridge';
import { FileEditor } from './FileEditor';
import type { IndexedFile } from '../types';

const fmtSize = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
};

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm',
  'xml', 'yml', 'yaml', 'csv', 'log', 'ini', 'cfg', 'conf', 'py', 'java', 'c', 'cpp',
  'h', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'sql', 'toml', 'env',
]);
const isTextLike = (ext: string) => TEXT_EXTS.has(ext.toLowerCase());

/**
 * Indexes only folders the operator explicitly adds. There is no "scan my
 * whole computer" path here, by design. Edit/rename/move/delete all reuse
 * that same allowlist on the main-process side - this UI is just the
 * front end for it, not an extra trust boundary of its own.
 */
export function FilePanel() {
  const folders = useStore((s) => s.folders);
  const setFolders = useStore((s) => s.setFolders);
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ folderCount: 0, fileCount: 0, capped: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newFileFor, setNewFileFor] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const reqSeq = useRef(0);

  const reload = async () => {
    const [list, st] = await Promise.all([ultron.files.list(200), ultron.files.stats()]);
    setFiles(list);
    setStats(st);
  };

  useEffect(() => { void reload(); }, [folders.length]);

  // Stale-response guard: an older debounced search that resolves after a
  // newer one would otherwise silently overwrite fresher results.
  useEffect(() => {
    const id = setTimeout(() => {
      const myReq = ++reqSeq.current;
      void (query.trim() ? ultron.files.search(query) : ultron.files.list(200)).then((list) => {
        if (myReq === reqSeq.current) setFiles(list);
      });
    }, 180);
    return () => clearTimeout(id);
  }, [query]);

  const addFolder = async () => {
    setBusy(true);
    try {
      const res = await ultron.files.addFolder();
      if (res.ok) { setFolders(res.folders); await reload(); }
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (p: string) => {
    setFolders(await ultron.files.removeFolder(p));
    await reload();
  };

  const startRename = (f: IndexedFile, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenaming(f.path);
    setRenameDraft(f.name);
  };

  const commitRename = async (f: IndexedFile) => {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === f.name) return;
    const res = await ultron.files.rename(f.path, name);
    if (res.ok) void reload();
  };

  const handleDelete = async (f: IndexedFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete !== f.path) { setConfirmDelete(f.path); return; }
    setConfirmDelete(null);
    const res = await ultron.files.delete(f.path);
    if (res.ok) void reload();
  };

  const createFile = async (folderPath: string) => {
    const name = newFileName.trim();
    setNewFileFor(null);
    setNewFileName('');
    if (!name) return;
    const res = await ultron.files.createFile(folderPath, name);
    if (res.ok) { await reload(); if (res.path) setEditing(res.path); }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6, padding: '10px 12px', borderBottom: '1px solid var(--cyan-20)', flex: '0 0 auto' }}>
        <button className="hud-btn" onClick={addFolder} disabled={busy} title="Opens at your user folder - pick it, or any subfolder, or navigate up to a whole drive for full access">
          {busy ? 'Indexing' : '+ Add folder'}
        </button>
        <button className="hud-btn" onClick={() => void ultron.files.rebuild().then(reload)} disabled={!folders.length}>
          Re-index
        </button>
      </div>

      {folders.length === 0 ? (
        <div className="empty-note">
          No folders indexed yet. This tab is a quick browser for folders you add. Ultron's
          operator agent (Hephaestus) can already work anywhere in your user folder - finding,
          reading, writing and organizing files - and asks before anything that overwrites,
          moves or deletes. Add a folder here to browse it, or to give Hephaestus a folder
          outside your user folder (another drive, say).
        </div>
      ) : (
        <>
          <div style={{ flex: '0 0 auto' }}>
            {folders.map((f) => (
              <div key={f.path}>
                <div className="folder-row">
                  <span className="dot" style={{ color: 'var(--cyan)' }} />
                  <span className="folder-row__path" title={f.path}>{f.path}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)' }}>{f.fileCount}</span>
                  <div className="folder-row__actions">
                    <button
                      className="file-row__icon-btn"
                      title="New file here"
                      onClick={() => { setNewFileFor(f.path); setNewFileName(''); }}
                    >
                      +
                    </button>
                    <button className="hud-btn hud-btn--danger" onClick={() => void removeFolder(f.path)}>x</button>
                  </div>
                </div>
                {newFileFor === f.path && (
                  <div className="new-item-row">
                    <input
                      className="hud-input"
                      autoFocus
                      placeholder="new-file.md"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFile(f.path);
                        if (e.key === 'Escape') setNewFileFor(null);
                      }}
                      onBlur={() => void createFile(f.path)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ padding: '8px 12px', flex: '0 0 auto' }}>
            <input
              className="hud-input"
              placeholder="Search indexed files..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="mono" style={{ fontSize: 9.5, color: 'var(--dimmer)', marginTop: 5 }}>
              {stats.fileCount} files indexed across {stats.folderCount} folder{stats.folderCount === 1 ? '' : 's'}
              {stats.capped ? ' (index cap reached)' : ''} - showing {files.length}
            </div>
          </div>

          <div className="panel-body" style={{ flex: '1 1 auto' }}>
            {files.length === 0 ? (
              <div className="empty-note">No matches.</div>
            ) : (
              files.map((f) => (
                <div
                  key={f.path}
                  className="file-row"
                  onClick={() => (isTextLike(f.ext) ? setEditing(f.path) : void ultron.files.reveal(f.path))}
                  title={f.path}
                >
                  <span className="file-row__ext">{f.ext.slice(0, 4)}</span>
                  <span style={{ minWidth: 0 }}>
                    {renaming === f.path ? (
                      <input
                        className="file-row__rename-input"
                        autoFocus
                        value={renameDraft}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(f);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={() => void commitRename(f)}
                      />
                    ) : (
                      <span className="file-row__name">{f.name}</span>
                    )}
                    <span className="file-row__path" style={{ display: 'block' }}>{f.path}</span>
                  </span>
                  <span className="file-row__size">{fmtSize(f.size)}</span>
                  <div className="file-row__actions">
                    {isTextLike(f.ext) && (
                      <button
                        className="file-row__icon-btn"
                        title="Edit"
                        onClick={(e) => { e.stopPropagation(); setEditing(f.path); }}
                      >
                        Ed
                      </button>
                    )}
                    <button className="file-row__icon-btn" title="Rename" onClick={(e) => startRename(f, e)}>
                      Rn
                    </button>
                    <button
                      className={`file-row__icon-btn ${confirmDelete === f.path ? 'file-row__icon-btn--confirm' : 'file-row__icon-btn--danger'}`}
                      title={confirmDelete === f.path ? 'Click again to move to Recycle Bin' : 'Delete'}
                      onClick={(e) => void handleDelete(f, e)}
                    >
                      {confirmDelete === f.path ? '?' : 'Del'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {editing && <FileEditor path={editing} onClose={() => { setEditing(null); void reload(); }} />}
    </>
  );
}

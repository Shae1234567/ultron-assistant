import { Tray, Menu, app } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * Tray + background mode. Closing the window hides Ultron to the tray instead
 * of quitting, which is what keeps reminders and the wake word working. Only
 * the tray's Quit (or an OS shutdown) ends the process.
 */

let tray: Tray | null = null;
let forceQuit = false;

export function setupTray(win: BrowserWindow, iconPath: string): void {
  app.on('before-quit', () => { forceQuit = true; });

  win.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      win.hide();
    }
  });

  tray = new Tray(iconPath);
  tray.setToolTip('Ultron');

  const show = () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: 'Show Ultron', click: show },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: isAutoLaunchEnabled(),
        click: (item) => setAutoLaunch(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit Ultron', click: () => { forceQuit = true; app.quit(); } },
    ]);

  tray.setContextMenu(buildMenu());
  tray.on('double-click', show);
  tray.on('click', show);
}

export function isAutoLaunchEnabled(): boolean {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

/**
 * Starts hidden in the tray at login, so reminders fire without a window
 * popping up. Installed app only - from a dev checkout this would register
 * the bare Electron runtime, which opens an empty window at login.
 */
export function setAutoLaunch(enabled: boolean): boolean {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  return true;
}

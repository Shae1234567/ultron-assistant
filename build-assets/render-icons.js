const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const OUT_DIR = path.join(__dirname, 'png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });

  await win.loadFile(path.join(__dirname, 'icon-source.html'));
  await sleep(300);

  for (const size of SIZES) {
    win.setContentSize(size, size);
    await sleep(180);
    const image = await win.webContents.capturePage();
    const out = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(out, image.toPNG());
    console.log(`[icons] rendered ${size}x${size} -> ${out}`);
  }

  console.log('[icons] done');
  app.quit();
});

process.on('unhandledRejection', (e) => console.error('[icons] unhandled:', e));

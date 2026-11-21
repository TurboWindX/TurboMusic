/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 *   npm run screenshots
 *
 * Starts a throwaway server on its own port with an empty temp data dir (so only
 * the built-in demo song shows up, never your own imported songs), then drives
 * headless Chrome through the app with puppeteer-core.
 *
 * Chrome is found automatically on Windows/macOS/Linux; override with CHROME_PATH.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Page } from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.SCREENSHOT_PORT ?? 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = 'demo-couch-duet';
const VIEWPORT = { width: 1920, height: 1080 }; // what the TV shows

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((p): p is string => !!p);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('Chrome not found. Set CHROME_PATH to your chrome/chromium/edge executable.');
  return hit;
}

function startServer(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    // No API key / password: screenshots show the app exactly as a fresh clone would.
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', APP_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
  } else child.kill('SIGTERM');
}

async function waitForServer(timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${BASE}/api/songs`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start on ${BASE}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(page: Page, hash: string, waitFor: string) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(waitFor, { timeout: 10000 });
  await sleep(400); // let fonts/layout settle
}

async function shot(page: Page, name: string, height?: number) {
  const file = path.join(OUT, `${name}.png`);
  const clip = height ? { x: 0, y: 0, width: VIEWPORT.width, height } : undefined;
  await page.screenshot({ path: file as `${string}.png`, clip });
  console.log(`  ✓ ${path.relative(ROOT, file)}`);
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ missing: run `npx vite build` first (npm run screenshots does this for you).');
  }
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'turbomusic-shots-'));
  const server = startServer(dataDir);
  const cleanup = () => { stopServer(server); rmSync(dataDir, { recursive: true, force: true }); };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    defaultViewport: VIEWPORT,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--autoplay-policy=no-user-gesture-required', // let the audio engine run without a click
      '--use-fake-ui-for-media-stream', // tuner: auto-allow the mic...
      '--use-fake-device-for-media-stream', // ...and feed it Chrome's test tone
      '--hide-scrollbars',
    ],
  });

  try {
    await waitForServer();
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('  page error:', err));
    console.log('Taking screenshots:');

    // Library
    await open(page, '#/', '.song-card');
    await shot(page, 'library', 480); // the rest is empty with just the demo song

    // Player, mid-song: start playback and let it run past the count-in.
    await open(page, `#/play/${DEMO}`, '.player');
    await page.keyboard.press('ArrowRight'); // skip to bar 2 so both lanes have something going on
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await sleep(5500);
    await page.keyboard.press('Space'); // pause so the frame is stable
    await sleep(300);
    await shot(page, 'player');

    // Chord sheet overlay
    await page.keyboard.press('c');
    await page.waitForSelector('.chord-sheet');
    await sleep(300);
    await shot(page, 'chord-sheet');
    await page.keyboard.press('c');

    // Keyboard help overlay
    await page.keyboard.press('?');
    await sleep(300);
    await shot(page, 'help');
    await page.keyboard.press('Escape');

    // Editor
    await open(page, `#/edit/${DEMO}`, 'textarea');
    await shot(page, 'editor');

    // Chord-change drill
    await open(page, '#/drill/C,G', '.drill-stage');
    await page.click('button.play');
    await sleep(5500); // past the 4-beat count-in at 60 bpm, into the first chord
    await shot(page, 'drill');

    // Tuner (fake mic tone)
    await open(page, '#/tuner', '.page');
    const startBtn = await page.$('button.primary.big');
    if (startBtn) { await startBtn.click(); await sleep(1500); }
    await shot(page, 'tuner');

    console.log(`Done → ${path.relative(ROOT, OUT)}`);
  } finally {
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

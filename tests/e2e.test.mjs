// End-to-end tests: a real Chromium with the extension loaded,
// gestures are performed with a "physical" mouse through Playwright.
// Run: npm test   (HEADED=1 npm test shows the browser window)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));

// The page is long so it can be scrolled. #box is a separate scrollable block.
// The iframe spans x 200–600, y 100–400. The page script counts the context menus shown.
const page = (title, body = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; height: 5000px; font: 16px sans-serif; }
  #box { position: fixed; left: 600px; top: 100px; width: 300px; height: 200px; overflow: auto; }
  #box div { height: 2000px; }
  iframe { position: fixed; left: 200px; top: 100px; width: 400px; height: 300px; border: 0; }
</style>
<script>
  window.menus = 0;
  addEventListener('contextmenu', () => menus++);
  addEventListener('mousemove', () => (window.hovered = true));
</script>
</head><body><h1>${title}</h1>${body}</body></html>`;

const PAGES = {
  '/one': page('one'),
  '/two': page('two'),
  '/scroll': page('scroll', '<div id="box"><div>box</div></div>'),
  '/frame': page('frame', '<iframe src="/inner"></iframe>'),
  // The same, but the iframe comes from another site and runs in a separate process.
  '/xframe': page('xframe', '<iframe src="__XORIGIN__/inner"></iframe>'),
  '/inner': page('inner'),
};

const MOVES = {
  L: [[-150, 0]],
  R: [[150, 0]],
  U: [[0, -150]],
  D: [[0, 150]],
  LR: [[-150, 0], [150, 0]],
  DR: [[0, 150], [150, 0]],
  RL: [[150, 0], [-150, 0]],
  tiny: [[10, 8]],
};

let server;
let origin;
let xorigin;
let context;

before(async () => {
  server = createServer((req, res) => {
    const html = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end((html ?? 'not found').replace('__XORIGIN__', xorigin));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  xorigin = `http://localhost:${server.address().port}`;

  // Empty path: Playwright creates and removes a temporary profile itself.
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  // The extension's service worker appears only if the manifest was accepted.
  if (!context.serviceWorkers().length) {
    await context.waitForEvent('serviceworker', { timeout: 10_000 });
  }
});

after(async () => {
  await context?.close();
  server?.close();
});

async function open(...paths) {
  const p = await context.newPage();
  for (const path of paths) await p.goto(origin + path);
  // Right after loading, Chromium may still send mouse input over an iframe to the
  // top frame for a moment. Wait until the iframe receives the mouse itself.
  for (let i = 0; p.frames().length > 1; i++) {
    await p.mouse.move(400 + (i % 2), 250);
    if (await p.frames()[1].evaluate(() => window.hovered)) break;
    if (i === 100) throw new Error('the iframe does not receive mouse input');
    await pause(20);
  }
  return p;
}

async function gesture(p, name, { start = [200, 300], beforeUp } = {}) {
  let [x, y] = start;
  await p.mouse.move(x, y);
  await p.mouse.down({ button: 'right' });
  for (const [dx, dy] of MOVES[name]) {
    x += dx;
    y += dy;
    await p.mouse.move(x, y, { steps: 8 });
  }
  if (beforeUp) await beforeUp();
  await p.mouse.up({ button: 'right' });
}

const menus = (p) => p.evaluate(() => window.menus);
const frameMenus = (p) => p.frames()[1].evaluate(() => window.menus);
const frameScroll = (p) =>
  p.frames()[1].evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const scrollState = (p) =>
  p.evaluate(() => ({
    page: scrollY,
    pageMax: document.documentElement.scrollHeight - innerHeight,
    box: document.querySelector('#box')?.scrollTop,
    boxMax: (() => {
      const b = document.querySelector('#box');
      return b && b.scrollHeight - b.clientHeight;
    })(),
  }));

test('a plain right click opens the context menu', async () => {
  const p = await open('/one');
  await p.mouse.click(200, 300, { button: 'right' });
  assert.equal(await menus(p), 1);
  await p.close();
});

test('a move below the threshold is not a gesture: the menu opens, the page stays', async () => {
  const p = await open('/one', '/two');
  await gesture(p, 'tiny');
  await pause();
  assert.equal(await menus(p), 1);
  assert.equal(p.url(), origin + '/two');
  await p.close();
});

test('← back: the hint is shown during the gesture, no menu after it', async () => {
  const p = await open('/one', '/two');
  await gesture(p, 'L', {
    beforeUp: async () => {
      await p.waitForSelector('mouse-gestures-overlay', { state: 'attached', timeout: 2000 });
      // The hint is in the browser's top layer, above modal dialogs and fullscreen.
      assert.ok(await p.evaluate(() => document.querySelector('mouse-gestures-overlay').matches(':popover-open')));
      if (process.env.SCREENSHOT) await p.screenshot({ path: process.env.SCREENSHOT });
    },
  });
  await p.waitForURL(origin + '/one');
  assert.equal(await p.locator('mouse-gestures-overlay').count(), 0);
  await p.close();
});

test('→ forward', async () => {
  const p = await open('/one', '/two');
  await p.goBack();
  await gesture(p, 'R');
  await p.waitForURL(origin + '/two');
  await p.close();
});

test('↓ and ↑ scroll the page to the bottom and to the top', async () => {
  const p = await open('/scroll');
  await gesture(p, 'D');
  let s = await scrollState(p);
  assert.ok(s.pageMax > 0);
  assert.equal(s.page, s.pageMax);
  await gesture(p, 'U');
  s = await scrollState(p);
  assert.equal(s.page, 0);
  assert.equal(await menus(p), 0);
  await p.close();
});

test('↓ over a scrollable block scrolls the block first, then the page', async () => {
  const p = await open('/scroll');
  await gesture(p, 'D', { start: [700, 120] });
  let s = await scrollState(p);
  assert.equal(s.box, s.boxMax);
  assert.equal(s.page, 0);
  await gesture(p, 'D', { start: [700, 120] });
  s = await scrollState(p);
  assert.equal(s.page, s.pageMax);
  await p.close();
});

test('←→ opens a new tab, the current one stays put', async () => {
  const p = await open('/one', '/two');
  const opened = context.waitForEvent('page', { timeout: 3000 });
  await gesture(p, 'LR');
  const tab = await opened;
  await pause();
  assert.equal(p.url(), origin + '/two');
  assert.equal(await menus(p), 0);
  await tab.close();
  await p.close();
});

test('↓→ closes the tab', async () => {
  const p = await open('/one');
  const closed = p.waitForEvent('close', { timeout: 3000 });
  await gesture(p, 'DR');
  await closed;
});

test('an unknown gesture does nothing and opens no menu', async () => {
  const p = await open('/one', '/two');
  await gesture(p, 'RL');
  await pause();
  assert.equal(p.url(), origin + '/two');
  assert.equal(await menus(p), 0);
  await p.close();
});

test('Esc during a gesture cancels it', async () => {
  const p = await open('/one', '/two');
  await gesture(p, 'L', {
    beforeUp: async () => {
      await p.waitForSelector('mouse-gestures-overlay', { state: 'attached', timeout: 2000 });
      await p.keyboard.press('Escape');
      await p.waitForSelector('mouse-gestures-overlay', { state: 'detached', timeout: 2000 });
    },
  });
  await pause();
  assert.equal(p.url(), origin + '/two');
  assert.equal(await menus(p), 0);
  await p.close();
});

for (const [path, kind] of [
  ['/frame', 'same-site'],
  ['/xframe', 'cross-site'],
]) {
  test(`${kind} iframe: a gesture inside it acts on the whole tab`, async () => {
    const p = await open('/one', path);
    await gesture(p, 'L', { start: [450, 250] });
    await p.waitForURL(origin + '/one');
    await p.close();
  });

  test(`${kind} iframe: a gesture from inside to outside works`, async () => {
    const p = await open('/one', path);
    await gesture(p, 'L', { start: [300, 250] });
    await p.waitForURL(origin + '/one');
    await p.close();
  });

  test(`${kind} iframe: a gesture from outside to inside works`, async () => {
    const p = await open('/one', path);
    await gesture(p, 'L', { start: [700, 250] });
    await p.waitForURL(origin + '/one');
    await p.close();
  });

  test(`${kind} iframe: ↓ started inside scrolls the iframe, no menu anywhere`, async () => {
    const p = await open(path);
    if (process.env.SCREENSHOT) {
      await gesture(p, 'D', {
        start: [300, 300],
        beforeUp: async () => {
          await pause(100);
          await p.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, `-${kind}.png`) });
        },
      });
    } else {
      await gesture(p, 'D', { start: [300, 300] });
    }
    await pause();
    const s = await frameScroll(p);
    assert.ok(s.max > 0);
    assert.equal(s.y, s.max);
    assert.equal(await menus(p), 0);
    assert.equal(await frameMenus(p), 0);
    await p.close();
  });

  test(`${kind} iframe: ↓ started outside scrolls the page, no menu anywhere`, async () => {
    const p = await open(path);
    await gesture(p, 'D', { start: [400, 50] });
    await pause();
    const s = await scrollState(p);
    assert.equal(s.page, s.pageMax);
    assert.equal((await frameScroll(p)).y, 0);
    assert.equal(await menus(p), 0);
    assert.equal(await frameMenus(p), 0);
    await p.close();
  });
}

test('synthetic events from page scripts are ignored', async () => {
  const p = await open('/scroll');
  await p.evaluate(() => {
    const ev = (type, y, init) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 200, clientY: y, ...init });
    document.body.dispatchEvent(ev('mousedown', 300, { button: 2, buttons: 2 }));
    for (let i = 1; i <= 8; i++) document.body.dispatchEvent(ev('mousemove', 300 + i * 20, { buttons: 2 }));
    document.body.dispatchEvent(ev('mouseup', 460, { button: 2 }));
  });
  await pause();
  assert.equal((await scrollState(p)).page, 0);
  await p.close();
});

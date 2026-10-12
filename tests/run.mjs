// End-to-end tests: loads the unpacked extension in Chromium (new headless) via Puppeteer.
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(await fs.readFile(FIXTURE));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

// In real use the editor is injected thanks to activeTab (granted when the user clicks the
// toolbar button or presses the shortcut). Automation cannot produce that user gesture, so the
// tests load a temporary copy whose manifest additionally grants http://127.0.0.1/* only.
const EXT = await fs.mkdtemp(path.join(os.tmpdir(), 'siteedit-ext-'));
for (const entry of ['manifest.json', 'src']) await fs.cp(path.join(ROOT, entry), path.join(EXT, entry), { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await fs.writeFile(path.join(EXT, 'manifest.json'), JSON.stringify(manifest));

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

const errors = [];
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ✓', name); }
  catch (e) { results.push([false, name]); console.log('  ✗', name, '\n   ', e.message); }
}

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'));
  const worker = await swTarget.worker();
  worker.on('console', (m) => { if (m.type() === 'error') errors.push('[sw] ' + m.text()); });
  const extId = new URL(swTarget.url()).host;

  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[page] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  const tabId = async () => worker.evaluate(async (u) => {
    for (const t of await chrome.tabs.query({})) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => location.href });
        if (r.result.startsWith(u)) return t.id;
      } catch (_) { /* not scriptable */ }
    }
    throw new Error('test tab not found');
  }, URL_);
  // Run a function inside the content-script isolated world of the test tab.
  const iso = async (fnSrc, ...args) => {
    const id = await tabId();
    return worker.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${id} }, func: ${fnSrc}, args: ${JSON.stringify(args)} }).then(r => r[0].result)`);
  };
  const css = (sel, prop) => page.$eval(sel, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  const openEditor = async () => { await worker.evaluate((id) => globalThis.toggleEditor(id), await tabId()); await page.waitForSelector('siteedit-panel >>> .panel'); };
  const state = () => iso('() => globalThis.__siteEditEditor._test.getState()');
  const stored = () => worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] || null, 'site:127.0.0.1');
  const setField = async (prop, value) => {
    const input = await page.waitForSelector(`siteedit-panel >>> [data-prop="${prop}"]`);
    await input.click({ clickCount: 3 });
    await input.type(value);
    await page.keyboard.press('Enter');
    await sleep(150);
  };
  const setColor = async (prop, value) => {
    const input = await page.waitForSelector(`siteedit-panel >>> [data-prop-text="${prop}"]`);
    await input.click({ clickCount: 3 }); await input.type(value); await page.keyboard.press('Tab'); await sleep(150);
  };
  const action = async (a) => { await (await page.waitForSelector(`siteedit-panel >>> button[data-action="${a}"]`)).click(); await sleep(150); };
  const pick = async (sel) => { await action('pick'); const el = await page.$(sel); await el.hover(); await sleep(50); await el.click(); await sleep(100); };

  console.log('SiteEdit e2e tests');
  await page.goto(URL_, { waitUntil: 'load' });

  await test('content script loads and editor panel opens in Shadow DOM', async () => {
    await openEditor();
    const isShadow = await page.$eval('siteedit-panel', (el) => !!el.shadowRoot);
    assert.ok(isShadow);
  });

  await test('hover highlight appears while picking and Esc cancels', async () => {
    await action('pick');
    await (await page.$('#title')).hover(); await sleep(80);
    const shown = await page.$eval('siteedit-panel', (h) => h.shadowRoot.querySelector('.hl:not(.sel)').style.display);
    assert.equal(shown, 'block');
    await page.keyboard.press('Escape'); await sleep(50);
    await (await page.$('#btn')).click();
    assert.equal(await page.evaluate(() => window.__clicked), 1, 'page click works after cancel');
    assert.equal((await state()).selector, null);
  });

  await test('selecting an element blocks page click and builds a robust selector', async () => {
    await pick('#btn');
    assert.equal(await page.evaluate(() => window.__clicked), 1, 'click swallowed while picking');
    assert.equal((await state()).selector, '#btn');
    await pick('.card:nth-of-type(2) .label');
    const sel = (await state()).selector;
    assert.equal(await page.$$eval(sel, (els) => els.length), 1, 'selector unique: ' + sel);
    assert.equal(await page.$eval(sel, (e) => e.textContent), 'Second card');
  });

  await test('apply colors, font, size, spacing, border with live preview', async () => {
    await pick('#title');
    await setColor('color', '#ff0000');
    await setColor('background-color', 'rgb(0, 0, 255)');
    await page.$eval('siteedit-panel', (h) => { const s = h.shadowRoot.querySelector('[data-prop="font-family"]'); s.value = 'Georgia, serif'; s.dispatchEvent(new Event('change')); });
    await setField('font-size', '40');
    await setField('padding', '12px 6px');
    await setField('border-width', '3');
    await page.$eval('siteedit-panel', (h) => { const s = h.shadowRoot.querySelector('[data-prop="border-style"]'); s.value = 'dashed'; s.dispatchEvent(new Event('change')); });
    await sleep(150);
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
    assert.equal(await css('#title', 'background-color'), 'rgb(0, 0, 255)');
    assert.match(await css('#title', 'font-family'), /Georgia/);
    assert.equal(await css('#title', 'font-size'), '40px');
    assert.equal(await css('#title', 'padding-top'), '12px');
    assert.equal(await css('#title', 'border-top-width'), '3px');
    assert.equal(await css('#title', 'border-top-style'), 'dashed');
  });

  await test('invalid / malicious CSS values are rejected', async () => {
    await setField('font-size', 'red; } body { display:none');
    assert.equal(await css('#title', 'font-size'), '40px');
    assert.equal(await css('body', 'display'), 'block');
    const s = await stored();
    assert.equal(s.rules['#title']['font-size'], '40px');
  });

  await test('changes are saved per hostname in chrome.storage.local', async () => {
    const s = await stored();
    assert.ok(s && s.rules['#title']);
    assert.equal(s.rules['#title'].color, '#ff0000');
  });

  await test('undo / redo', async () => {
    const before = await state();
    await action('undo');
    assert.equal(await css('#title', 'border-top-style'), 'solid', 'border-style undone (width alone renders solid)');
    await action('undo');
    assert.equal(await css('#title', 'border-top-width'), '0px');
    await action('redo');
    await action('redo');
    assert.equal(await css('#title', 'border-top-style'), 'dashed');
    const after = await state();
    assert.deepEqual(after.committed, before.committed);
    // Keyboard shortcut Ctrl+Z inside panel (focus on a button, not a text field)
    const btn = await page.waitForSelector('siteedit-panel >>> button[data-action="undo"]');
    await btn.focus();
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await sleep(150);
    assert.equal(await css('#title', 'border-top-style'), 'solid');
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await sleep(150);
    assert.equal(await css('#title', 'border-top-style'), 'dashed');
  });

  await test('element without id: child-combinator selector is saved and applied', async () => {
    await pick('aside.learn header');
    const sel = (await state()).selector;
    assert.ok(sel.includes('>') && !sel.includes('#'), 'selector: ' + sel);
    await setColor('color', '#ff00ff');
    await setField('border-width', '2');
    assert.equal(await css('aside.learn header', 'color'), 'rgb(255, 0, 255)');
    assert.equal(await css('aside.learn header', 'border-top-style'), 'solid', 'width alone gets a solid border');
    assert.equal(await css('aside.learn header', 'border-top-width'), '2px');
    const s = await stored();
    assert.equal(s.rules[sel].color, '#ff00ff');
    assert.deepEqual((await state()).committed[sel], s.rules[sel], 'committed matches storage');
  });

  await test('hashed class names (styled-components / CSS modules) are skipped', async () => {
    await pick('.rows > div:nth-of-type(2) > b');
    const sel = (await state()).selector;
    assert.ok(!/kOSbdU|topRow|Header_title/.test(sel), 'selector: ' + sel);
    assert.match(sel, /nth-of-type\(2\)/);
    assert.equal(await page.$$eval(sel, (els) => els.length), 1);
    assert.equal(await page.$eval(sel, (e) => e.textContent), 'Row B');
    await setField('font-size', '22');
    assert.equal(await css('.rows > div:nth-of-type(2) > b', 'font-size'), '22px');
    assert.notEqual(await css('.rows > div:nth-of-type(1) > b', 'font-size'), '22px');
  });

  await test('html / body cannot be hidden', async () => {
    await iso('() => globalThis.__siteEditEditor._test.select(document.body)');
    await page.$eval('siteedit-panel', (h) => h.shadowRoot.querySelector('[data-prop="display"]').click());
    await sleep(200);
    assert.equal(await css('body', 'display'), 'block');
    assert.match(await page.$eval('siteedit-panel', (h) => h.shadowRoot.querySelector('.status').textContent), /cannot be hidden/);
    assert.ok(!((await stored()).rules.body || {}).display);
  });

  await test('hide element (visibility)', async () => {
    await pick('.intro');
    await page.$eval('siteedit-panel', (h) => { const c = h.shadowRoot.querySelector('[data-prop="display"]'); c.click(); });
    await sleep(150);
    assert.equal(await css('.intro', 'display'), 'none');
  });

  await test('dynamic elements: style applied to element injected later', async () => {
    await page.waitForSelector('#late-banner');
    await pick('#late-banner');
    await setColor('color', '#00ff00');
    assert.equal(await css('#late-banner', 'color'), 'rgb(0, 255, 0)');
  });

  await test('persistence after reload (incl. late element and stylesheet reset by page)', async () => {
    await page.reload({ waitUntil: 'load' });
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
    assert.equal(await css('#title', 'font-size'), '40px');
    assert.equal(await css('.intro', 'display'), 'none');
    await page.waitForSelector('#late-banner');
    await sleep(500); // page wipes adoptedStyleSheets at 900ms; observer must reattach
    assert.equal(await css('#late-banner', 'color'), 'rgb(0, 255, 0)');
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)', 'reapplied after page reset stylesheets');
  });

  await test('reset one element', async () => {
    await openEditor();
    await pick('#late-banner');
    await action('reset-element');
    assert.equal(await css('#late-banner', 'color'), 'rgb(20, 20, 20)');
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
    assert.ok(!(await stored()).rules['#late-banner']);
  });

  let exported;
  await test('export JSON (panel)', async () => {
    exported = await iso('() => globalThis.__siteEditEditor._test.exportSite()');
    const data = JSON.parse(exported);
    assert.equal(data.format, 'siteedit');
    assert.equal(data.sites['127.0.0.1'].rules['#title'].color, '#ff0000');
  });

  await test('reset whole site, then undo it', async () => {
    await action('reset-site');
    assert.equal(await css('#title', 'color'), 'rgb(20, 20, 20)');
    assert.equal(await stored(), null);
    await action('undo');
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
    await action('reset-site');
  });

  await test('import JSON via panel file input (sanitized)', async () => {
    const data = JSON.parse(exported);
    data.sites['127.0.0.1'].rules['body'] = { 'background-color': 'url(https://evil.example/x)', color: 'expression(alert(1))' };
    data.sites['127.0.0.1'].rules['}</style><script>'] = { color: 'red' };
    data.sites['127.0.0.1'].rules['#title']['position'] = 'fixed';
    const file = path.join(os.tmpdir(), 'siteedit-import.json');
    await fs.writeFile(file, JSON.stringify(data));
    const input = await page.$('siteedit-panel >>> input[type=file]');
    await input.uploadFile(file);
    await sleep(400);
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
    const s = await stored();
    assert.deepEqual(Object.keys(s.rules).sort(), Object.keys(JSON.parse(exported).sites['127.0.0.1'].rules).sort());
    assert.equal(s.rules['#title'].position, undefined);
  });

  await test('Manager page: export all + import (merge) with garbage rejected', async () => {
    const mgr = await browser.newPage();
    mgr.on('console', (m) => { if (m.type() === 'error') errors.push('[options] ' + m.text()); });
    mgr.on('pageerror', (e) => errors.push('[options] ' + e.message));
    await mgr.goto(`chrome-extension://${extId}/src/options/options.html`);
    await mgr.waitForSelector('#sites tr');
    const json = await mgr.evaluate(() => globalThis.__siteEditManager.exportAll());
    assert.ok(JSON.parse(json).sites['127.0.0.1']);
    const n = await mgr.evaluate(() => globalThis.__siteEditManager.importText(JSON.stringify({ format: 'siteedit', sites: { 'example.com': { rules: { h1: { color: 'blue' } } }, 'bad host/../': { rules: { h1: { color: 'red' } } } } }), false));
    assert.equal(n, 1);
    await sleep(200);
    assert.equal(await mgr.$$eval('#sites tr', (r) => r.length), 2);
    // Delete asks for confirmation: dismissing keeps the site, accepting removes it.
    let answer = false;
    mgr.on('dialog', (d) => (answer ? d.accept() : d.dismiss()));
    const del = () => mgr.$eval('#sites button[data-host="example.com"]', (b) => b.click());
    await del(); await sleep(200);
    assert.equal(await mgr.$$eval('#sites tr', (r) => r.length), 2, 'dismiss keeps the site');
    answer = true; await del(); await sleep(300);
    assert.equal(await mgr.$$eval('#sites tr', (r) => r.length), 1, 'accept deletes the site');
    const bad = await mgr.evaluate(() => globalThis.__siteEditManager.importText('{"nope":1}').then(() => 'ok', (e) => e.message));
    assert.match(bad, /Not a SiteEdit/);
    await mgr.close();
  });

  await test('popup renders with the current site stats', async () => {
    const pop = await browser.newPage();
    pop.on('pageerror', (e) => errors.push('[popup] ' + e.message));
    await pop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await sleep(300);
    // Opened as a tab the "active tab" is the popup itself, so it shows the unsupported state.
    assert.equal(await pop.$eval('#host', (e) => e.textContent), 'Unsupported page');
    await pop.close();
  });

  await test('closing the panel removes it and keeps saved styles', async () => {
    await page.bringToFront();
    await action('close');
    assert.equal(await page.$('siteedit-panel'), null);
    assert.equal(await css('#title', 'color'), 'rgb(255, 0, 0)');
  });

  const ROOT_VARIANTS = ['html', 'body', '*', ':root', 'html>body', 'html > body', 'html, body', 'body,p', 'body:not(#x)',
    ':is(body)', ':where(html)', 'html:root', '*:not(siteedit-panel)', 'body >*', ':has(main)', '.page', 'body.page'];
  const rootVisible = () => page.evaluate(() => {
    const h = getComputedStyle(document.documentElement), b = getComputedStyle(document.body);
    return h.display !== 'none' && b.display !== 'none' && +h.opacity >= 0.2 && +b.opacity >= 0.2 && document.querySelector('#title').getBoundingClientRect().height > 0;
  });
  const variantsFile = async (extra = {}) => {
    const rules = {};
    for (const sel of ROOT_VARIANTS) rules[sel] = { display: 'none', opacity: '0' };
    Object.assign(rules, extra);
    const file = path.join(os.tmpdir(), 'siteedit-root-variants.json');
    await fs.writeFile(file, JSON.stringify({ format: 'siteedit', sites: { '127.0.0.1': { rules } } }));
    return file;
  };

  await test('panel is mounted on <html>, not <body>', async () => {
    await openEditor();
    assert.equal(await page.$eval('siteedit-panel', (h) => h.parentElement.localName), 'html');
  });

  await test('page-root selectors cannot blank the page via panel import', async () => {
    await action('reset-site');
    const input = await page.$('siteedit-panel >>> input[type=file]');
    await input.uploadFile(await variantsFile({ '#title': { color: 'rgb(1, 2, 3)' } }));
    await sleep(400);
    assert.equal(await css('#title', 'color'), 'rgb(1, 2, 3)', 'import itself went through');
    assert.ok(await rootVisible(), 'page still visible');
    const s = await stored();
    for (const sel of Object.keys(s.rules)) {
      if (sel === '.page') continue; // statically harmless; neutralized at runtime because body matches it
      assert.ok(!s.rules[sel].display && !s.rules[sel].opacity, 'stored blanking rule: ' + sel);
    }
    await page.reload({ waitUntil: 'load' }); await sleep(1200);
    assert.ok(await rootVisible(), 'still visible after reload');
    // Runtime guard follows body class changes.
    await page.evaluate(() => { document.body.className = 'other'; }); await sleep(300);
    await page.evaluate(() => { document.body.className = 'page'; }); await sleep(300);
    assert.ok(await rootVisible(), 'visible after body class churn');
    await openEditor();
  });

  await test('editor refuses to hide or fade html/body (including class-matched body)', async () => {
    for (const sel of ['html', 'body', '.page']) {
      await iso(`(s) => { const t = globalThis.__siteEditEditor._test; t.select(s === 'html' ? document.documentElement : document.body); }`, sel);
      await page.$eval('siteedit-panel', (h) => h.shadowRoot.querySelector('[data-prop="display"]').click());
      await iso(`() => globalThis.__siteEditEditor._test.setProp('opacity', '0', true)`);
      await sleep(250);
      assert.ok(await rootVisible(), sel);
      assert.match(await page.$eval('siteedit-panel', (h) => h.shadowRoot.querySelector('.status').textContent), /cannot be hidden/);
    }
    const s = await stored();
    assert.ok(!s.rules.body && !s.rules.html, JSON.stringify(s.rules));
    await action('reset-site');
  });

  await test('Manager import strips blanking rules for every root variant', async () => {
    const mgr = await browser.newPage();
    mgr.on('pageerror', (e) => errors.push('[options] ' + e.message));
    await mgr.goto(`chrome-extension://${extId}/src/options/options.html`);
    const text = await fs.readFile(await variantsFile({ p: { color: 'red' } }), 'utf8');
    await mgr.evaluate((t) => globalThis.__siteEditManager.importText(t, true), text);
    await mgr.close();
    const s = await stored();
    for (const sel of Object.keys(s.rules)) if (sel !== '.page') assert.ok(!s.rules[sel].display && !s.rules[sel].opacity, sel);
    await page.bringToFront();
    await page.reload({ waitUntil: 'load' }); await sleep(1200);
    assert.ok(await rootVisible());
    await openEditor();
    await action('reset-site');
  });

  await test('no console errors', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  server.close();
  await fs.rm(EXT, { recursive: true, force: true });
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

// Unit tests for src/lib/core.js (pure logic, no browser).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/core.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const Core = ctx.SiteEditCore;
let failed = 0, passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n   ', e.message); } };
console.log('SiteEdit unit tests');

test('child combinator selectors are accepted', () => {
  assert.equal(Core.validateSelector('aside.learn > header'), 'aside.learn > header');
  assert.equal(Core.validateSelector('body > div:nth-of-type(2) > span'), 'body > div:nth-of-type(2) > span');
  assert.deepEqual(Object.keys(Core.sanitizeRules({ 'aside.learn > header': { color: 'red' } })), ['aside.learn > header']);
});
test('rule-breaking selectors are rejected', () => {
  for (const s of ['a{}b', 'a;b', 'a}*{display:none', '<script>', '}</style><script>', 'a /* x */', '@import x', '', ' '.repeat(3), 'x'.repeat(1001)]) {
    assert.equal(Core.validateSelector(s), null, s);
  }
});
test('rendered CSS cannot escape its rule', () => {
  const css = Core.renderCSS({ 'a > b': { color: 'red' }, 'a}b': { color: 'red' }, p: { color: 'red;} *{display:none' } });
  assert.equal(css, 'a > b { color: red !important; }\n');
});
test('display:none is blocked on html, body, * and :root', () => {
  const out = Core.sanitizeRules({ html: { display: 'none' }, BODY: { display: 'none', color: 'red' }, '*': { display: 'none' }, ':root': { display: 'none' }, '.ad': { display: 'none' } });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { BODY: { color: 'red' }, '.ad': { display: 'none' } });
  assert.equal(Core.isProtectedSelector(' html '), true);
  assert.equal(Core.isProtectedSelector('.ad'), false);
});
const ROOT_VARIANTS = ['html', 'body', '*', ':root', 'HTML', ' body ', 'html>body', 'html > body', 'html body', 'body:not(#x)',
  ':is(body)', ':where(html)', 'html:root', 'body,p', 'html, body', '*:not(siteedit-panel)', ':not(.x)', ':has(main)',
  ':is(main, body)', 'div ~ body', 'body.home', 'html[lang]', ':where(:is(body))', '#app,body', 'body >*', 'body *', 'html > *'];
test('blanking styles are rejected on every page-root variant', () => {
  for (const sel of ROOT_VARIANTS) {
    assert.equal(Core.selectorTargetsRoot(sel), true, sel);
    const out = JSON.parse(JSON.stringify(Core.sanitizeRules({ [sel]: { display: 'none', opacity: '0', color: 'red' } })));
    const key = Object.keys(out)[0];
    assert.ok(key, 'non-blanking declaration kept: ' + sel);
    assert.deepEqual(out[key], { color: 'red' }, sel);
  }
});
test('regular elements can still be hidden', () => {
  for (const sel of ['.ad', 'body > .ad', 'html > body > div:nth-of-type(2)', 'aside.learn > header', '#banner', 'div:not(.keep)', 'main :is(p, span)']) {
    assert.equal(Core.selectorTargetsRoot(sel), false, sel);
    assert.equal(Core.sanitizeRules({ [sel]: { display: 'none' } })[sel].display, 'none', sel);
  }
  assert.equal(Core.sanitizeRules({ '.x': { opacity: '0' } })['.x'].opacity, '0');
});
test('opacity below 0.2 counts as blanking on roots, 0.5 does not', () => {
  assert.equal(Core.isBlanking('opacity', '0'), true);
  assert.equal(Core.isBlanking('opacity', '0.1'), true);
  assert.equal(Core.isBlanking('opacity', '10%'), true);
  assert.equal(Core.isBlanking('opacity', '0.5'), false);
  assert.equal(Core.sanitizeRules({ body: { opacity: '0.5' } }).body.opacity, '0.5');
});
test('import of {"html>body":{"display":"none"}} is neutralized', () => {
  const sites = Core.parseImport(JSON.stringify({ format: 'siteedit', sites: { 'todomvc.com': { rules: { 'html>body': { display: 'none' } } } } }));
  assert.deepEqual(Object.keys(sites), []);
  assert.equal(Core.renderCSS({ 'html>body': { display: 'none' } }), '');
});
test('suspicious lowercase classes are flagged conservatively', () => {
  for (const c of ['kuhblz', 'xzqrt', 'bdfgk']) assert.equal(Core.looksSuspicious(c), true, c);
  for (const c of ['learn', 'header', 'card', 'container', 'strength', 'button', 'promo', 'nav-bar', 'item']) assert.equal(Core.looksSuspicious(c), false, c);
  assert.equal(Core.looksGenerated('ssrcss-1q0x1qg-Promo'), true);
  for (const c of ['HeaderMktg', 'btn-primary', 'Button_primary', 'col-md-6', 'h-100']) assert.equal(Core.looksGenerated(c), false, c);
});
test('camelCase hashes are detected, readable camelCase is kept', () => {
  for (const c of ['GrFgy', 'ldvJot', 'bTzKq', 'kxYvRp', 'qdrfG', 'hEhfIe', 'eAbCdE']) assert.equal(Core.looksCamelHash(c), true, c);
  for (const c of ['navBar', 'isOpen', 'MainHeader', 'NavItem', 'topBar', 'HeaderMktg', 'promo', 'Card', 'myList']) assert.equal(Core.looksCamelHash(c), false, c);
});
test('class scoring prefers shared readable classes and rejects hashes / single-use', () => {
  assert.ok(Core.classScore('card', 12) > 0);
  assert.ok(Core.classScore('nav-item', 5) > 0);
  assert.ok(Core.classScore('navBar', 3) > 0);
  assert.ok(Core.classScore('card', 12) > Core.classScore('navBar', 3));
  for (const [c, n] of [['GrFgy', 4], ['ldvJot', 30], ['kuhblz', 9], ['kOSbdU', 4], ['css-1abc2d', 4], ['kuhblz', 1], ['x7k2', 1], ['x'.repeat(41), 3]]) {
    assert.ok(Core.classScore(c, n) <= 0, c);
  }
});
test('ids with random suffixes are unstable; ordinary ids are kept', () => {
  for (const id of ['offer-0-xFLa6', 'card-a8f3k2', 'post_Zk3pQ', 'GrFgy', 'ldvJot', ':r1:', 'react-aria-:R2:', 'css-1x2y3z', 'item-12345', 'a1b2c3d4e5', 'kuhblz', 'menu-kxYvRp']) {
    assert.equal(Core.isStableId(id), false, id);
  }
  for (const id of ['main-content', 'offer-1', 'title', 'firstHeading', 'nav', 'site-header', 'footer_links', 'section-2', 'mw-content-text', 'btn', 'todo-list', 'search_input', 'h2', 'user@x']) {
    assert.equal(Core.isStableId(id), true, id);
  }
});
test('single-use readable classes are kept, unreadable ones are not', () => {
  for (const c of ['learn', 'mw-page-container', 'vector-header', 'site-banner', 'footer_links', 'col-2', 'h1-title']) {
    assert.equal(Core.isReadableName(c), true, c); assert.ok(Core.classScore(c, 1) > 0, c);
  }
  for (const c of ['kuhblz', 'x7k2', 'a1b2c3', 'GrFgy', 'qdrf-zz', 'css-1x2y3z', 'mw3A', 'offer-0-6ybzf']) {
    assert.ok(Core.classScore(c, 1) <= 0, c);
  }
});
test('attribute values are screened for hashes', () => {
  for (const v of ['offer-0-6ybzf', 'card-a8f3k2', ':r1:', 'GrFgy', 'Close a1b2c3', 'x'.repeat(81)]) assert.equal(Core.isStableAttrValue(v), false, v);
  for (const v of ['todo-item-label', 'search', 'Close dialog', 'Main menu', 'q', 'submit-button', 'Page 2 of 10']) assert.equal(Core.isStableAttrValue(v), true, v);
});
test('MediaWiki ids: named mw-* are stable, Parsoid / numeric / hash ones are not', () => {
  for (const id of ['mw-content-text', 'mw-panel', 'mw-head', 'mw-page-base', 'mw-navigation', 'mw-sidebar-button']) assert.equal(Core.isStableId(id), true, id);
  for (const id of ['mwAg', 'mwBQ', 'mw3A', 'mw_1', 'mw-1234', 'toc-mw-xyz123', 'mw-xyz123']) assert.equal(Core.isStableId(id), false, id);
});
test('bogus updatedAt values are normalized', () => {
  for (const t of [1e20, -5, 'x', NaN, Infinity]) {
    const at = Core.sanitizeSite({ updatedAt: t, rules: {} }).updatedAt;
    assert.ok(Number.isFinite(at) && Math.abs(at - Date.now()) < 5000, String(t));
  }
  assert.equal(Core.sanitizeSite({ updatedAt: 1000, rules: {} }).updatedAt, 1000);
});
test('1.0.4 saved data loads unchanged', () => {
  const saved = { version: 1, updatedAt: 1760000000000, rules: { '#root > main > ul > li:nth-of-type(1) > div > label': { color: '#ff0000' }, 'aside > header': { 'border-width': '3px' } } };
  const site = Core.sanitizeSite(saved);
  assert.deepEqual(JSON.parse(JSON.stringify(site)), saved);
});
test('border width alone renders a solid border', () => {
  assert.match(Core.renderCSS({ p: { 'border-width': '3px' } }), /border-style: solid !important/);
  assert.doesNotMatch(Core.renderCSS({ p: { 'border-width': '3px', 'border-style': 'dashed' } }), /solid/);
});
test('generated class names are detected', () => {
  for (const c of ['kOSbdU', 'bZQxLp', 'hTzWlG', 'topRow__-dqkhM', 'Header_title__a1b2c', 'styles_root__3xYz', 'sc-bdVaJa', 'css-1x2y3z', 'emotion-0', 'jsx-123456', 'svelte-xyz12']) {
    assert.equal(Core.looksGenerated(c), true, c);
  }
});
test('human class names are kept', () => {
  for (const c of ['learn', 'card', 'card__title', 'nav-bar', 'navBar', 'MainHeader', 'btn_primary', 'is_open', 'header', 'NAV', 'todo-list', 'mw-body']) {
    assert.equal(Core.looksGenerated(c), false, c);
  }
});
test('import is sanitized', () => {
  const sites = Core.parseImport(JSON.stringify({ format: 'siteedit', sites: { 'Example.com': { rules: { 'main > h1': { color: 'blue', position: 'fixed' }, body: { 'background-color': 'url(x)' } } }, '<img>': { rules: { a: { color: 'red' } } } } }));
  assert.deepEqual(Object.keys(sites), ['example.com']);
  assert.deepEqual(JSON.parse(JSON.stringify(sites['example.com'].rules)), { 'main > h1': { color: 'blue' } });
  assert.throws(() => Core.parseImport('{"x":1}'), /Not a SiteEdit/);
  assert.throws(() => Core.parseImport('nope'), /not valid JSON/);
});

console.log(`\n${passed}/${passed + failed} unit tests passed\n`);
process.exit(failed ? 1 : 0);

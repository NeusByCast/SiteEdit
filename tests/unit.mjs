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

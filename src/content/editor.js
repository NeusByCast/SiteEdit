/* SiteEdit editor: in-page panel (Shadow DOM), element picker, live style editing,
 * undo/redo, reset and per-site import/export. Injected on demand via chrome.scripting. */
(function () {
  'use strict';
  if (globalThis.__siteEditEditor) { globalThis.__siteEditEditor.toggle(); return; }

  const Core = globalThis.SiteEditCore;
  const RT = globalThis.__siteEditRuntime;
  const HISTORY_LIMIT = 100;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- state ----------
  let committed = RT.getRules();
  let working = clone(committed);
  const undoStack = [];
  const redoStack = [];
  let selected = null;     // { el, selector }
  let picking = false;
  let hoverEl = null;
  let unsubscribeDom = null;

  // ---------- robust selector generation ----------
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'name', 'aria-label'];
  const looksGenerated = (s) => /\d{4,}|^[0-9]|[a-f0-9]{8,}|^(css|sc|jsx|emotion)-|__[a-z0-9]{5,}$/i.test(s);
  const STATE_CLASS = /^(is-|has-)?(active|hover|focus|focused|selected|open|opened|visible|hidden|show|current|disabled|loading)$/i;
  const esc = (s) => CSS.escape(s);
  const isUnique = (sel, el) => { try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (_) { return false; } };

  function stableId(el) {
    const id = el.id;
    return id && !looksGenerated(id) && isUnique('#' + esc(id), el) ? '#' + esc(id) : null;
  }

  function stableClasses(el) {
    return Array.from(el.classList).filter((c) => c.length < 40 && !looksGenerated(c) && !STATE_CLASS.test(c) && !c.startsWith('siteedit')).slice(0, 2);
  }

  function selectorFor(el) {
    if (!(el instanceof Element)) return null;
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const id = stableId(el);
    if (id) return id;
    const tag = el.localName;
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const sel = `${tag}[${a}="${CSS.escape(v)}"]`;
        if (isUnique(sel, el)) return sel;
      }
    }
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur !== document.documentElement && depth < 12; depth++) {
      const cid = depth > 0 && stableId(cur);
      if (cid) { parts.unshift(cid); break; }
      if (cur === document.body) { parts.unshift('body'); break; }
      let part = cur.localName + stableClasses(cur).map((c) => '.' + esc(c)).join('');
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((s) => s.matches(part));
        if (same.length > 1) {
          const sameTag = Array.from(parent.children).filter((s) => s.localName === cur.localName);
          part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (isUnique(sel, el)) return sel;
      cur = parent;
    }
    const sel = parts.join(' > ');
    return Core.validateSelector(sel);
  }

  // ---------- UI ----------
  const host = document.createElement('siteedit-panel');
  host.setAttribute('style', 'all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #7c5cff; background: rgba(124,92,255,.12); border-radius: 3px; transition: all .06s ease-out; display: none; z-index: 1; }
    .hl.sel { border-style: solid; border-color: #22d3a6; background: rgba(34,211,166,.08); }
    .hl .tag { position: absolute; left: -2px; top: -22px; font: 600 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #7c5cff; padding: 0 6px; border-radius: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .hl.sel .tag { background: #0f9f7c; }
    .panel { position: fixed; top: 16px; right: 16px; width: 320px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; z-index: 2;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e6e8ef; background: rgba(20,22,30,.97);
      border: 1px solid #2c3040; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.02) inset; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: linear-gradient(180deg,#1c1f2b,#171922); border-bottom: 1px solid #262a38; cursor: move; user-select: none; }
    .logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg,#7c5cff,#22d3a6); display: grid; place-items: center; font-weight: 800; font-size: 12px; color: #fff; }
    .title { font-weight: 650; letter-spacing: .2px; }
    .host { color: #8a90a6; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .body { overflow: auto; padding: 10px 12px 12px; scrollbar-width: thin; scrollbar-color: #3a3f55 transparent; }
    .toolbar { display: flex; gap: 6px; margin-bottom: 10px; }
    button { font: inherit; color: #e6e8ef; background: #252938; border: 1px solid #323750; border-radius: 8px; padding: 6px 10px; cursor: pointer; transition: background .12s, border-color .12s; }
    button:hover:not(:disabled) { background: #2e3346; border-color: #464c6a; }
    button:disabled { opacity: .4; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #7c5cff; outline-offset: 1px; }
    button.primary { background: #7c5cff; border-color: #7c5cff; color: #fff; font-weight: 600; flex: 1; }
    button.primary:hover { background: #6a4af0; }
    button.primary.on { background: #22d3a6; border-color: #22d3a6; color: #0b1a15; }
    button.danger { color: #ff8a8a; }
    button.icon { padding: 4px 8px; background: transparent; border-color: transparent; color: #8a90a6; }
    button.icon:hover { color: #fff; background: #2a2e3e; }
    .sel-info { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #b7a8ff; background: #1a1d28; border: 1px solid #262a38; border-radius: 8px; padding: 6px 8px; margin-bottom: 10px; word-break: break-all; }
    .sel-info.empty { color: #7a8096; font-family: inherit; font-size: 12px; }
    fieldset { border: 1px solid #262a38; border-radius: 10px; padding: 8px 10px 10px; margin: 0 0 8px; }
    fieldset:disabled { opacity: .45; }
    legend { color: #8a90a6; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 0 4px; }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .row > label { width: 78px; flex: none; color: #b4b9cc; font-size: 12px; }
    .row.mod > label::after { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #22d3a6; margin-left: 5px; vertical-align: middle; }
    input[type=text], input[type=number], select { flex: 1; min-width: 0; font: inherit; font-size: 12px; color: #e6e8ef; background: #12141b; border: 1px solid #2c3040; border-radius: 7px; padding: 5px 7px; }
    select option { background: #12141b; }
    input[type=color] { width: 34px; height: 26px; padding: 0; border: 1px solid #2c3040; border-radius: 7px; background: #12141b; cursor: pointer; }
    input[type=color]::-webkit-color-swatch-wrapper { padding: 3px; } input[type=color]::-webkit-color-swatch { border: 0; border-radius: 4px; }
    input[type=range] { flex: 1; accent-color: #7c5cff; }
    input[type=checkbox] { accent-color: #7c5cff; width: 15px; height: 15px; }
    .clear { padding: 2px 7px; font-size: 12px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px; }
    .rules { margin-top: 10px; }
    .rules summary { cursor: pointer; color: #b4b9cc; font-size: 12px; }
    .rules ul { list-style: none; margin: 6px 0 0; padding: 0; max-height: 140px; overflow: auto; }
    .rules li { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid #1f2230; }
    .rules code { flex: 1; font: 11px ui-monospace, monospace; color: #b7a8ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .status { min-height: 16px; margin-top: 8px; font-size: 11.5px; color: #8a90a6; }
    .status.err { color: #ff8a8a; } .status.ok { color: #22d3a6; }
    .hint { color: #6f7590; font-size: 11px; margin-top: 6px; }
    kbd { font: 10px ui-monospace, monospace; background: #252938; border: 1px solid #323750; border-radius: 4px; padding: 0 4px; }
  `);
  shadow.adoptedStyleSheets = [sheet];

  const FONTS = [
    ['', 'Site default'], ['system-ui, sans-serif', 'System UI'], ['Arial, Helvetica, sans-serif', 'Arial / Helvetica'],
    ['Verdana, Geneva, sans-serif', 'Verdana'], ['"Trebuchet MS", sans-serif', 'Trebuchet'], ['Georgia, serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times'], ['"Courier New", Courier, monospace', 'Courier'], ['ui-monospace, Menlo, Consolas, monospace', 'Monospace']
  ];
  const WEIGHTS = [['', 'Default'], ['300', 'Light'], ['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold'], ['900', 'Black']];
  const BORDER_STYLES = [['', 'Default'], ['none', 'None'], ['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['double', 'Double']];

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  }
  const options = (list) => list.map(([v, t]) => h('option', { value: v, text: t }));

  const controls = {}; // prop -> { row, get(), set(v) }

  function colorRow(label, prop) {
    const color = h('input', { type: 'color', 'data-prop': prop, 'aria-label': label });
    const text = h('input', { type: 'text', placeholder: 'inherit', 'data-prop-text': prop, spellcheck: 'false' });
    const clear = h('button', { class: 'clear icon', title: 'Clear', text: '×' });
    color.addEventListener('input', () => { text.value = color.value; setProp(prop, color.value, false); });
    color.addEventListener('change', () => setProp(prop, color.value, true));
    text.addEventListener('input', () => setProp(prop, text.value, false, true));
    text.addEventListener('change', () => setProp(prop, text.value, true));
    clear.addEventListener('click', () => setProp(prop, '', true));
    const row = h('div', { class: 'row' }, h('label', { text: label }), color, text, clear);
    controls[prop] = { row, set(v, computed) { text.value = v || ''; color.value = toHex(v || computed) || '#000000'; } };
    return row;
  }
  function selectRow(label, prop, list) {
    const sel = h('select', { 'data-prop': prop }, ...options(list));
    sel.addEventListener('change', () => setProp(prop, sel.value, true));
    const row = h('div', { class: 'row' }, h('label', { text: label }), sel);
    controls[prop] = { row, set(v) { sel.value = list.some(([x]) => x === v) ? v : ''; } };
    return row;
  }
  function textRow(label, prop, placeholder, unit) {
    const input = h('input', { type: 'text', 'data-prop': prop, placeholder, spellcheck: 'false' });
    const norm = () => { const v = input.value.trim(); return unit && /^-?\d+(\.\d+)?$/.test(v) ? v + unit : v; };
    input.addEventListener('input', () => setProp(prop, norm(), false, true));
    input.addEventListener('change', () => setProp(prop, norm(), true));
    input.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && /^-?\d+(\.\d+)?(px|em|rem|%)?$/.test(input.value.trim() || '0')) {
        e.preventDefault();
        const m = (input.value.trim() || '0').match(/^(-?\d+(?:\.\d+)?)(\D*)$/);
        const step = e.shiftKey ? 10 : 1;
        input.value = (parseFloat(m[1]) + (e.key === 'ArrowUp' ? step : -step)) + (m[2] || unit || '');
        setProp(prop, input.value, true);
      }
    });
    const row = h('div', { class: 'row' }, h('label', { text: label }), input);
    controls[prop] = { row, set(v, computed) { input.value = v || ''; input.placeholder = computed || placeholder; } };
    return row;
  }
  function rangeRow(label, prop) {
    const input = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'data-prop': prop });
    input.addEventListener('input', () => setProp(prop, input.value, false));
    input.addEventListener('change', () => setProp(prop, input.value, true));
    const row = h('div', { class: 'row' }, h('label', { text: label }), input);
    controls[prop] = { row, set(v, computed) { input.value = v || computed || '1'; } };
    return row;
  }
  function hideRow() {
    const cb = h('input', { type: 'checkbox', 'data-prop': 'display' });
    cb.addEventListener('change', () => setProp('display', cb.checked ? 'none' : '', true));
    const row = h('div', { class: 'row' }, h('label', { text: 'Hide' }), cb, h('span', { class: 'hint', text: 'Removes the element from the page' }));
    controls.display = { row, set(v) { cb.checked = v === 'none'; } };
    return row;
  }

  const hover = h('div', { class: 'hl' }, h('span', { class: 'tag' }));
  const selBox = h('div', { class: 'hl sel' }, h('span', { class: 'tag' }));
  const pickBtn = h('button', { class: 'primary', 'data-action': 'pick', text: 'Select element' });
  const undoBtn = h('button', { 'data-action': 'undo', title: 'Undo (Ctrl+Z)', text: '↶ Undo' });
  const redoBtn = h('button', { 'data-action': 'redo', title: 'Redo (Ctrl+Shift+Z)', text: '↷ Redo' });
  const selInfo = h('div', { class: 'sel-info empty', 'data-role': 'selector', text: 'No element selected. Click “Select element”, then click anything on the page.' });
  const status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const ruleCount = h('span');
  const ruleList = h('ul');
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });

  const editFields = h('fieldset', { 'data-role': 'fields', disabled: '' },
    h('legend', { text: 'Colors' }), colorRow('Text', 'color'), colorRow('Background', 'background-color'));
  const typo = h('fieldset', { disabled: '' }, h('legend', { text: 'Typography' }),
    selectRow('Font', 'font-family', FONTS), textRow('Size', 'font-size', 'e.g. 18px', 'px'), selectRow('Weight', 'font-weight', WEIGHTS));
  const spacing = h('fieldset', { disabled: '' }, h('legend', { text: 'Spacing' }),
    textRow('Margin', 'margin', 'e.g. 8px 16px', 'px'), textRow('Padding', 'padding', 'e.g. 12px', 'px'));
  const border = h('fieldset', { disabled: '' }, h('legend', { text: 'Border' }),
    textRow('Width', 'border-width', 'e.g. 2px', 'px'), selectRow('Style', 'border-style', BORDER_STYLES),
    colorRow('Color', 'border-color'), textRow('Radius', 'border-radius', 'e.g. 8px', 'px'));
  const vis = h('fieldset', { disabled: '' }, h('legend', { text: 'Visibility' }), rangeRow('Opacity', 'opacity'), hideRow());
  const fieldsets = [editFields, typo, spacing, border, vis];

  const resetElBtn = h('button', { 'data-action': 'reset-element', disabled: '', text: 'Reset element' });
  const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'SiteEdit' },
    h('div', { class: 'head' }, h('div', { class: 'logo', text: 'S' }), h('div', { class: 'title', text: 'SiteEdit' }),
      h('div', { class: 'host', text: RT.host }), h('button', { class: 'icon', 'data-action': 'close', title: 'Close (Esc twice)', text: '✕' })),
    h('div', { class: 'body' },
      h('div', { class: 'toolbar' }, pickBtn, undoBtn, redoBtn),
      selInfo, ...fieldsets,
      h('div', { class: 'actions' },
        resetElBtn, h('button', { class: 'danger', 'data-action': 'reset-site', text: 'Reset site' }),
        h('button', { 'data-action': 'export', text: 'Export JSON' }), h('button', { 'data-action': 'import', text: 'Import JSON' })),
      h('details', { class: 'rules' }, h('summary', {}, 'Customized elements (', ruleCount, ')'), ruleList),
      status,
      h('div', { class: 'hint' }, 'Changes save automatically. ', h('kbd', { text: 'Esc' }), ' cancels selection.')));
  shadow.append(hover, selBox, panel, fileInput);

  // ---------- helpers ----------
  function toHex(v) {
    if (!v) return null;
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase();
    const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('') : null;
  }
  let statusTimer = 0;
  function say(msg, kind = '') {
    status.textContent = msg; status.className = 'status ' + kind;
    clearTimeout(statusTimer); statusTimer = setTimeout(() => { status.textContent = ''; }, 4000);
  }
  function placeBox(box, el, label) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    box.firstChild.textContent = label;
  }
  const describe = (el) => el.localName + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '');

  // ---------- editing ----------
  let previewQueued = false;
  function queuePreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => { previewQueued = false; RT.setPreview(working); refreshSelBox(); });
  }

  function setProp(prop, value, commit, lenient) {
    if (!selected) return;
    const sel = selected.selector;
    const v = String(value || '').trim();
    const rule = { ...(working[sel] || {}) };
    if (!v) delete rule[prop];
    else {
      const ok = Core.validateValue(prop, v);
      if (ok === null) {
        if (!lenient) say(`“${v}” is not a valid ${prop} value.`, 'err');
        if (commit) syncControls();
        return;
      }
      rule[prop] = ok;
    }
    if (Object.keys(rule).length) working[sel] = rule; else delete working[sel];
    queuePreview();
    if (commit) commitChange();
  }

  function commitChange() {
    if (JSON.stringify(working) === JSON.stringify(committed)) return;
    undoStack.push(clone(committed));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    persist(working);
  }

  function persist(rules) {
    committed = clone(rules);
    working = clone(rules);
    RT.save(committed).catch((e) => say('Could not save: ' + e.message, 'err'));
    syncControls();
  }

  function undo() { if (!undoStack.length) return; redoStack.push(clone(committed)); persist(undoStack.pop()); say('Undone'); }
  function redo() { if (!redoStack.length) return; undoStack.push(clone(committed)); persist(redoStack.pop()); say('Redone'); }

  function resetElement() {
    if (!selected || !working[selected.selector]) return;
    delete working[selected.selector];
    commitChange(); say('Element reset', 'ok');
  }
  function resetSite() {
    if (!Object.keys(committed).length) { say('Nothing to reset'); return; }
    working = {}; commitChange(); say('All changes for this site were reset (undo is available)', 'ok');
  }

  function syncControls() {
    const has = !!selected;
    fieldsets.forEach((f) => { f.disabled = !has; });
    const rule = has ? (working[selected.selector] || {}) : {};
    let cs = null;
    if (has && selected.el && selected.el.isConnected) cs = getComputedStyle(selected.el);
    for (const [prop, c] of Object.entries(controls)) {
      c.set(rule[prop] || '', cs ? cs.getPropertyValue(prop) : '');
      c.row.classList.toggle('mod', prop in rule);
    }
    resetElBtn.disabled = !(has && working[selected.selector]);
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    const keys = Object.keys(committed);
    ruleCount.textContent = String(keys.length);
    ruleList.replaceChildren(...keys.map((s) => h('li', {},
      h('code', { title: s, text: s, onclick: () => selectBySelector(s) }),
      h('button', { class: 'icon', title: 'Reset', text: '×', onclick: () => { delete working[s]; commitChange(); } }))));
    refreshSelBox();
  }

  function refreshSelBox() { placeBox(selBox, selected && selected.el, selected ? describe(selected.el || document.body) : ''); }

  function select(el) {
    const selector = selectorFor(el);
    if (!selector) { say('Could not build a selector for that element.', 'err'); return; }
    selected = { el, selector };
    selInfo.textContent = selector; selInfo.classList.remove('empty');
    syncControls();
  }
  function selectBySelector(s) {
    let el = null;
    try { el = document.querySelector(s); } catch (_) {}
    selected = { el, selector: s };
    selInfo.textContent = s + (el ? '' : '  (not on page right now)'); selInfo.classList.remove('empty');
    syncControls();
  }

  // ---------- picker ----------
  const isOurs = (t) => t === host || (t && host.contains(t));
  function onMove(e) {
    const t = e.target;
    if (isOurs(t) || !(t instanceof Element)) { hover.style.display = 'none'; hoverEl = null; return; }
    hoverEl = t; placeBox(hover, t, describe(t));
  }
  function swallow(e) { if (!isOurs(e.target)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } }
  function onPick(e) {
    if (isOurs(e.target)) return;
    swallow(e);
    stopPicking();
    if (e.target instanceof Element) select(e.target);
  }
  const PICK_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];
  function startPicking() {
    picking = true; pickBtn.classList.add('on'); pickBtn.textContent = 'Click an element… (Esc)';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPick, true);
    PICK_EVENTS.forEach((t) => document.addEventListener(t, swallow, true));
  }
  function stopPicking() {
    picking = false; pickBtn.classList.remove('on'); pickBtn.textContent = 'Select element';
    hover.style.display = 'none'; hoverEl = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPick, true);
    PICK_EVENTS.forEach((t) => document.removeEventListener(t, swallow, true));
  }

  // ---------- import / export (current site) ----------
  function exportSite() {
    const json = Core.buildExport(Object.keys(committed).length ? { [RT.host]: { version: Core.SCHEMA_VERSION, updatedAt: Date.now(), rules: committed } } : {});
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: `siteedit-${RT.host}.json` });
    shadow.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say('Exported ' + Object.keys(committed).length + ' rule(s)', 'ok');
    return json;
  }
  function importText(text) {
    try {
      const sites = Core.parseImport(text);
      const site = sites[RT.host];
      if (!site) { say(`File has no rules for ${RT.host}. Use the Manager page to import other sites.`, 'err'); return false; }
      working = { ...committed, ...site.rules };
      commitChange(); say(`Imported ${Object.keys(site.rules).length} rule(s)`, 'ok');
      return true;
    } catch (e) { say(e.message, 'err'); return false; }
  }
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { say('File is too large (max 2 MB).', 'err'); return; }
    importText(await f.text());
  });

  // ---------- events ----------
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'pick': picking ? stopPicking() : startPicking(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'reset-element': resetElement(); break;
      case 'reset-site': resetSite(); break;
      case 'export': exportSite(); break;
      case 'import': fileInput.click(); break;
      case 'close': close(); break;
    }
  });

  let lastEsc = 0;
  function onKey(e) {
    if (e.key === 'Escape') {
      if (picking) { stopPicking(); e.preventDefault(); e.stopPropagation(); return; }
      const now = Date.now();
      if (now - lastEsc < 400) close();
      lastEsc = now;
      return;
    }
    const inPanel = isOurs(e.target);
    const path = e.composedPath();
    const typing = path.some((n) => n instanceof HTMLInputElement && n.type === 'text');
    if (!inPanel || typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  }

  // Drag panel by header.
  (function drag() {
    const head = panel.querySelector('.head');
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      on = true; head.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    });
    head.addEventListener('pointermove', (e) => {
      if (!on) return;
      const x = Math.max(0, Math.min(innerWidth - 80, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(innerHeight - 40, oy + e.clientY - sy));
      Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto' });
    });
    head.addEventListener('pointerup', () => { on = false; });
  })();

  function onStorage(changes, area) {
    if (area !== 'local' || !(RT.key in changes)) return;
    const next = changes[RT.key].newValue ? Core.sanitizeSite(changes[RT.key].newValue).rules : {};
    if (JSON.stringify(next) === JSON.stringify(committed)) return;
    committed = next; working = clone(next); // changed elsewhere (popup / manager / other tab)
    syncControls();
  }
  const onViewport = () => { refreshSelBox(); if (hoverEl) placeBox(hover, hoverEl, describe(hoverEl)); };
  function onDomChange() {
    // Re-resolve the selection if the page re-rendered the element.
    if (selected && (!selected.el || !selected.el.isConnected)) {
      try { selected.el = document.querySelector(selected.selector); } catch (_) { selected.el = null; }
    }
    refreshSelBox();
  }

  let open = false;
  function openPanel() {
    if (open) return;
    open = true;
    (document.body || document.documentElement).appendChild(host);
    document.addEventListener('keydown', onKey, true);
    addEventListener('scroll', onViewport, true);
    addEventListener('resize', onViewport);
    chrome.storage.onChanged.addListener(onStorage);
    unsubscribeDom = RT.onDomChange(onDomChange);
    committed = RT.getRules(); working = clone(committed);
    syncControls();
  }
  function close() {
    if (!open) return;
    open = false;
    stopPicking();
    commitChange();
    RT.setPreview(null);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', onViewport, true);
    removeEventListener('resize', onViewport);
    chrome.storage.onChanged.removeListener(onStorage);
    if (unsubscribeDom) unsubscribeDom();
    selected = null; selInfo.textContent = 'No element selected.'; selInfo.classList.add('empty');
    host.remove();
  }

  globalThis.__siteEditEditor = Object.freeze({
    toggle() { open ? close() : openPanel(); },
    isOpen: () => open,
    // Exposed for automated tests and keyboard-free integrations (isolated world only).
    _test: { selectorFor, select, setProp, undo, redo, resetElement, resetSite, exportSite, importText, getState: () => ({ committed: clone(committed), undo: undoStack.length, redo: redoStack.length, selector: selected && selected.selector }) }
  });
  openPanel();
})();

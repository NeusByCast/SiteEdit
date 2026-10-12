/* SiteEdit core: shared, dependency-free helpers (validation, sanitization, CSS rendering).
 * Loaded in content scripts and extension pages. Never evaluates code. */
(function (root) {
  'use strict';
  if (root.SiteEditCore) return;

  const SCHEMA_VERSION = 1;
  const KEY_PREFIX = 'site:';
  const MAX_SELECTOR_LEN = 1000;
  const MAX_VALUE_LEN = 200;
  const MAX_RULES_PER_SITE = 2000;
  const MAX_SITES = 5000;

  /** Whitelisted CSS properties the editor can set. */
  const PROPERTIES = Object.freeze([
    'color', 'background-color', 'font-family', 'font-size', 'font-weight',
    'margin', 'padding', 'border-width', 'border-style', 'border-color', 'border-radius',
    'display', 'opacity'
  ]);
  const PROP_SET = new Set(PROPERTIES);
  // Disallow anything that could escape a declaration or pull remote resources.
  const FORBIDDEN_VALUE = /[;{}<>\\]|\/\*|url\s*\(|image\s*\(|image-set|expression|javascript:|@import|!/i;
  // '>' (child combinator) is allowed: selectors only ever reach CSSStyleSheet.replaceSync, never
  // HTML, and '{', '}' and ';' (the only ways to break out of a rule) stay forbidden.
  const FORBIDDEN_SELECTOR = /[{};<]|\/\*|@/;
  // Hiding these would blank the whole page and leave no way to reach the panel.
  const MIN_ROOT_OPACITY = 0.2;

  /** Splits on a separator character at nesting depth 0 (outside (), [] and quotes). */
  function splitTop(str, isSep) {
    const out = []; let depth = 0, quote = '', cur = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (quote) { cur += ch; if (ch === '\\') { cur += str[++i] || ''; } else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '\\') { cur += ch + (str[++i] || ''); continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && isSep(ch)) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /** True when a compound selector (no combinators) can match <html> or <body>. */
  function compoundTargetsRoot(compound) {
    const c = compound.trim().toLowerCase();
    if (!c) return true;
    const type = (c.match(/^(\*|[a-z][a-z0-9-]*)/) || [])[1];
    if (type === 'html' || type === 'body' || type === '*') return true;
    if (c.includes(':root')) return true;
    // :is()/:where()/:matches()/:-webkit-any() match when any argument does.
    const re = /:(is|where|matches|-webkit-any)\(/g;
    let m, constrained = false;
    while ((m = re.exec(c))) {
      constrained = true;
      let depth = 1, j = re.lastIndex;
      for (; j < c.length && depth; j++) { if (c[j] === '(') depth++; else if (c[j] === ')') depth--; }
      const inner = c.slice(re.lastIndex, j - 1);
      if (splitTop(inner, (ch) => ch === ',').some((arg) => selectorTargetsRoot(arg))) return true;
    }
    if (type || constrained) return false;
    // No type selector: only pseudo-classes such as :not(), :has(), :nth-child() → implicitly universal.
    const withoutPseudos = c.replace(/::?[a-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '');
    return !/[#.[]/.test(withoutPseudos);
  }

  /** Static check: could this selector match the page root (html/body) and blank the page? */
  function selectorTargetsRoot(sel) {
    const s = String(sel).trim();
    if (!s) return true;
    const list = splitTop(s, (ch) => ch === ',');
    if (list.length > 1) return true; // comma lists are never allowed to hide
    const compounds = splitTop(s, (ch) => ch === ' ' || ch === '>' || ch === '+' || ch === '~').filter((x) => x.trim());
    return compoundTargetsRoot(compounds[compounds.length - 1] || '');
  }
  const isProtectedSelector = selectorTargetsRoot;

  /** Declarations that can make the whole page disappear. */
  function isBlanking(prop, value) {
    if (prop === 'display') return value === 'none';
    if (prop === 'opacity') { const n = parseFloat(value); return !(n >= MIN_ROOT_OPACITY) || /%/.test(value) && parseFloat(value) / 100 < MIN_ROOT_OPACITY; }
    return false;
  }

  /** Runtime check against the live document (catches class/id selectors that match body). */
  function matchesPageRoot(sel, doc) {
    if (!doc) return false;
    try {
      return !!((doc.documentElement && doc.documentElement.matches(sel)) || (doc.body && doc.body.matches(sel)));
    } catch (_) { return true; }
  }

  /** Removes blanking declarations from rules whose selector targets the page root. */
  function stripPageBlanking(rules, doc) {
    const out = {};
    for (const sel of Object.keys(rules)) {
      const rule = { ...rules[sel] };
      const root = selectorTargetsRoot(sel) || matchesPageRoot(sel, doc);
      if (root) for (const p of Object.keys(rule)) if (isBlanking(p, rule[p])) delete rule[p];
      if (Object.keys(rule).length) out[sel] = rule;
    }
    return out;
  }

  function cssSupports(prop, value) {
    try {
      if (typeof CSS !== 'undefined' && CSS.supports) return CSS.supports(prop, value);
    } catch (_) { /* fall through */ }
    return true;
  }

  /** Returns a normalized value or null when it is not acceptable. */
  function validateValue(prop, value) {
    if (!PROP_SET.has(prop) || typeof value !== 'string') return null;
    const v = value.trim();
    if (!v || v.length > MAX_VALUE_LEN || FORBIDDEN_VALUE.test(v)) return null;
    if (prop === 'display' && v !== 'none') return null; // only "hide" is offered
    if (!cssSupports(prop, v)) return null;
    return v;
  }

  function validateSelector(sel) {
    if (typeof sel !== 'string') return null;
    const s = sel.trim();
    if (!s || s.length > MAX_SELECTOR_LEN || FORBIDDEN_SELECTOR.test(s)) return null;
    if (typeof document !== 'undefined') {
      try { document.createDocumentFragment().querySelector(s); } catch (_) { return null; }
    }
    return s;
  }

  /** Heuristic for machine-generated class names / ids that change between builds. */
  function looksGenerated(name) {
    const s = String(name);
    if (/\d{4,}|^[0-9]|[a-f0-9]{8,}|^(css|sc|jsx|emotion|svelte|astro)-/i.test(s)) return true;
    // Hash segments mixed into names: "ssrcss-1q0x1qg-Promo"
    if (/(^|-)(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}(-|$)/i.test(s)) return true;
    // CSS modules: "topRow__-dqkhM", "Header_title__a1b2c", "styles_root__3xYz"
    if (/__-|_-[A-Za-z0-9]/.test(s)) return true;
    const m = s.match(/_([A-Za-z0-9-]{4,})$/);
    if (m && /[0-9A-Z]/.test(m[1]) && /[a-z]/i.test(m[1])) return true;
    // styled-components / emotion hashes: "kOSbdU", "bZQxLp", "hTzWlG" (random case mix, no words)
    if (/^[A-Za-z]{5,10}$/.test(s)) {
      const uppers = (s.match(/[A-Z]/g) || []).length;
      const wordy = /^[a-z]+([A-Z][a-z]+)*$/.test(s) || /^([A-Z][a-z]+)+$/.test(s) || /^[A-Z]+$/.test(s) || /^[a-z]+$/.test(s);
      if (uppers >= 2 && !wordy) return true;
    }
    return false;
  }

  /** Weaker signal used only for selector building: all-lowercase short tokens with no
   * readable vowel pattern, e.g. "kuhblz", "xzqrt". Conservative on purpose. */
  function looksSuspicious(name) {
    const s = String(name);
    if (!/^[a-z]{4,8}$/.test(s)) return false;
    if (!/[aeiouy]/.test(s)) return true;
    // A run of 4+ consonants that is not made of common English clusters ("ngth", "rstr" ...).
    const runs = s.match(/[bcdfghjklmnpqrstvwxz]{4,}/g) || [];
    return runs.some((r) => !/(ng|th|ch|sh|ck|st|tr|nd|rt|ps|pt|ct|ll|ss|tt)/.test(r));
  }

  function validHostname(h) {
    return typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[a-z0-9.\-:[\]_]+$/i.test(h);
  }

  /** Sanitizes a {selector: {prop: value}} map; drops anything invalid. */
  function sanitizeRules(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
    let count = 0;
    for (const rawSel of Object.keys(input)) {
      if (count >= MAX_RULES_PER_SITE) break;
      const sel = validateSelector(rawSel);
      const decls = input[rawSel];
      if (!sel || !decls || typeof decls !== 'object' || Array.isArray(decls)) continue;
      const clean = {};
      for (const prop of Object.keys(decls)) {
        const v = validateValue(prop, decls[prop]);
        if (v !== null && isBlanking(prop, v) && selectorTargetsRoot(sel)) continue;
        if (v !== null) clean[prop] = v;
      }
      if (Object.keys(clean).length) { out[sel] = clean; count++; }
    }
    return out;
  }

  function sanitizeSite(input) {
    const rules = sanitizeRules(input && input.rules);
    return { version: SCHEMA_VERSION, updatedAt: Number(input && input.updatedAt) || Date.now(), rules };
  }

  /** Parses an export file. Accepts {format:"siteedit", sites:{host:{rules}}}. */
  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('File is not valid JSON.'); }
    if (!data || typeof data !== 'object' || data.format !== 'siteedit' || typeof data.sites !== 'object' || !data.sites) {
      throw new Error('Not a SiteEdit export file.');
    }
    const sites = {};
    let n = 0;
    for (const host of Object.keys(data.sites)) {
      if (n >= MAX_SITES) break;
      if (!validHostname(host)) continue;
      const site = sanitizeSite(data.sites[host]);
      if (Object.keys(site.rules).length) { sites[host.toLowerCase()] = site; n++; }
    }
    return sites;
  }

  function buildExport(sites) {
    return JSON.stringify({ format: 'siteedit', version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), sites }, null, 2);
  }

  /** Renders sanitized rules into a stylesheet string. */
  function renderCSS(rules, doc) {
    const clean = stripPageBlanking(sanitizeRules(rules), doc);
    let css = '';
    for (const sel of Object.keys(clean)) {
      const rule = { ...clean[sel] };
      // A width alone has no visible effect when the element has no border style.
      if (rule['border-width'] && !rule['border-style']) rule['border-style'] = 'solid';
      const decls = Object.entries(rule).map(([p, v]) => `${p}: ${v} !important;`).join(' ');
      css += `${sel} { ${decls} }\n`;
    }
    return css;
  }

  root.SiteEditCore = Object.freeze({
    SCHEMA_VERSION, KEY_PREFIX, PROPERTIES,
    looksGenerated, looksSuspicious,
    keyFor: (host) => KEY_PREFIX + String(host).toLowerCase(),
    validateValue, validateSelector, isProtectedSelector, selectorTargetsRoot, isBlanking, matchesPageRoot, stripPageBlanking, validHostname, sanitizeRules, sanitizeSite,
    parseImport, buildExport, renderCSS
  });
})(globalThis);

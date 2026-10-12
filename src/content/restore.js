/* SiteEdit runtime: restores saved customizations for this hostname and keeps them
 * applied as the page changes. Runs at document_start in the isolated world. */
(function () {
  'use strict';
  if (globalThis.__siteEditRuntime) return;
  const Core = globalThis.SiteEditCore;
  const host = location.hostname.toLowerCase();
  const key = Core.keyFor(host);

  let rules = {};
  let previewRules = null; // live, unsaved rules from the editor
  const sheet = new CSSStyleSheet();
  let styleEl = null;      // fallback when adoptedStyleSheets is unavailable
  let observer = null;
  let debounceTimer = 0;
  let lastRootSig = '';
  // html/body identity; when it changes, blanking guards must be re-evaluated.
  const rootSignature = () => {
    const h = document.documentElement, b = document.body;
    return [h && h.id, h && h.className, b && b.id, b && b.className].join('|');
  };

  function activeRules() { return previewRules || rules; }

  function ensureAttached() {
    if ('adoptedStyleSheets' in document) {
      if (!document.adoptedStyleSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      return;
    }
    const parent = document.head || document.documentElement;
    if (!parent) return;
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.dataset.siteedit = ''; }
    if (styleEl.parentNode !== parent || parent.lastElementChild !== styleEl) parent.appendChild(styleEl);
  }

  function render() {
    const css = Core.renderCSS(activeRules(), document);
    lastRootSig = rootSignature();
    try { sheet.replaceSync(css); } catch (_) { /* invalid rule already filtered */ }
    if (styleEl) styleEl.textContent = css;
    ensureAttached();
    updateObserver();
  }

  // Rules are plain CSS, so newly inserted nodes match automatically. The observer
  // re-attaches the sheet if the page replaces adoptedStyleSheets / head content and
  // notifies listeners (e.g. the editor) about dynamic DOM changes, debounced.
  const listeners = new Set();
  function onMutations() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (rootSignature() !== lastRootSig && Object.keys(activeRules()).length) render();
      ensureAttached();
      listeners.forEach((fn) => { try { fn(); } catch (_) {} });
    }, 150);
  }
  function updateObserver() {
    const needed = Object.keys(activeRules()).length > 0 || listeners.size > 0;
    if (needed && !observer && document.documentElement) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
    } else if (!needed && observer) {
      observer.disconnect(); observer = null;
    }
  }

  async function load() {
    try {
      const data = await chrome.storage.local.get(key);
      rules = Core.sanitizeSite(data[key]).rules;
    } catch (_) { rules = {}; }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(key in changes)) return;
    rules = changes[key].newValue ? Core.sanitizeSite(changes[key].newValue).rules : {};
    render();
  });

  globalThis.__siteEditRuntime = Object.freeze({
    host, key,
    getRules: () => JSON.parse(JSON.stringify(rules)),
    setPreview(r) { previewRules = r ? Core.sanitizeRules(r) : null; render(); },
    async save(r) {
      const clean = Core.sanitizeRules(r);
      rules = clean; previewRules = null;
      render(); // apply synchronously; storage write follows
      if (Object.keys(clean).length) {
        await chrome.storage.local.set({ [key]: { version: Core.SCHEMA_VERSION, updatedAt: Date.now(), rules: clean } });
      } else {
        await chrome.storage.local.remove(key);
      }
      return clean;
    },
    onDomChange(fn) { listeners.add(fn); updateObserver(); return () => { listeners.delete(fn); updateObserver(); }; }
  });

  load();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
})();

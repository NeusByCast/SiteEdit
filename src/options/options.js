'use strict';
(function () {
  const Core = globalThis.SiteEditCore;
  const $ = (id) => document.getElementById(id);
  const say = (msg, kind = '') => { $('status').textContent = msg; $('status').className = 'status ' + kind; };

  async function allSites() {
    const all = await chrome.storage.local.get(null);
    const sites = {};
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(Core.KEY_PREFIX)) continue;
      const host = k.slice(Core.KEY_PREFIX.length);
      const site = Core.sanitizeSite(v);
      if (Core.validHostname(host) && Object.keys(site.rules).length) sites[host] = site;
    }
    return sites;
  }

  async function render() {
    const sites = await allSites();
    const hosts = Object.keys(sites).sort();
    $('empty').hidden = hosts.length > 0;
    $('sites').replaceChildren(...hosts.map((host) => {
      const tr = document.createElement('tr');
      const cells = [host, String(Object.keys(sites[host].rules).length), new Date(sites[host].updatedAt).toLocaleString()];
      for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
      const td = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'danger'; del.textContent = 'Delete'; del.dataset.host = host;
      del.addEventListener('click', async () => {
        if (!confirm(`Delete all SiteEdit customizations for ${host}? This cannot be undone.`)) return;
        await chrome.storage.local.remove(Core.keyFor(host)); say(`Removed ${host}`, 'ok'); });
      td.append(del); tr.append(td);
      return tr;
    }));
    $('export').disabled = hosts.length === 0;
  }

  async function exportAll() {
    const json = Core.buildExport(await allSites());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `siteedit-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return json;
  }

  async function importText(text, replace) {
    const sites = Core.parseImport(text);
    const hosts = Object.keys(sites);
    if (!hosts.length) throw new Error('The file contains no valid rules.');
    const existing = await chrome.storage.local.get(hosts.map(Core.keyFor));
    const updates = {};
    for (const host of hosts) {
      const key = Core.keyFor(host);
      const prev = replace ? {} : Core.sanitizeSite(existing[key]).rules;
      updates[key] = { version: Core.SCHEMA_VERSION, updatedAt: Date.now(), rules: Core.sanitizeRules({ ...prev, ...sites[host].rules }) };
    }
    await chrome.storage.local.set(updates);
    return hosts.length;
  }

  $('export').addEventListener('click', () => exportAll().then(() => say('Export downloaded', 'ok')));
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { say('File is too large (max 5 MB).', 'err'); return; }
    try { const n = await importText(await f.text(), $('replace').checked); say(`Imported rules for ${n} site(s).`, 'ok'); }
    catch (err) { say(err.message, 'err'); }
  });
  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') render(); });
  globalThis.__siteEditManager = { exportAll, importText, allSites };
  render();
})();

'use strict';
(async function () {
  const Core = globalThis.SiteEditCore;
  const $ = (id) => document.getElementById(id);
  const say = (msg, kind = '') => { $('status').textContent = msg; $('status').className = 'status ' + kind; };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try { const u = new URL(tab && tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase(); } catch (_) {}

  if (!host) {
    $('host').textContent = 'Unsupported page';
    ['toggle', 'export', 'reset'].forEach((id) => { $(id).disabled = true; });
    say('SiteEdit works on regular http(s) web pages.');
  } else {
    $('host').textContent = host;
  }
  const key = host && Core.keyFor(host);

  async function refresh() {
    if (!key) return;
    const data = await chrome.storage.local.get(key);
    const n = Object.keys(Core.sanitizeSite(data[key]).rules).length;
    $('count').textContent = String(n);
    $('export').disabled = $('reset').disabled = n === 0;
  }
  await refresh();

  $('toggle').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'toggle-editor', tabId: tab.id });
    if (res && res.ok) window.close(); else say((res && res.error) || 'Could not open the editor on this page.', 'err');
  });
  $('export').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(key);
    const json = Core.buildExport({ [host]: Core.sanitizeSite(data[key]) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = `siteedit-${host}.json`;
    a.click();
    say('Exported', 'ok');
  });
  let armed = false;
  $('reset').addEventListener('click', async () => {
    if (!armed) { armed = true; $('reset').textContent = 'Click to confirm'; setTimeout(() => { armed = false; $('reset').textContent = 'Reset site'; }, 3000); return; }
    await chrome.storage.local.remove(key);
    armed = false; $('reset').textContent = 'Reset site';
    say('All customizations for this site were removed.', 'ok');
    refresh();
  });
  $('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();

/* SiteEdit service worker: injects the editor on demand (popup button or shortcut). */
'use strict';

const EDITOR_FILES = ['src/lib/core.js', 'src/content/restore.js', 'src/content/editor.js'];

function isEditableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function toggleEditor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isEditableUrl(tab.url)) return { ok: false, error: 'SiteEdit only works on http(s) pages.' };
  // core.js and restore.js are idempotent; editor.js toggles the panel if already loaded.
  await chrome.scripting.executeScript({ target: { tabId }, files: EDITOR_FILES });
  return { ok: true };
}
globalThis.toggleEditor = toggleEditor;

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-editor' || !tab || tab.id === undefined) return;
  try { await toggleEditor(tab.id); } catch (e) { console.warn('SiteEdit:', e.message); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages (popup/options).
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (msg && msg.type === 'toggle-editor' && Number.isInteger(msg.tabId)) {
    toggleEditor(msg.tabId).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

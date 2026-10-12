# SiteEdit

Visually customize any website without writing code. Click an element, tweak its colors, font,
size, spacing, borders or visibility with a live preview, and SiteEdit remembers your changes for
that site and restores them every time you come back.

Chrome Manifest V3 · no dependencies at runtime · no network access · no remote code.

## Features

- **Element picker**: hover highlight with tag label, click to select, <kbd>Esc</kbd> to cancel.
  Page clicks are blocked while picking so you don't trigger links or buttons.
- **Live editing** of text color, background color, font family, font size, font weight, margin,
  padding, border width / style / color, border radius, opacity, and hide/show.
- **Automatic per-site saving** (keyed by hostname) in `chrome.storage.local`, restored at
  `document_start` on every visit, so customized pages don't flash.
- **Undo / redo** (buttons or <kbd>Ctrl/⌘+Z</kbd>, <kbd>Ctrl/⌘+Shift+Z</kbd>, <kbd>Ctrl+Y</kbd>; 100 steps).
- **Reset** a single element or the whole site (site reset is undoable from the panel).
- **JSON export/import** for the current site (panel and popup) and for all sites (Manager page,
  with merge or replace).
- **Dynamic pages**: rules are real CSS, so elements inserted later match automatically. A debounced
  `MutationObserver` re-attaches the stylesheet if the page replaces it and re-resolves the selected
  element after re-renders.
- **Robust selectors**: a stable unique `id`, then test attributes (`data-testid`, `data-qa`, `name`,
  `aria-label` …), then a short `>` path of stable classes plus `:nth-of-type`. Hashed and generated
  class names (CSS-in-JS) and state classes (`active`, `open` …) are ignored.
- **Dark UI**: popup, Manager page and an in-page panel isolated in Shadow DOM so site CSS can't
  break it. You can drag the panel by its header.

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
4. Optional: pin SiteEdit to the toolbar.

## Usage

1. On any `http(s)` page click the SiteEdit icon → **Open editor on this page**
   (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>).
2. Click **Select element**, hover the page and click the element you want to change.
3. Edit the fields. Changes preview instantly and are saved when a field is committed (Enter, blur,
   or releasing a color or slider). Number-only values get `px` added; ↑/↓ nudge numbers
   (Shift = ×10).
4. **Customized elements** lists every rule on the site. Click one to select it (this also works for
   hidden elements); × resets it.
5. Close the panel with ✕ or by pressing <kbd>Esc</kbd> twice. Your styles stay applied.
6. **Manage all sites** in the popup opens the Manager page: list, delete, export all, import.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Inject the editor only into the tab where you clicked the button or pressed the shortcut. |
| `scripting` | Perform that on-demand injection. |
| `storage` | Save customizations locally. |
| Content script on `http://*/*`, `https://*/*` | **Required for auto-restore.** Saved styles have to be reapplied when you revisit a site, before you interact with it. `activeTab` only applies after a user gesture, so it can't restore on page load. |

The always-on content script is deliberately tiny (`core.js` + `restore.js`). It reads only this
hostname's key from storage, applies a constructed stylesheet, and observes the DOM only when the
site has rules. It never reads page content, sends messages, or makes network requests. There are
no `host_permissions` and no `tabs` permission, so the extension cannot read your tabs or run
scripts in pages programmatically. The editor itself (`editor.js`) is injected only on demand
through `activeTab`.

## Security

- No `eval`, `new Function`, remote scripts, CDNs, or network requests. Extension pages use a
  strict CSP (`default-src 'none'; script-src 'self'; connect-src 'none' …`).
- CSS is generated only from a whitelist of properties. Every value is length-limited, checked with
  `CSS.supports`, and rejected if it contains `; { } < > \ ! /*`, `url(`, `image(`, `image-set`,
  `expression`, `javascript:` or `@import`. "Hide" can only set `display: none`.
- Selectors are length-limited, may not contain `{ } < > ; @ /*`, and must parse with
  `querySelector`.
- Imported JSON is size-limited, has to carry `"format": "siteedit"`, and goes through the same
  sanitizer. Invalid hostnames, selectors, properties and values are dropped.
- Styles are applied through a constructed stylesheet (`adoptedStyleSheets`), never via
  `innerHTML`. The panel builds DOM with `textContent` only.

## Development & tests

```bash
npm install     # installs Puppeteer (and its Chrome for Testing build)
npm test        # end-to-end tests in new headless Chromium
HEADFUL=1 xvfb-run -a npm test   # same, headful under Xvfb
```

`tests/run.mjs` serves `tests/fixtures/index.html` (a page that injects list items and a late banner
after load, then wipes `document.adoptedStyleSheets` to mimic framework hydration). It then loads the
extension and drives the real UI through Shadow DOM. It covers: panel injection, hover highlight and
Esc cancel, click blocking and selector uniqueness, applying every style group, rejection of
malicious values, storage format, undo/redo (buttons and keyboard), hide, dynamic elements,
persistence after reload including stylesheet re-attachment, reset element, reset site plus undo,
export, sanitized file import, the Manager page export/import, the popup, closing the panel, and
**zero console errors**.

Automation can't produce the user gesture that grants `activeTab`, so the test harness loads a
temporary copy of the extension whose manifest adds `host_permissions: ["http://127.0.0.1/*"]`.
The shipped manifest is unchanged.

## Known limits

- Rules apply to the top-level document only, not to iframes or elements inside other sites'
  Shadow DOM.
- Rules are keyed by hostname, so every page on a host shares them (`www.example.com` and
  `example.com` are separate). A selector that only matches on one page has no effect elsewhere.
- Selectors that fall back to structural paths (`:nth-of-type`) can break if the site changes its
  markup. Elements with no stable id, attributes or classes are the most fragile.
- Styles use `!important` but can still lose to a site's own inline `!important` styles.
- Can't run on `chrome://` pages, the Chrome Web Store, or other pages browsers protect from
  extensions. Pages already open when you install need a reload before auto-restore works there.
- Only system/web-safe font stacks are offered (no web font downloads, by design).
- Undo history lives in the open panel session and is cleared when the panel closes. Saved styles
  are not affected.

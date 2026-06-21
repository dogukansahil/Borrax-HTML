# Borrax HTML

[![Release](https://img.shields.io/badge/version-v1.0.0-blue)](https://github.com/dogukansahil/Borrax-HTML/releases/latest) [![Download](https://img.shields.io/badge/download-releases-brightgreen)](https://github.com/dogukansahil/Borrax-HTML/releases/latest) [![License](https://img.shields.io/badge/license-GPL%20v3-lightgrey)](LICENSE) [![Made with Claude](https://img.shields.io/badge/built%20with-Claude-orange)](https://claude.ai) [![Obsidian](https://img.shields.io/badge/Obsidian-community%20plugin-7c3aed)](https://community.obsidian.md/plugins/borrax-html)

View `.html` / `.htm` files stored inside your Obsidian vault — with **working links, CSS and scripts**.

Open any HTML file in your vault and it renders in a sandboxed frame, loaded directly from its vault location, so relative stylesheets, images, scripts and links all resolve correctly.

## Features

- Opens `.html` and `.htm` files in a dedicated view (just click the file).
- **Desktop:** the file is loaded directly (`file://`) in an isolated Electron `<webview>`, so it renders *exactly* like opening it in a browser — linked CSS, inline `<style>`, scripts, links and external web fonts (Google Fonts, etc.) all work.
- **Mobile:** falls back to a sandboxed iframe with an injected `<base>` so relative CSS/links still resolve.
- Links to other files in your vault open inside Obsidian (same tab or a new tab — your choice); external links open in your system browser.
- Adjustable zoom level for rendered HTML.
- Optional "H" badge on folders that contain an `index.html` (click to open it).
- Right‑click the tab → **Reload HTML** or **Open in external browser**.

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them into `<your-vault>/.obsidian/plugins/borrax-html/`.
3. Reload Obsidian and enable **Borrax HTML** in *Settings → Community plugins*.

### From source

```bash
npm install
npm run build
```

This produces `main.js`. Copy `main.js`, `manifest.json` and `styles.css` into the plugin folder.

## Security note

HTML is rendered exactly as in a browser: on desktop in an isolated `<webview>` (no Node integration, separate from your vault), on mobile in a sandboxed iframe. Scripts run just like in a browser, so only open HTML files you trust.

## License

Copyright (C) 2026 dogukansahil

Licensed under the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE) for the full text.

## Disclaimer

Provided **"as is", without any warranty**. HTML is rendered like a browser, so any scripts or external resources it references will run — only open files you trust. **Use at your own risk; the author is not liable for any damage or data loss.**

---

[github.com/dogukansahil](https://github.com/dogukansahil/)

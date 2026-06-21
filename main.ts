/*
 * Borrax HTML - View HTML files inside your Obsidian vault.
 * Copyright (C) 2026 dogukansahil
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {
  FileView,
  FileSystemAdapter,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  View,
  WorkspaceLeaf,
  Menu,
  debounce,
} from "obsidian";

export const VIEW_TYPE_HTML = "borrax-html-view";
const HTML_EXTENSIONS = ["html", "htm"];
const INDEX_BADGE_CLASS = "borrax-html-index-badge";

// Link-click relay: the injected script reports clicked links to the host via
// console.log with this prefix, so the host can open them inside Obsidian.
const NAV_PREFIX = "BORRAX_HTML_NAV::";
const NAV_INJECT_SCRIPT = `(function(){
  if (window.__borraxHtmlNav) return;
  window.__borraxHtmlNav = true;
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (/^(javascript|mailto|tel):/i.test(href)) return;
    e.preventDefault();
    console.log(${JSON.stringify(NAV_PREFIX)} + a.href);
  }, true);
})();`;

// Mobile iframe fallback runs with full browser-like permissions.
// allow-same-origin lets relative CSS / images / links resolve against the file.
const IFRAME_SANDBOX =
  "allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** Minimal typing for Electron's <webview> element (not in the standard DOM lib). */
interface WebviewElement extends HTMLElement {
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
}

interface WebviewNavigateEvent extends Event {
  url?: string;
}
interface WebviewConsoleEvent extends Event {
  message?: string;
}
interface WebviewFailLoadEvent extends Event {
  errorCode?: number;
}

/** Minimal typing for the (undocumented) file-explorer view internals. */
interface FileExplorerItem {
  file: TAbstractFile;
  selfEl: HTMLElement;
}
interface FileExplorerView extends View {
  fileItems?: Record<string, FileExplorerItem>;
}

/** Return the folder's index.html (case-insensitive) if it has one. */
function findIndexHtml(folder: TFolder): TFile | null {
  for (const child of folder.children) {
    if (child instanceof TFile && child.name.toLowerCase() === "index.html") {
      return child;
    }
  }
  return null;
}

/** Build a file:// URL from an absolute OS path (no Node "url" dependency). */
function toFileUrl(absPath: string): string {
  let p = absPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // Windows drive paths (D:/...)
  // encodeURI keeps "/" and ":"; additionally encode "#" and "?".
  const encoded = encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return "file://" + encoded;
}

/**
 * Inject a <base href> so that relative URLs in the document resolve against
 * the file's vault folder. Only used for the mobile iframe fallback; on desktop
 * the file is loaded directly via file:// so no rewriting is needed.
 */
function injectBase(html: string, baseHref: string): string {
  if (/<base\b[^>]*>/i.test(html)) return html;
  const baseTag = `<base href="${baseHref}">`;

  const headMatch = html.match(/<head\b[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + baseTag + html.slice(at);
  }

  const htmlMatch = html.match(/<html\b[^>]*>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return html.slice(0, at) + `<head>${baseTag}</head>` + html.slice(at);
  }

  return baseTag + html;
}

interface BorraxHtmlSettings {
  /** Show an "H" badge on folders containing an index.html. */
  showIndexBadge: boolean;
  /** Open in-vault links in a new tab instead of the current one. */
  openLinksInNewTab: boolean;
  /** Zoom factor for rendered HTML (desktop webview). 1 = 100%. */
  zoomFactor: number;
}

const DEFAULT_SETTINGS: BorraxHtmlSettings = {
  showIndexBadge: true,
  openLinksInNewTab: false,
  zoomFactor: 1,
};

export default class BorraxHtmlPlugin extends Plugin {
  settings: BorraxHtmlSettings = DEFAULT_SETTINGS;

  private badgesActive = false;
  private observedExplorers = new WeakSet<HTMLElement>();

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_HTML, (leaf) => new HtmlView(leaf, this));

    // Make .html / .htm files open with our view by default.
    try {
      this.registerExtensions(HTML_EXTENSIONS, VIEW_TYPE_HTML);
    } catch (e) {
      // Another plugin may already own these extensions; fail quietly.
      console.warn("Borrax HTML: could not register .html/.htm extensions.", e);
    }

    this.addSettingTab(new BorraxHtmlSettingTab(this.app, this));

    // Folder "H" badges in the file explorer.
    this.app.workspace.onLayoutReady(() => this.setupExplorerBadges());
  }

  onunload() {
    this.badgesActive = false;
    this.clearBadges();
  }

  /** Remove every "H" badge currently in the DOM. */
  private clearBadges() {
    activeDocument
      .querySelectorAll("." + INDEX_BADGE_CLASS)
      .forEach((el) => el.remove());
  }

  /** Re-apply badges immediately (used when the setting is toggled). */
  refreshBadges() {
    this.clearBadges();
    this.decorateExplorers();
  }

  /** Schedule a (debounced) re-decoration of all file-explorer folders. */
  private redecorate = debounce(() => this.decorateExplorers(), 100, true);

  private setupExplorerBadges() {
    this.badgesActive = true;

    // Re-run on the events that can change folder contents or re-render rows.
    this.registerEvent(this.app.vault.on("create", this.redecorate));
    this.registerEvent(this.app.vault.on("delete", this.redecorate));
    this.registerEvent(this.app.vault.on("rename", this.redecorate));
    this.registerEvent(this.app.workspace.on("layout-change", this.redecorate));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", this.redecorate)
    );

    // Initial pass plus a few retries: the file explorer often populates its
    // rows shortly after layout-ready, so a single early pass can miss them.
    this.decorateExplorers();
    for (const delay of [150, 400, 1000, 2500]) {
      const id = activeWindow.setTimeout(() => this.decorateExplorers(), delay);
      this.register(() => activeWindow.clearTimeout(id));
    }
  }

  /** Add/refresh the "H" badge on every folder that contains an index.html. */
  private decorateExplorers() {
    if (!this.badgesActive) return;
    if (!this.settings.showIndexBadge) {
      this.clearBadges();
      return;
    }
    const explorers = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of explorers) {
      const view = leaf.view as FileExplorerView;

      // Attach a row-change observer once per explorer (covers expand/collapse
      // and explorers created after startup).
      const containerEl = view.containerEl;
      if (containerEl && !this.observedExplorers.has(containerEl)) {
        const observer = new MutationObserver(() => this.redecorate());
        observer.observe(containerEl, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
        this.observedExplorers.add(containerEl);
      }

      const fileItems = view.fileItems;
      if (!fileItems) continue;

      for (const path in fileItems) {
        const item = fileItems[path];
        const folder = item.file;
        const selfEl = item.selfEl;
        if (!(folder instanceof TFolder) || !selfEl) continue;

        selfEl.querySelector("." + INDEX_BADGE_CLASS)?.remove();
        const index = findIndexHtml(folder);
        if (!index) continue;

        const badge = selfEl.createSpan({ cls: INDEX_BADGE_CLASS, text: "H" });
        badge.setAttribute("aria-label", "Open index.html");
        badge.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          void this.app.workspace.getLeaf(false).openFile(index);
        });
      }
    }
  }

  /** Re-render every open HTML view (e.g. after a zoom change). */
  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof HtmlView) void view.render();
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<BorraxHtmlSettings> | null
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class HtmlView extends FileView {
  private plugin: BorraxHtmlPlugin;
  private frame: HTMLElement | null = null;
  allowNoFile = false;

  constructor(leaf: WorkspaceLeaf, plugin: BorraxHtmlPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_HTML;
  }

  getIcon(): string {
    return "code-2";
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "HTML";
  }

  async onLoadFile(): Promise<void> {
    await this.render();
  }

  async onUnloadFile(): Promise<void> {
    this.clear();
  }

  /** (Re)build the frame for the current file. */
  async render() {
    this.clear();
    if (!this.file) return;

    const container = this.contentEl;
    container.empty();
    container.addClass("borrax-html-container");

    if (
      Platform.isDesktopApp &&
      this.app.vault.adapter instanceof FileSystemAdapter
    ) {
      this.renderWebview(container, this.file);
    } else {
      await this.renderIframe(container, this.file);
    }
  }

  /**
   * Desktop: load the real file via a file:// URL inside an Electron <webview>.
   * This renders exactly like opening the file in a browser — external fonts,
   * linked and inline CSS, scripts and links all work, with no vault CSP.
   */
  private renderWebview(container: HTMLElement, file: TFile) {
    const url = this.fileUrl(file);

    // <webview> is not in the standard DOM typings; build it manually.
    const wv = activeDocument.createElement(
      "webview"
    ) as unknown as WebviewElement;
    wv.addClass("borrax-html-frame", "borrax-html-webview");
    wv.setAttribute("src", url);
    wv.setAttribute("allowpopups", "");

    wv.addEventListener("did-fail-load", (e: Event) => {
      const ev = e as WebviewFailLoadEvent;
      // -3 is ERR_ABORTED (e.g. in-page navigation), which is harmless.
      if (ev.errorCode === -3) return;
      console.error("Borrax HTML: webview failed to load.", ev.errorCode);
    });

    // Primary link handling: inject a capturing click listener into the page
    // and relay the clicked URL back over the webview's console channel. This
    // is reliable across Electron versions, unlike the will-navigate event.
    wv.addEventListener("dom-ready", () => {
      void wv.executeJavaScript(NAV_INJECT_SCRIPT).catch(() => undefined);
      try {
        wv.setZoomFactor(this.plugin.settings.zoomFactor);
      } catch {
        /* setZoomFactor unavailable; ignore */
      }
    });
    wv.addEventListener("console-message", (e: Event) => {
      const msg = (e as WebviewConsoleEvent).message ?? "";
      if (msg.startsWith(NAV_PREFIX)) {
        this.openUrl(msg.slice(NAV_PREFIX.length));
      }
    });

    // Backup: catch script-driven navigations (location.href = ..., window.open).
    const onNavigate = (e: Event) => {
      const targetUrl = (e as WebviewNavigateEvent).url;
      if (!targetUrl) return;
      e.preventDefault();
      this.openUrl(targetUrl);
    };
    wv.addEventListener("will-navigate", onNavigate);
    wv.addEventListener("new-window", onNavigate);

    container.appendChild(wv);
    this.frame = wv;
  }

  /**
   * Resolve a URL clicked inside the webview. A file:// URL pointing inside the
   * vault is opened as a normal Obsidian file (so .html links land back in this
   * view); anything else opens in the external browser.
   */
  private openUrl(rawUrl: string) {
    if (!rawUrl.startsWith("file://")) {
      activeWindow.open(rawUrl, "_blank");
      return;
    }

    let osPath: string;
    try {
      osPath = decodeURIComponent(new URL(rawUrl).pathname);
    } catch {
      return;
    }
    if (/^\/[A-Za-z]:/.test(osPath)) osPath = osPath.slice(1); // strip leading "/" on Windows

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const base = adapter
        .getBasePath()
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
      const target = osPath.replace(/\\/g, "/");
      const prefix = base + "/";
      if (target.toLowerCase().startsWith(prefix.toLowerCase())) {
        const rel = target.slice(prefix.length);
        const af = this.app.vault.getAbstractFileByPath(rel);
        if (af instanceof TFile) {
          const leaf = this.plugin.settings.openLinksInNewTab
            ? this.app.workspace.getLeaf("tab")
            : this.leaf;
          void leaf.openFile(af);
          return;
        }
      }
    }

    // Outside the vault, or not a known file → open externally.
    activeWindow.open(rawUrl, "_blank");
  }

  /** Mobile fallback: render via a sandboxed iframe with an injected <base>. */
  private async renderIframe(container: HTMLElement, file: TFile) {
    const iframe = container.createEl("iframe", { cls: "borrax-html-frame" });
    iframe.setAttribute("sandbox", IFRAME_SANDBOX);
    this.frame = iframe;

    const fileRes = this.app.vault.getResourcePath(file);
    const baseHref = fileRes.slice(0, fileRes.lastIndexOf("/") + 1);

    try {
      const raw = await this.app.vault.cachedRead(file);
      iframe.srcdoc = injectBase(raw, baseHref);
    } catch (e) {
      console.error("Borrax HTML: failed to read file, falling back to src.", e);
      iframe.setAttribute("src", fileRes);
    }
  }

  /** Absolute file:// URL for a vault file (desktop only). */
  private fileUrl(file: TFile): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return toFileUrl(adapter.getFullPath(file.path));
  }

  private clear() {
    if (this.frame) {
      this.frame.remove();
      this.frame = null;
    }
    this.contentEl.empty();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    menu.addItem((item) =>
      item
        .setTitle("Reload HTML")
        .setIcon("refresh-cw")
        .onClick(() => void this.render())
    );
    const file = this.file;
    if (file) {
      menu.addItem((item) =>
        item
          .setTitle("Open in external browser")
          .setIcon("external-link")
          .onClick(() => activeWindow.open(this.fileUrl(file), "_blank"))
      );
    }
  }
}

class BorraxHtmlSettingTab extends PluginSettingTab {
  plugin: BorraxHtmlPlugin;

  constructor(app: BorraxHtmlPlugin["app"], plugin: BorraxHtmlPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Open links in a new tab")
      .setDesc(
        "When you click a link to another file in your vault, open it in a new tab instead of replacing the current one."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openLinksInNewTab)
          .onChange(async (value) => {
            this.plugin.settings.openLinksInNewTab = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Zoom")
      .setDesc("Zoom level for rendered HTML (desktop).")
      .addDropdown((drop) => {
        for (const pct of [50, 75, 90, 100, 110, 125, 150, 175, 200]) {
          drop.addOption(String(pct / 100), pct + "%");
        }
        drop.setValue(String(this.plugin.settings.zoomFactor));
        drop.onChange(async (value) => {
          this.plugin.settings.zoomFactor = parseFloat(value);
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName('Folder "H" badge')
      .setDesc(
        'Show a clickable "H" next to folders that contain an index.html.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showIndexBadge)
          .onChange(async (value) => {
            this.plugin.settings.showIndexBadge = value;
            await this.plugin.saveSettings();
            this.plugin.refreshBadges();
          })
      );

    const footer = containerEl.createDiv({ cls: "borrax-html-settings-footer" });
    footer.createEl("a", {
      text: "github.com/dogukansahil",
      href: "https://github.com/dogukansahil/",
    });
  }
}

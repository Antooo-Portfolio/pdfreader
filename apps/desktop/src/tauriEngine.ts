import type { AnnotResult, Bookmark, DocInfo, EngineClient, PageLink, PdfRect, RecentFile, SaveResult, SearchBatch, TextWord } from "@pdfreader/viewer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";

const BASE = navigator.userAgent.includes("Windows") ? "http://pdfpage.localhost" : "pdfpage://localhost";

/** Implémentation du moteur par les commandes Tauri (Rust + PDFium). */
export const tauriEngine: EngineClient = {
  launchFiles: () => invoke<string[]>("get_launch_files"),
  open: (path, password) => invoke<DocInfo>("doc_open", { path, password: password ?? null }),
  textLayer: (doc, page) => invoke<TextWord[][]>("doc_text_layer", { doc, page }),
  annotations: (doc, page) => invoke<AnnotResult>("doc_annotations", { doc, page }),
  addMarkup: (doc, page, kind, rects: PdfRect[], color, opacity) => invoke<AnnotResult>("annot_add_markup", { doc, page, kind, rects, color, opacity }),
  addNote: (doc, page, x, y, contents, color) => invoke<AnnotResult>("annot_add_note", { doc, page, x, y, contents, color }),
  addInk: (doc, page, strokes, color, opacity, width) => invoke<AnnotResult>("annot_add_ink", { doc, page, strokes, color, opacity, width }),
  updateAnnot: (doc, page, id, patch) => invoke<AnnotResult>("annot_update", { doc, page, id, patch }),
  deleteAnnot: (doc, page, id) => invoke<AnnotResult>("annot_delete", { doc, page, id }),
  countHighlights: (doc, page) => invoke<number>("doc_count_highlights", { doc, page }),
  links: (doc, page) => invoke<PageLink[]>("doc_links", { doc, page }),
  bookmarks: (doc) => invoke<Bookmark[]>("doc_bookmarks", { doc }),
  search: (doc, from, count, query, matchCase, wholeWord) => invoke<SearchBatch>("doc_search", { doc, from, count, query, matchCase, wholeWord }),
  setViewState: (fingerprint, state) => invoke("view_state_set", { fingerprint, state }),
  preferences: () => invoke<Record<string, unknown>>("pref_all"),
  setPreference: (key, value) => invoke("pref_set", { key, value }),
  openUrl: (url) => invoke("open_url", { url }),
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  save: (doc, path) => invoke<SaveResult>("doc_save", { doc, path: path ?? null }),
  close: (doc) => void invoke("doc_close", { doc }),
  recents: () => invoke<RecentFile[]>("recent_list"),
  removeRecent: (id) => invoke("recent_remove", { id }),
  starRecent: (id, starred) => invoke("recent_star", { id, starred }),
  author: () => invoke<string>("author"),
  tileUrl: (doc, gen, ver, page, scale, x, y) => `${BASE}/tile/${doc}/${gen}/${ver}/${page}/${scale.toFixed(4)}/${x}/${y}`,
  thumbUrl: (id, bust) => `${BASE}/thumb/${id}?v=${bust}`,
  async pickFiles() {
    const r = await open({ multiple: true, directory: false, filters: [{ name: "Documents PDF", extensions: ["pdf"] }] });
    return r === null ? [] : Array.isArray(r) ? r : [r];
  },
  pickSavePath: (defaultPath) => save({ defaultPath, filters: [{ name: "Document PDF", extensions: ["pdf"] }] }),
  async onExternalFiles(cb) {
    const off1 = await listen<string[]>("open-files", (e) => cb(e.payload));
    const off2 = await getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") cb(e.payload.paths.filter((p) => p.toLowerCase().endsWith(".pdf")));
    });
    return () => {
      off1();
      off2();
    };
  },
  async onCloseRequested(cb) {
    return getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await cb())) e.preventDefault();
    });
  },
  closeWindow: () => getCurrentWindow().destroy(),
  setTitle: (title) => getCurrentWindow().setTitle(title),
  e2eEnabled: () => invoke<boolean>("e2e_enabled"),
  e2ePause: () => invoke<number>("e2e_pause"),
  e2eReport: (report) => invoke("e2e_report", { report: JSON.stringify(report, null, 2) }),
};

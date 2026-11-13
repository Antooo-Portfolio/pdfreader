import { t } from "@pdfreader/ui";
import type { AnnotResult, Field, PrinterInfo, RecoveryItem, SavedSignature, Attachment, Bookmark, DocInfo, DocProperties, SnippetHit, EngineClient, PageLink, PdfRect, RecentFile, SaveResult, SearchBatch, TextWord } from "@pdfreader/viewer";
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
  fields: (doc, page) => invoke<Field[]>("doc_fields", { doc, page }),
  setField: (doc, page, index, input) => invoke<Field[]>("field_set", { doc, page, index, input }),
  addText: (doc, page, x, y, text, size, color) => invoke<AnnotResult>("fill_add_text", { doc, page, x, y, text, size, color }),
  addMark: (doc, page, x, y, size, cross, color) => invoke<AnnotResult>("fill_add_mark", { doc, page, x, y, size, cross, color }),
  addTextBox: (doc, page, rect, text, size, color, filled, anchor) => invoke<AnnotResult>("fill_add_textbox", { doc, page, rect, text, size, color, filled, anchor }),
  addSignature: (doc, page, rect, kind) => invoke<AnnotResult>("fill_add_signature", { doc, page, rect, kind }),
  signature: (kind) => invoke<SavedSignature | null>("signature_get", { kind }),
  setSignature: (kind, method, data, font) => invoke("signature_set", { kind, method, data, font }),
  deleteSignature: (kind) => invoke("signature_delete", { kind }),
  countHighlights: (doc, page) => invoke<number>("doc_count_highlights", { doc, page }),
  links: (doc, page) => invoke<PageLink[]>("doc_links", { doc, page }),
  bookmarks: (doc) => invoke<Bookmark[]>("doc_bookmarks", { doc }),
  properties: (doc) => invoke<DocProperties>("doc_properties", { doc }),
  attachments: (doc) => invoke<Attachment[]>("doc_attachments", { doc }),
  async saveAttachment(doc, index, name, path) {
    const target = path ?? (await save({ defaultPath: name }));
    return target ? invoke<number>("attachment_save", { doc, index, path: target }) : null;
  },
  attachmentPdfPath: (doc, index) => invoke<string>("attachment_open_pdf", { doc, index }),
  searchSnippets: (doc, from, count, query, matchCase, wholeWord, already) =>
    invoke<{ hits: SnippetHit[]; truncated: boolean }>("doc_search_snippets", { doc, from, count, query, matchCase, wholeWord, already }),
  search: (doc, from, count, query, matchCase, wholeWord) => invoke<SearchBatch>("doc_search", { doc, from, count, query, matchCase, wholeWord }),
  setViewState: (fingerprint, state) => invoke("view_state_set", { fingerprint, state }),
  preferences: () => invoke<Record<string, unknown>>("pref_all"),
  setPreference: (key, value) => invoke("pref_set", { key, value }),
  openUrl: (url) => invoke("open_url", { url }),
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  async exportPreferences(path) {
    const target = path ?? (await save({ defaultPath: "PDFReader-preferences.json", filters: [{ name: t("Préférences PDFReader"), extensions: ["json"] }] }));
    return target ? invoke<number>("pref_export", { path: target }) : null;
  },
  async importPreferences(path) {
    const r = path ?? (await open({ multiple: false, directory: false, filters: [{ name: t("Préférences PDFReader"), extensions: ["json"] }] }));
    const target = Array.isArray(r) ? r[0] : r;
    return target ? invoke<number>("pref_import", { path: target }) : null;
  },
  save: (doc, path) => invoke<SaveResult>("doc_save", { doc, path: path ?? null }),
  close: (doc) => void invoke("doc_close", { doc }),
  recents: () => invoke<RecentFile[]>("recent_list"),
  removeRecent: (id) => invoke("recent_remove", { id }),
  starRecent: (id, starred) => invoke("recent_star", { id, starred }),
  author: () => invoke<string>("author"),
  tileUrl: (doc, gen, ver, page, scale, x, y) => `${BASE}/tile/${doc}/${gen}/${ver}/${page}/${scale.toFixed(4)}/${x}/${y}`,
  thumbUrl: (id, bust) => `${BASE}/thumb/${id}?v=${bust}`,
  async pickFiles() {
    const r = await open({ multiple: true, directory: false, filters: [{ name: t("Documents PDF"), extensions: ["pdf"] }] });
    return r === null ? [] : Array.isArray(r) ? r : [r];
  },
  pickSavePath: (defaultPath) => save({ defaultPath, filters: [{ name: t("Document PDF"), extensions: ["pdf"] }] }),
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
  e2eStage: () => invoke<string>("e2e_stage"),
  printers: () => invoke<PrinterInfo[]>("printers"),
  printerSheet: (name) => invoke<[number, number] | null>("printer_sheet", { name }),
  print: (doc, options) => invoke<number>("doc_print", { doc, options: { ...options, outputFile: options.outputFile ?? null, title: options.title ?? "" } }),
  cancelPrint: () => invoke("print_cancel"),
  onPrintProgress: (cb) => listen<{ done: number; total: number }>("print-progress", (e) => cb(e.payload.done, e.payload.total)),
  changedOnDisk: (doc) => invoke<boolean>("doc_changed_on_disk", { doc }),
  reload: (doc) => invoke<DocInfo>("doc_reload", { doc }),
  recoverySnapshot: (doc, path, fingerprint) => invoke("recovery_snapshot", { doc, path, fingerprint }),
  recoveryClear: (path) => invoke("recovery_clear", { path }),
  recoveryList: () => invoke<RecoveryItem[]>("recovery_list"),
  recoveryRestore: (id, password) => invoke<DocInfo>("recovery_restore", { id, password: password ?? null }),
  recoveryDiscard: (id) => invoke("recovery_discard", { id }),
  resetPreferences: () => invoke("pref_reset"),
  legalDocument: (name) => invoke<string>("legal_document", { name }),
  updateCheck: () => invoke<{ version: string; notes: string | null; date: string | null } | null>("update_check"),
  updateInstall: () => invoke("update_install"),
  onUpdateProgress: (cb) => listen<{ done: number; total: number | null }>("update-progress", (e) => cb(e.payload.done, e.payload.total)),
  appInfo: async () => {
    const i = await invoke<{ name: string; version: string; pdfium: string; data_dir: string }>("app_info");
    return { name: i.name, version: i.version, pdfium: i.pdfium, dataDir: i.data_dir };
  },
  openSettings: (page) => invoke("open_settings", { page }),
  e2eReport: (report) => invoke("e2e_report", { report: JSON.stringify(report, null, 2) }),
};

import type { DocInfo, EngineClient, PdfRect, RecentFile, SaveResult, TextWord } from "@pdfreader/viewer";
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
  addHighlight: (doc, page, rects: PdfRect[], color) => invoke<number>("annot_add_highlight", { doc, page, rects, color }),
  countHighlights: (doc, page) => invoke<number>("doc_count_highlights", { doc, page }),
  save: (doc, path) => invoke<SaveResult>("doc_save", { doc, path: path ?? null }),
  close: (doc) => void invoke("doc_close", { doc }),
  recents: () => invoke<RecentFile[]>("recent_list"),
  removeRecent: (id) => invoke("recent_remove", { id }),
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
  e2eReport: (report) => invoke("e2e_report", { report: JSON.stringify(report, null, 2) }),
};

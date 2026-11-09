import type { AppActions } from "./App";
import { type DocInfo, type EngineClient, isOpenError } from "./engine";
import { selectionToPageRects } from "./selection";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined, timeout = 10000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error("délai dépassé");
    await sleep(50);
  }
}

/** Scénario de bout en bout de la tranche M1, piloté dans la vraie WebView (variable
 *  PDFREADER_E2E). Mêmes fonctions que les boutons : seul le geste de souris est simulé. */
export async function runE2E(engine: EngineClient, actions: AppActions, first: DocInfo | null, path: string | null) {
  const steps: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    if (!first || !path) throw new Error("aucun fichier passé en argument");
    steps.opened = { name: first.name, pages: first.pageCount, ms: Math.round(performance.now() - t0) };

    // 1. La première page s'affiche (tuiles chargées) et sa couche de texte existe.
    const page = await waitFor(() => document.querySelector<HTMLElement>(`[data-page-index="0"]`));
    const img = await waitFor(() => {
      const i = page.querySelector("img");
      return i && i.complete && i.naturalWidth > 0 ? i : null;
    });
    steps.firstTileMs = Math.round(performance.now() - t0);
    steps.tileSize = [img.naturalWidth, img.naturalHeight];
    const layer = await waitFor(() => page.querySelector<HTMLElement>(".pdf-text-layer"));
    steps.textLayer = { words: layer.querySelectorAll("span > span").length, sample: layer.textContent?.slice(0, 80) };
    const docRegion = document.querySelector('[role="document"]');
    steps.a11y = { documentRole: !!docRegion, label: docRegion?.getAttribute("aria-label") };

    // 2. Sélection d'un mot comme le ferait la souris, puis surlignage.
    const words = Array.from(layer.querySelectorAll<HTMLElement>("span > span"));
    const target = words.find((w) => /contrat/i.test(w.textContent ?? "")) ?? words[0];
    if (!target?.firstChild) throw new Error("aucun mot sélectionnable");
    const range = document.createRange();
    range.setStart(target.firstChild, 0);
    range.setEnd(target.firstChild, (target.textContent ?? "").trimEnd().length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    steps.selected = sel.toString();
    const count = await actions.highlightSelection();
    steps.highlightsAfterAdd = count;
    await sleep(300);

    // 3. Ctrl+S, fermeture, réouverture : le surlignage est toujours là.
    const id = first.id;
    steps.saved = await actions.save(id);
    await actions.closeDoc(id);
    await sleep(200);
    const reopened = await actions.openPath(path);
    if (!reopened) throw new Error("réouverture impossible");
    steps.highlightsAfterReopen = await engine.countHighlights(reopened.id, 0);
    const m1 = steps.highlightsAfterReopen === count && count > 0 && steps.saved === true;
    steps.m1 = m1;
    steps.m2 = await runM2(engine, actions, reopened, path);
    steps.ok = m1 && (steps.m2 as { ok: boolean }).ok;
  } catch (e) {
    steps.error = String(e);
    steps.ok = false;
  }
  steps.totalMs = Math.round(performance.now() - t0);
  steps.recents = (await engine.recents().catch(() => [])).map((r) => r.name);
  return steps;
}

function key(k: string, opts: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
}

function selectWord(page: HTMLElement, re: RegExp): boolean {
  const words = Array.from(page.querySelectorAll<HTMLElement>(".pdf-text-layer span > span"));
  const w = words.find((x) => re.test(x.textContent ?? ""));
  if (!w?.firstChild) return false;
  const range = document.createRange();
  range.setStart(w.firstChild, 0);
  range.setEnd(w.firstChild, (w.textContent ?? "").trimEnd().length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** M2, lot « lecture » : signets, recherche (moteur et interface), rotation, mot de passe et droits. */
async function runM2(engine: EngineClient, actions: AppActions, doc: DocInfo, path: string) {
  const r: Record<string, unknown> = {};
  const checks: boolean[] = [];
  try {
    // Signets et liens.
    const bm = await engine.bookmarks(doc.id);
    r.bookmarks = bm.map((b) => `${b.title} → ${b.action.kind === "goto" ? b.action.page + 1 : "?"}`);
    checks.push(bm.length > 0);
    r.linksPage1 = (await engine.links(doc.id, 0)).length;

    // Recherche dans le moteur.
    const t0 = performance.now();
    const batch = await engine.search(doc.id, 0, doc.pageCount, "contrat", false, false);
    r.searchEngine = { pages: batch.pages.length, hits: batch.pages.reduce((n, p) => n + p.hits.length, 0), withText: batch.pagesWithText, ms: Math.round(performance.now() - t0) };
    checks.push(batch.pages.length > 0);

    // Recherche dans l'interface : Ctrl+F, saisie, le résultat courant est surligné.
    key("f", { ctrlKey: true });
    const input = await waitFor(() => document.querySelector<HTMLInputElement>('[role="search"] input'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "contrat");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => document.querySelector("[data-current-hit]"), 8000);
    r.searchUi = document.querySelector('[role="search"] [aria-live]')?.textContent;
    checks.push(true);
    key("Escape");
    await sleep(100);

    // Rotation : la sélection d'un mot donne les mêmes coordonnées PDF avant et après.
    const root = await waitFor(() => document.querySelector<HTMLElement>('[role="document"]'));
    const page0 = () => root.querySelector<HTMLElement>('[data-page-index="0"]');
    await waitFor(() => page0()?.querySelector(".pdf-text-layer"));
    if (!selectWord(page0()!, /\w{5,}/)) throw new Error("aucun mot");
    const before = selectionToPageRects(root).get(0)?.[0];
    key("ArrowRight", { ctrlKey: true, shiftKey: true });
    await waitFor(() => (page0()?.dataset.rot === "90" ? page0() : null));
    await waitFor(() => page0()?.querySelector(".pdf-text-layer"));
    const box = page0()!.getBoundingClientRect();
    selectWord(page0()!, /\w{5,}/);
    const after = selectionToPageRects(root).get(0)?.[0];
    const diff = before && after ? Math.max(...before.map((v, i) => Math.abs(v - (after[i] ?? 0)))) : 99;
    r.rotation = { landscape: box.width > box.height, before, after, maxDiffPt: Math.round(diff * 10) / 10 };
    checks.push(box.width > box.height && diff < 2);
    window.getSelection()?.removeAllRanges();
    key("ArrowLeft", { ctrlKey: true, shiftKey: true });
    await sleep(100);

    // Fichier chiffré AES-256 à côté du fichier de test : mot de passe demandé, puis droits lus.
    const encrypted = path.replace(/[^\\/]+$/,"09-chiffre-aes256.pdf");
    let kind = "aucune erreur";
    try {
      const d = await engine.open(encrypted);
      engine.close(d.id);
    } catch (e) {
      kind = isOpenError(e) ? e.kind : String(e);
    }
    let wrong = "aucune erreur";
    try {
      const d = await engine.open(encrypted, "mauvais");
      engine.close(d.id);
    } catch (e) {
      wrong = isOpenError(e) ? e.kind : String(e);
    }
    const enc = await actions.openPath(encrypted, "test1234");
    r.encrypted = { withoutPassword: kind, wrongPassword: wrong, opened: !!enc, permissions: enc?.permissions };
    checks.push(kind === "password_required" && wrong === "wrong_password" && !!enc && enc.permissions.copy === false && enc.permissions.print === true);
    r.banner = document.querySelector('[role="document"]')?.closest(".flex-col")?.parentElement?.textContent?.includes("désactivé") ?? false;
  } catch (e) {
    r.error = String(e);
    checks.push(false);
  }
  r.ok = checks.every(Boolean);
  r.checks = checks;
  return r;
}

import type { AppActions } from "./App";
import { type Annot, type DocInfo, type EngineClient, isOpenError } from "./engine";
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
    const annot = await runAnnotations(actions, reopened, path, await engine.e2ePause());
    steps.annotations = annot.report;
    steps.m2 = await runM2(engine, actions, annot.doc ?? reopened, path);
    steps.fill = await runFill(actions, path.replace(/[^\\/]+$/, "08-formulaire-acroform.pdf"), await engine.e2ePause());
    steps.ok = m1 && (steps.m2 as { ok: boolean }).ok && (annot.report.ok as boolean) && (steps.fill as { ok: boolean }).ok;
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

/** M2, lot « annotations » : nom d'auteur, souligné, note, dessin, changement de couleur, gomme,
 *  panneau Commentaires, puis enregistrement et relecture. */
async function runAnnotations(actions: AppActions, doc: DocInfo, path: string, pauseMs = 0): Promise<{ report: Record<string, unknown>; doc: DocInfo | null }> {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  let reopened: DocInfo | null = null;
  try {
    await actions.setAuthor("Testeur E2E");
    const a = await waitFor(() => actions.doc());
    const before = (await a.annots(0)).length;
    r.before = before;

    // Souligné d'un mot sélectionné.
    const root = await waitFor(() => document.querySelector<HTMLElement>('[role="document"]'));
    const page0 = await waitFor(() => root.querySelector<HTMLElement>('[data-page-index="0"]'));
    await waitFor(() => page0.querySelector(".pdf-text-layer"));
    if (!selectWord(page0, /\w{6,}/)) throw new Error("aucun mot à souligner");
    checks.underline = (await a.markupSelection("underline")) === 1;
    let list = await a.annots(0);
    const ul = list.find((x) => x.kind === "underline");
    checks.author = ul?.author === "Testeur E2E";

    // Note et dessin.
    const noteId = await a.createNote(0, 420, 120, "Note du scénario");
    const inkId = await a.createInk(0, [[[100, 520], [180, 560], [260, 520], [340, 560]]]);
    list = await a.annots(0);
    checks.note = !!list.find((x) => x.id === noteId && x.kind === "note" && x.contents === "Note du scénario");
    checks.ink = !!list.find((x) => x.id === inkId && x.kind === "ink" && x.strokes[0]?.length === 4);
    // L'éditeur de la note s'ouvre à sa création.
    checks.noteEditor = !!(await waitFor(() => document.querySelector('[role="dialog"][aria-label^="Note de"]'), 3000).catch(() => null));
    // Pause facultative pour une capture d'écran (variable PDFREADER_E2E_PAUSE côté outil).
    if (pauseMs) await sleep(pauseMs);
    (document.activeElement as HTMLElement | null)?.blur();

    // Changement de couleur du souligné, puis gomme sur le dessin.
    if (ul) checks.recolor = (await a.updateAnnot(0, ul.id, { color: [0, 120, 255] })) && (await a.annots(0)).find((x) => x.id === ul.id)?.color?.[2] === 255;
    if (inkId) checks.erase = (await a.deleteAnnot(0, inkId)) && !(await a.annots(0)).some((x) => x.id === inkId);

    // Gestes à la souris (événements synthétiques) : dessin, clic de sélection, Suppr.
    const gestures: Record<string, unknown> = {};
    key("d");
    const layer = await waitFor(() => page0.querySelector<HTMLElement>(".touch-none"));
    gestures.toolBar = !!document.querySelector('[role="toolbar"][aria-label="Dessin"]');
    const lr = layer.getBoundingClientRect();
    const at = (fx: number, fy: number) => ({ clientX: lr.left + lr.width * fx, clientY: lr.top + lr.height * fy, pointerId: 7, button: 0, bubbles: true, cancelable: true });
    const n0 = (await a.annots(0)).length;
    layer.dispatchEvent(new PointerEvent("pointerdown", at(0.2, 0.85)));
    for (let i = 1; i <= 10; i++) layer.dispatchEvent(new PointerEvent("pointermove", at(0.2 + i * 0.03, 0.85)));
    layer.dispatchEvent(new PointerEvent("pointerup", at(0.5, 0.85)));
    await waitFor(() => (actions.doc() && document.querySelectorAll("[data-page-index='0']").length ? true : null));
    let drawn: Annot | undefined;
    for (let i = 0; i < 40 && !drawn; i++) {
      await sleep(100);
      drawn = (await a.annots(0)).find((x) => x.kind === "ink" && x.id !== inkId);
    }
    gestures.drawn = !!drawn && (await a.annots(0)).length === n0 + 1;
    key("v");
    await sleep(100);
    const pr = page0.getBoundingClientRect();
    page0.querySelector(".pdf-text-layer")?.dispatchEvent(new MouseEvent("click", { clientX: pr.left + pr.width * 0.35, clientY: pr.top + pr.height * 0.85, bubbles: true }));
    gestures.selected = !!(await waitFor(() => document.querySelector("[data-selected-annot]"), 3000).catch(() => null));
    gestures.selectedBar = !!document.querySelector('[role="toolbar"][aria-label="Sélection : Dessin"]');
    if (pauseMs) await sleep(pauseMs);
    key("Delete");
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      await sleep(100);
      gone = (await a.annots(0)).length === n0;
    }
    gestures.deletedWithKey = gone;
    r.gestures = gestures;
    checks.gestures = Object.values(gestures).every(Boolean);

    // Panneau Commentaires : les commentaires de la page y figurent.
    a.openPanel("comments");
    await waitFor(() => (document.querySelectorAll("[data-comment]").length >= before + 2 ? true : null), 8000);
    r.panelItems = document.querySelectorAll("[data-comment]").length;
    checks.panel = true;
    a.openPanel(null);

    // Enregistrement, fermeture, réouverture.
    const id = doc.id;
    checks.saved = await actions.save(id);
    await actions.closeDoc(id);
    await sleep(200);
    reopened = await actions.openPath(path);
    if (!reopened) throw new Error("réouverture impossible");
    const b = await waitFor(() => (actions.activeId() === reopened?.id ? actions.doc() : null));
    const after = await b.annots(0);
    r.after = after.map((x) => `${x.kind}:${x.author}:${x.contents}`);
    checks.persisted =
      after.length === before + 2 &&
      after.some((x) => x.kind === "note" && x.contents === "Note du scénario" && x.author === "Testeur E2E") &&
      after.some((x) => x.kind === "underline" && x.color?.[2] === 255);
  } catch (e) {
    r.error = String(e);
    checks.error = false;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 10;
  return { report: r, doc: reopened };
}

function setNativeValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 6000): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = await f();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

/** M2, lot « formulaires et signature » : champs AcroForm remplis par les vrais contrôles de la
 *  page, texte libre, coche, signature mémorisée puis posée ; enregistrement et relecture. */
async function runFill(actions: AppActions, formPath: string, pauseMs = 0) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  try {
    const doc = await actions.openPath(formPath);
    if (!doc) throw new Error("formulaire introuvable : " + formPath);
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    checks.banner = !!(await waitFor(() => (document.body.textContent?.includes("contient un formulaire") ? true : null), 4000).catch(() => null));
    const fields = await a.fields(0);
    r.fields = fields.map((f) => `${f.name}:${f.kind}`);
    checks.fieldsRead = fields.length >= 6;

    // Saisie par les contrôles HTML, comme au clavier et à la souris.
    const nom = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Nom"]'));
    nom.focus();
    setNativeValue(nom, "Élodie Martin");
    nom.blur();
    const accept = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="J\'accepte"]'));
    accept.click();
    const radio = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="radio"][aria-label="Formule : annuelle"]'));
    radio.click();
    const pays = await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Pays"]'));
    setNativeValue(pays, "2");
    const filled = await until(async () => {
      const f = await a.fields(0);
      const by = (n: string) => f.filter((x) => x.name === n);
      const ok = by("nom")[0]?.value === "Élodie Martin" && by("accepte")[0]?.checked && by("formule")[1]?.checked && by("pays")[0]?.value === "Suisse";
      return ok ? f : null;
    });
    checks.formFilled = !!filled;
    if (!filled) r.fieldsNow = (await a.fields(0)).map((f) => `${f.name}=${f.value}/${f.checked}`);

    // Formulaire plat : texte, coche, signature mémorisée puis posée.
    const textId = await a.addText(0, 300, 560, "Fait à Lyon, le 9 novembre");
    const markId = await a.addMark(0, 300, 600);
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 90;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#16181c";
    ctx.beginPath();
    ctx.moveTo(20, 60);
    ctx.bezierCurveTo(80, 0, 140, 90, 280, 30);
    ctx.stroke();
    await a.saveSignature("signature", c.toDataURL("image/png"));
    const sigId = await a.placeSignature(0, 420, 650, "signature");
    const annots = await a.annots(0);
    r.stamps = annots.map((x) => `${x.kind}:${x.contents}`);
    checks.stamps = !!textId && !!markId && !!sigId && annots.some((x) => x.kind === "text") && annots.some((x) => x.kind === "mark") && annots.some((x) => x.kind === "signature");

    // Enregistrement, réouverture.
    checks.saved = await actions.save(doc.id);
    await actions.closeDoc(doc.id);
    await sleep(200);
    const again = await actions.openPath(formPath);
    if (!again) throw new Error("réouverture impossible");
    const b = await waitFor(() => (actions.activeId() === again.id ? actions.doc() : null));
    const f2 = await b.fields(0);
    const by = (n: string) => f2.filter((x) => x.name === n);
    const a2 = await b.annots(0);
    checks.persisted =
      by("nom")[0]?.value === "Élodie Martin" && !!by("accepte")[0]?.checked && !!by("formule")[1]?.checked && by("pays")[0]?.value === "Suisse" && a2.filter((x) => ["text", "mark", "signature"].includes(x.kind)).length === 3;
    r.after = { fields: f2.map((x) => `${x.name}=${x.value}/${x.checked}`), stamps: a2.map((x) => x.kind) };
    if (pauseMs) {
      // Captures : formulaire rempli, puis outil Signer et boîte de création de la signature.
      await sleep(pauseMs);
      key("s");
      await sleep(pauseMs);
      const edit = await waitFor(() => Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Modifier"), 3000).catch(() => null);
      edit?.click();
      await sleep(pauseMs);
      key("Escape");
      key("v");
    }
  } catch (e) {
    r.error = String(e);
    checks.error = false;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 6;
  return r;
}

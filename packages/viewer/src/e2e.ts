import type { AppActions } from "./App";
import { type Annot, type DocInfo, type EngineClient, isOpenError } from "./engine";
import { parseRange, subset } from "./prefs";
import { matcher } from "./SearchPanel";
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
    steps.settings = await runSettings(engine, actions, path, await engine.e2ePause());
    steps.m3reading = await runM3Reading(engine, actions, path);
    steps.m3navigation = await runM3Navigation(engine, actions, path);
    steps.m3comments = await runM3Comments(actions, path);
    steps.ok =
      m1 &&
      (steps.m2 as { ok: boolean }).ok &&
      (annot.report.ok as boolean) &&
      (steps.fill as { ok: boolean }).ok &&
      (steps.settings as { ok: boolean }).ok &&
      (steps.m3reading as { ok: boolean }).ok &&
      (steps.m3navigation as { ok: boolean }).ok &&
      (steps.m3comments as { ok: boolean }).ok;
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
    key("ArrowRight", { ctrlKey: true, altKey: true });
    await waitFor(() => (page0()?.dataset.rot === "90" ? page0() : null));
    await waitFor(() => page0()?.querySelector(".pdf-text-layer"));
    const box = page0()!.getBoundingClientRect();
    selectWord(page0()!, /\w{5,}/);
    const after = selectionToPageRects(root).get(0)?.[0];
    const diff = before && after ? Math.max(...before.map((v, i) => Math.abs(v - (after[i] ?? 0)))) : 99;
    r.rotation = { landscape: box.width > box.height, before, after, maxDiffPt: Math.round(diff * 10) / 10 };
    checks.push(box.width > box.height && diff < 2);
    window.getSelection()?.removeAllRanges();
    key("ArrowLeft", { ctrlKey: true, altKey: true });
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
    // Entrée valide le champ (la perte du focus aussi, mais elle n'arrive pas si la fenêtre de
    // test n'a pas le focus de Windows).
    nom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    nom.blur();
    const accept = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="J\'accepte"]'));
    // Chaque saisie est attendue avant la suivante, comme le ferait un utilisateur.
    const fieldIs = (test: (f: Awaited<ReturnType<typeof a.fields>>) => boolean) => until(async () => test(await a.fields(0)) || null, 3000);
    accept.click();
    await fieldIs((f) => !!f.find((x) => x.name === "accepte")?.checked);
    const radio = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="radio"][aria-label="Formule : annuelle"]'));
    radio.click();
    await fieldIs((f) => !!f.filter((x) => x.name === "formule")[1]?.checked);
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
      const sigDlg = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("Créer votre signature")), 3000).catch(() => null);
      Array.from(sigDlg?.querySelectorAll("button") ?? []).find((x) => x.textContent === "Annuler")?.click();
      await sleep(200);
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

const dirOf = (path: string) => path.replace(/[^\\/]+$/, "");

/** M2, lots « impression », « préférences » et « fichier » : plages de pages, boîte Imprimer,
 *  impression réelle vers « Microsoft Print to PDF », taille de l'interface, raccourcis à une
 *  touche, fichier modifié par un autre programme, copies de récupération. */
async function runSettings(engine: EngineClient, actions: AppActions, path: string, pauseMs = 0) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  try {
    // Plages de pages.
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    checks.ranges =
      eq(parseRange("1-3, 5, 8-", 10), [0, 1, 2, 4, 7, 8, 9]) &&
      eq(parseRange("3-1", 10), [2, 1, 0]) &&
      eq(parseRange(" 2 ; 2 ; -2", 10), [1, 0]) &&
      typeof parseRange("0", 10) === "string" &&
      typeof parseRange("12", 10) === "string" &&
      typeof parseRange("a", 10) === "string" &&
      typeof parseRange("", 10) === "string" &&
      eq(subset([0, 1, 2, 3, 4], "odd"), [0, 2, 4]) &&
      eq(subset([0, 1, 2, 3, 4], "even"), [1, 3]);

    // Boîte Imprimer (Ctrl+P) : imprimantes listées, aperçu, fermeture par Échap.
    const doc = await actions.openPath(dir + "01-texte-10p.pdf");
    if (!doc) throw new Error("document de test introuvable");
    await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    key("p", { ctrlKey: true });
    const dlg = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("Imprimante")), 6000);
    await waitFor(() => (dlg.textContent?.includes("Aperçu : page 1") ? true : null), 6000);
    const printers = await engine.printers();
    r.printers = printers.map((x) => x.name);
    checks.printDialog = printers.length > 0 && !!dlg.textContent?.includes(printers[0]?.name ?? "§");
    if (pauseMs) await sleep(pauseMs);
    // Ctrl+K ne doit rien ouvrir par-dessus une boîte déjà ouverte.
    key("k", { ctrlKey: true });
    await sleep(200);
    checks.noStackedDialogs = !Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d.textContent?.includes("Affichage des pages"));
    Array.from(dlg.querySelectorAll("button")).find((x) => x.textContent === "Annuler")?.click();
    await sleep(300);
    checks.printDialogClosed = !Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d.textContent?.includes("Imprimante"));

    // Impression réelle (pages 1 et 3), relue pour compter les pages.
    const pdfPrinter = printers.find((x) => x.name === "Microsoft Print to PDF");
    if (pdfPrinter) {
      const out = dir + "impression-e2e.pdf";
      let events = 0;
      const off = await engine.onPrintProgress(() => events++);
      const sent = await engine.print(doc.id, {
        printer: pdfPrinter.name,
        pages: [0, 2],
        scale: "fit",
        customScale: 100,
        orientation: "auto",
        duplex: "none",
        copies: 1,
        comments: true,
        outputFile: out,
      });
      off();
      let printedPages = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 20000 && !printedPages) {
        await sleep(400);
        try {
          const d = await engine.open(out);
          printedPages = d.pageCount;
          engine.close(d.id);
        } catch {
          // le spouleur n'a pas encore fini d'écrire le fichier
        }
      }
      r.print = { sent, events, printedPages };
      checks.print = sent === 2 && events === 2 && printedPages === 2;
    } else {
      r.print = "imprimante « Microsoft Print to PDF » absente : vérification sautée";
    }

    // Zone de texte et légende (page 2).
    {
      const cur = await waitFor(() => actions.doc());
      const tb = await cur.addTextBox(1, [300, 60, 150, 20], "Merci de relire ce paragraphe avant vendredi.", null);
      const co = await cur.addTextBox(1, [380, 700, 140, 20], "Signature ici", [200, 780]);
      const list = await cur.annots(1);
      r.textBoxes = list.filter((x) => x.kind === "textbox" || x.kind === "callout").map((x) => `${x.kind}:${x.contents}`);
      checks.textBoxes = !!tb && !!co && list.some((x) => x.id === tb && x.kind === "textbox") && list.some((x) => x.id === co && x.kind === "callout" && x.anchor?.[0] === 200);
    }

    // Sélection du texte au clavier puis surlignage avec la touche U.
    {
      const cur = await waitFor(() => actions.doc());
      cur.openPanel(null);
      window.getSelection()?.removeAllRanges();
      const root = document.querySelector<HTMLElement>('[role="document"]');
      root?.scrollTo({ top: 0 });
      await waitFor(() => root?.querySelector('[data-page-index="0"] .pdf-text-layer'), 5000);
      root?.focus();
      for (let i = 0; i < 5; i++) key("ArrowRight", { shiftKey: true });
      const chars = window.getSelection()?.toString().length ?? 0;
      key("ArrowRight", { ctrlKey: true, shiftKey: true });
      const words = window.getSelection()?.toString().length ?? 0;
      key("a", { ctrlKey: true });
      const all = window.getSelection()?.toString().length ?? 0;
      // Retour à quelques mots, puis U : l'outil Surligner s'applique au texte sélectionné.
      window.getSelection()?.removeAllRanges();
      const steps3: string[] = [];
      for (let i = 0; i < 3; i++) {
        key("ArrowRight", { ctrlKey: true, shiftKey: true });
        steps3.push(window.getSelection()?.toString() ?? "");
      }
      r.wordSteps = steps3;
      const before = (await cur.annots(0)).filter((x) => x.kind === "highlight").length;
      const selBeforeU = window.getSelection()?.toString() ?? "";
      key("u");
      await sleep(100);
      const toolBarAfterU = !!document.querySelector('[role="toolbar"][aria-label="Surligner"]');
      const after = await until(async () => {
        const n = (await cur.annots(0)).filter((x) => x.kind === "highlight").length;
        return n > before ? n : null;
      }, 4000);
      key("v");
      r.keyboardSelection = { chars, words, all, selBeforeU, toolBarAfterU, highlightsBefore: before, highlightsAfter: after };
      const ws = r.wordSteps as string[];
      checks.keyboardSelection = chars === 5 && words > chars && all > 300 && !!after && ws.length === 3 && (ws[0] ?? "") !== "" && (ws[1] ?? "").length > (ws[0] ?? "").length && (ws[2] ?? "").length > (ws[1] ?? "").length;
    }

    // À propos : version, composants tiers.
    {
      const btn = document.querySelector<HTMLElement>('button[aria-label="À propos de PDFReader"]');
      btn?.click();
      const dlg = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("moteur PDFium")), 5000);
      const tab = Array.from(dlg.querySelectorAll('[role="tab"]')).find((x) => x.textContent === "Composants tiers") as HTMLElement | undefined;
      tab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      tab?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
      tab?.click();
      const rows = await until(async () => {
        const n = dlg.querySelectorAll("tbody tr").length;
        return n > 100 ? n : null;
      }, 5000);
      r.about = { version: dlg.textContent?.match(/Version ([\d.]+)/)?.[1], thirdParty: rows };
      checks.about = !!rows && !!dlg.textContent?.includes("PDFium");
      if (pauseMs) await sleep(pauseMs);
      Array.from(dlg.querySelectorAll("button")).find((x) => x.textContent === "Fermer")?.click();
      await sleep(200);
    }

    // Préférences (Ctrl+K) : catégories, taille de l'interface, raccourcis à une touche.
    key("k", { ctrlKey: true });
    const pd = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("Affichage des pages")), 4000);
    const tab = Array.from(pd.querySelectorAll('[role="tab"]')).find((t) => t.textContent === "Accessibilité") as HTMLElement | undefined;
    tab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    tab?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
    tab?.click();
    checks.prefsDialog = !!(await waitFor(() => (pd.textContent?.includes("Taille de l'interface") ? true : null), 3000).catch(() => null));
    if (pauseMs) await sleep(pauseMs);
    Array.from(pd.querySelectorAll("button")).find((x) => x.textContent === "Fermer")?.click();
    await sleep(200);
    actions.setPref("uiScale", 125);
    await sleep(100);
    const scaled = document.documentElement.style.fontSize;
    actions.setPref("uiScale", 100);
    checks.uiScale = scaled === "125%";
    actions.setPref("singleKeys", false);
    await sleep(50);
    key("d");
    await sleep(150);
    const inkBarOff = !!document.querySelector('[role="toolbar"][aria-label="Dessin"]');
    actions.setPref("singleKeys", true);
    await sleep(50);
    key("d");
    await sleep(150);
    const inkBarOn = !!document.querySelector('[role="toolbar"][aria-label="Dessin"]');
    key("v");
    r.singleKeys = { whenOff: inkBarOff, whenOn: inkBarOn };
    checks.singleKeys = !inkBarOff && inkBarOn;

    // Fichier modifié par un autre programme : A est remplacé sur le disque par une copie de B.
    const aPath = dir + "ext-a.pdf";
    const a = await actions.openPath(aPath);
    const b = await actions.openPath(dir + "ext-b.pdf");
    if (!a || !b) throw new Error("fichiers ext-a / ext-b absents");
    await sleep(300);
    const replaced = await actions.save(b.id, aPath);
    await actions.closeDoc(b.id);
    await actions.openPath(aPath);
    await actions.checkExternal();
    const banner = await waitFor(() => (document.body.textContent?.includes("modifié par un autre programme") ? true : null), 6000).catch(() => null);
    const reloaded = await actions.reload(a.id);
    // Le document relu (le formulaire de B) remplace l'affichage : on attend ses champs.
    const fields = (await until(async () => {
      const f = await actions.doc()?.fields(0);
      return f && f.length ? f : null;
    })) ?? [];
    await sleep(300);
    const bannerGone = !document.body.textContent?.includes("modifié par un autre programme");
    r.external = { replaced, banner: !!banner, reloaded, fieldsAfterReload: fields.length, bannerGone };
    checks.external = replaced && !!banner && reloaded && fields.length >= 6 && bannerGone;

    // Copie de récupération d'un document modifié, effacée à l'enregistrement.
    await actions.openPath(aPath);
    const cur = await waitFor(() => actions.doc());
    await cur.addMark(0, 300, 300);
    // L'état « modifié » arrive au rendu suivant.
    // D'autres documents modifiés peuvent passer avant : on attend la copie de celui-ci.
    let made = 0;
    const listed = !!(await until(async () => {
      made += await actions.snapshotNow();
      return (await engine.recoveryList()).some((x) => x.name === "ext-a.pdf") || null;
    }));
    await actions.save(a.id);
    const cleared = !(await engine.recoveryList()).some((x) => x.name === "ext-a.pdf");
    r.recovery = { made, listed, cleared };
    checks.recovery = made >= 1 && listed && cleared;
  } catch (e) {
    r.error = String(e);
    checks.error = false;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 13;
  return r;
}

/** M3, lot « lecture » : vue précédente / suivante, mode lecture, plein écran, propriétés du
 *  document, export et import des préférences. */
async function runM3Reading(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  try {
    const doc = await actions.openPath(dir + "01-texte-10p.pdf");
    if (!doc) throw new Error("document de test introuvable");
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const pageIs = (n: number) => waitFor(() => (a.view().page === n ? true : null), 4000).catch(() => false);
    // Barre d'outils du document actif (les onglets cachés gardent la leur).
    const toolbarShown = () => Array.from(document.querySelectorAll(`[aria-label="Barre d'outils du document"]`)).some((el) => !el.closest("[hidden]"));
    await waitFor(() => document.querySelector(`[data-page-index="0"] img`), 6000).catch(() => null);
    await sleep(300);

    // Vue précédente / suivante : sauts inscrits, Alt+← et Alt+→.
    const trace: string[] = [];
    const note = (what: string) => trace.push(`${what}:${a.view().page}/${a.view().back}/${a.view().forward}`);
    note("début");
    a.jumpTo(1);
    await pageIs(1);
    note("j1");
    a.jumpTo(5);
    const at5 = await pageIs(5);
    note("j5");
    a.jumpTo(8);
    const at8 = await pageIs(8);
    note("j8");
    a.back();
    const back5 = await pageIs(5);
    note("b");
    key("ArrowLeft", { altKey: true });
    const back1 = await pageIs(1);
    note("b");
    key("ArrowRight", { altKey: true });
    const fwd5 = await pageIs(5);
    note("f");
    const v = a.view();
    r.history = { at5, at8, back5, back1, fwd5, back: v.back, forward: v.forward, trace };
    checks.history = at5 && at8 && back5 && back1 && fwd5 && v.forward === 1;

    // Mode lecture (Ctrl+H) : barres et onglets masqués, barre flottante ; Échap en sort.
    key("h", { ctrlKey: true });
    await waitFor(() => (actions.immersive() === "reading" ? true : null), 3000);
    await sleep(150);
    const toolbarHidden = !toolbarShown();
    const tabsHidden = !!document.querySelector('[role="tablist"]')?.closest("[hidden]");
    const bar = !!document.querySelector("[data-immersive-bar]");
    key("Escape");
    await sleep(150);
    const readingOff = actions.immersive() === null && toolbarShown();
    r.reading = { toolbarHidden, tabsHidden, bar, readingOff };
    checks.reading = toolbarHidden && tabsHidden && bar && readingOff;

    // Plein écran (Ctrl+L) : une page, ajustée ; un clic avance ; Échap rétablit le mode du document.
    const before = a.view();
    key("l", { ctrlKey: true });
    await waitFor(() => (a.view().layout === "single" ? true : null), 3000);
    const fsView = a.view();
    await sleep(300);
    document.querySelector<HTMLElement>('[role="document"]')?.click();
    const advanced = await pageIs(fsView.page + 1);
    key("Escape");
    await waitFor(() => (actions.immersive() === null ? true : null), 3000);
    await sleep(200);
    const after = a.view();
    r.fullscreen = { before, fsView, advanced, after };
    checks.fullscreen = fsView.zoomMode === "fit-page" && advanced && after.layout === before.layout && after.zoomMode === before.zoomMode && after.page === fsView.page + 1;

    // Propriétés du document (Ctrl+D).
    key("d", { ctrlKey: true });
    const props = await waitFor(() => document.querySelector("[data-properties]"), 6000);
    const desc = await waitFor(() => (props.textContent?.includes("Corpus PDFReader") ? props.textContent : null), 4000).catch(() => props.textContent ?? "");
    const fontsTab = Array.from(props.querySelectorAll('[role="tab"]')).find((x) => x.textContent === "Polices") as HTMLElement | undefined;
    fontsTab?.click();
    const fonts = await waitFor(() => props.querySelector('[aria-label="Polices"]')?.querySelectorAll("li").length || null, 3000).catch(() => 0);
    const p = await engine.properties(doc.id);
    r.properties = { author: p.author, producer: p.producer, version: p.version, fonts, pages: p.pageCount, descOk: desc.includes("Corpus PDFReader") && desc.includes("01-texte-10p.pdf") };
    checks.properties = desc.includes("Corpus PDFReader") && desc.includes("01-texte-10p.pdf") && fonts > 0 && p.pageCount === 10;
    const dlg = props.closest('[role="dialog"]');
    Array.from(dlg?.querySelectorAll("button") ?? []).find((x) => x.textContent === "Fermer")?.click();
    await sleep(200);
    checks.propertiesClosed = !document.querySelector("[data-properties]");

    // Préférences : export, changement, import (retour à la valeur exportée) ; fichier refusé.
    const file = (await engine.appInfo()).dataDir.replace(/[\\/]$/, "") + "\\prefs-export.json";
    actions.setPref("uiScale", 125);
    await sleep(100);
    const exported = await engine.exportPreferences(file);
    actions.setPref("uiScale", 150);
    await sleep(100);
    const imported = await engine.importPreferences(file);
    await actions.reloadPreferences();
    await sleep(100);
    const restored = actions.prefs().uiScale;
    let refused = "";
    try {
      await engine.importPreferences(path);
    } catch (e) {
      refused = String(e);
    }
    actions.setPref("uiScale", 100);
    r.prefs = { exported, imported, restored, refused };
    checks.prefs = (exported ?? 0) > 0 && (imported ?? 0) > 0 && restored === 125 && refused.includes("invalid_file");
  } catch (e) {
    r.error = String(e);
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 6;
  return r;
}

/** M3, lot « navigation » : pièces jointes, recherche avancée, lecture à voix haute, vue protégée. */
async function runM3Navigation(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const dataDir = (await engine.appInfo()).dataDir.replace(/[\\/]$/, "");
  try {
    // Pièces jointes : liste (nom piégé nettoyé), enregistrement, ouverture d'un PDF joint, refus des autres.
    const doc = await actions.openPath(dir + "12-pieces-jointes.pdf");
    if (!doc) throw new Error("12-pieces-jointes.pdf introuvable");
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const railButton = await waitFor(() => Array.from(document.querySelectorAll("[aria-label]")).find((el) => el.getAttribute("aria-label")?.startsWith("Pièces jointes (3)") && !el.closest("[hidden]")), 4000).catch(() => null);
    a.openPanel("attachments");
    const items = await waitFor(() => {
      const ul = Array.from(document.querySelectorAll("[data-attachments]")).find((el) => !el.closest("[hidden]"));
      return ul && ul.querySelectorAll("li").length === 3 ? Array.from(ul.querySelectorAll("li")).map((li) => li.textContent ?? "") : null;
    }, 6000);
    const list = await engine.attachments(doc.id);
    const notes = list.find((x) => x.name === "notes.txt");
    const annexe = list.find((x) => x.name === "annexe.pdf");
    const danger = list.find((x) => x.name === "danger.exe");
    const saved = notes ? await engine.saveAttachment(doc.id, notes.index, notes.name, dataDir + "\\notes-copie.txt") : null;
    let refused = "";
    try {
      if (danger) await engine.attachmentPdfPath(doc.id, danger.index);
    } catch (e) {
      refused = String(e);
    }
    const pdfPath = annexe ? await engine.attachmentPdfPath(doc.id, annexe.index) : "";
    const opened = pdfPath ? await actions.openPath(pdfPath) : null;
    r.attachments = { items, rail: !!railButton, saved, refused, pdfPath: pdfPath.split(/[\\/]/).pop(), openedPages: opened?.pageCount };
    checks.attachments =
      !!railButton && items.some((x) => x.includes("danger.exe")) && saved === notes?.size && refused.includes("not_pdf") && !!opened && (opened?.pageCount ?? 0) > 0;
    if (opened) await actions.closeDoc(opened.id);

    // Recherche avancée : résultats avec extraits, saut à une page, commentaires, signets.
    const textDoc = await actions.openPath(dir + "01-texte-10p.pdf");
    if (!textDoc) throw new Error("01-texte-10p.pdf introuvable");
    const b = await waitFor(() => (actions.activeId() === textDoc.id ? actions.doc() : null));
    const panelOf = () => Array.from(document.querySelectorAll("[data-search-panel]")).find((el) => !el.closest("[hidden]")) ?? null;
    b.advancedSearch("contrat");
    const textHits = await waitFor(() => {
      const p = panelOf();
      const n = p?.querySelectorAll('[data-hit="text"]').length ?? 0;
      return n > 3 && !p?.textContent?.includes("Recherche…") ? n : null;
    }, 10000);
    const later = Array.from(panelOf()?.querySelectorAll<HTMLElement>('[data-hit="text"]') ?? []).find((el) => el.textContent?.startsWith("Page 4"));
    later?.click();
    const jumped = await waitFor(() => (b.view().page === 4 ? true : null), 4000).catch(() => false);
    const snippet = later?.querySelector("mark")?.textContent ?? "";
    const noteId = await b.createNote(1, 120, 120, "Remarque sur le zèbre bleu");
    await sleep(200);
    key("Escape");
    b.advancedSearch("zèbre");
    const commentHits = await waitFor(() => {
      const p = panelOf();
      const n = p?.querySelectorAll('[data-hit="comment"]').length ?? 0;
      return n >= 1 && !p?.textContent?.includes("Recherche…") ? n : null;
    }, 10000).catch(() => 0);
    const commentText = panelOf()?.querySelectorAll('[data-hit="text"]').length ?? -1;
    if (noteId) await b.deleteAnnot(1, noteId);
    // Mêmes règles hors du texte des pages (signets, commentaires).
    const m = matcher("partie", false, true);
    const mc = matcher("Partie", true, false);
    const matching = m("Partie A") && !m("Parties") && !mc("partie b") && mc("Partie B") && matcher("é", false, false)("É");
    r.search = { textHits, jumped, snippet, commentHits, commentText, matching };
    checks.search = textHits > 3 && jumped && snippet.toLowerCase() === "contrat" && commentHits >= 1 && commentText === 0 && matching;

    // Lecture à voix haute : démarrage, barre d'état, arrêt par Ctrl+Maj+E.
    b.readAloud(false);
    const bar = await waitFor(() => Array.from(document.querySelectorAll("[data-speech]")).find((el) => !el.closest("[hidden]")), 4000).catch(() => null);
    const speaking = await waitFor(() => (window.speechSynthesis.speaking ? true : null), 5000).catch(() => false);
    const voices = window.speechSynthesis.getVoices().length;
    key("e", { ctrlKey: true, shiftKey: true });
    await sleep(300);
    const stopped = b.reading() === null && !document.querySelector("[data-speech]") && !window.speechSynthesis.speaking;
    r.speech = { bar: !!bar, speaking, voices, stopped };
    checks.speech = !!bar && stopped && (speaking || voices === 0);

    // Vue protégée : fichier marqué « venu d'Internet ».
    const web = await actions.openPath(dir + "13-internet.pdf");
    if (!web) throw new Error("13-internet.pdf introuvable");
    const c = await waitFor(() => (actions.activeId() === web.id ? actions.doc() : null));
    const banner = await waitFor(() => Array.from(document.querySelectorAll("[data-protected-view]")).find((el) => !el.closest("[hidden]")), 4000).catch(() => null);
    const wasProtected = c.isProtected() && web.fromInternet;
    const toolsLocked = Array.from(document.querySelectorAll("[aria-label]")).some((el) => el.getAttribute("aria-label")?.startsWith("Vue protégée : activez") && !el.closest("[hidden]"));
    const enable = banner?.closest('[role="status"], [role="alert"], div')?.parentElement?.querySelector("button");
    const btn = Array.from(document.querySelectorAll("button")).find((x) => x.textContent === "Activer la modification" && !x.closest("[hidden]"));
    (btn ?? enable)?.click();
    await sleep(200);
    const unlocked = !c.isProtected() && !Array.from(document.querySelectorAll("[data-protected-view]")).some((el) => !el.closest("[hidden]"));
    r.protectedView = { banner: !!banner, wasProtected, toolsLocked, unlocked };
    checks.protectedView = !!banner && wasProtected && toolsLocked && unlocked;
    await actions.closeDoc(web.id);
  } catch (e) {
    r.error = String(e);
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 4;
  return r;
}

/** M3, lot « commentaires » : formes (à la souris et par les actions), tampon prédéfini,
 *  réponse et statut depuis le panneau Commentaires, persistance après enregistrement. */
async function runM3Comments(actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  try {
    const doc = await actions.openPath(dir + "03-courier-non-embarquee.pdf");
    if (!doc) throw new Error("03-courier-non-embarquee.pdf introuvable");
    let a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const page0 = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('[data-page-index="0"]')).find((el) => !el.closest("[hidden]") && el.querySelector("img")), 8000);
    const kinds = async () => (await a.annots(0)).map((x) => x.kind);
    const waitKind = (k: string, n: number) => until(async () => (await kinds()).filter((x) => x === k).length >= n || null, 5000);

    // Rectangle tracé à la souris (aperçu pendant le glisser), polygone par clics puis Entrée.
    a.setTool("shape");
    a.setShapeKind("square");
    const layer = await waitFor(() => page0.querySelector<HTMLElement>("[data-draw-layer]"), 4000);
    const lr = layer.getBoundingClientRect();
    const at = (fx: number, fy: number) => ({ clientX: lr.left + lr.width * fx, clientY: lr.top + lr.height * fy, pointerId: 9, button: 0, bubbles: true, cancelable: true });
    layer.dispatchEvent(new PointerEvent("pointerdown", at(0.15, 0.6)));
    for (let i = 1; i <= 6; i++) layer.dispatchEvent(new PointerEvent("pointermove", at(0.15 + i * 0.03, 0.6 + i * 0.02)));
    await sleep(50);
    const preview = !!page0.querySelector("[data-shape-preview] rect");
    layer.dispatchEvent(new PointerEvent("pointerup", at(0.33, 0.72)));
    const squareDrawn = !!(await waitKind("square", 1));
    a.setShapeKind("polygon");
    await sleep(100);
    const layer2 = await waitFor(() => page0.querySelector<HTMLElement>("[data-draw-layer]"), 4000);
    for (const [fx, fy] of [
      [0.5, 0.6],
      [0.7, 0.62],
      [0.62, 0.75],
    ] as const) {
      layer2.dispatchEvent(new PointerEvent("pointerdown", at(fx, fy)));
      layer2.dispatchEvent(new PointerEvent("pointerup", at(fx, fy)));
    }
    await sleep(50);
    key("Enter");
    const polygonDrawn = !!(await waitKind("polygon", 1));
    a.setTool("select");

    // Autres formes et tampon par les actions.
    await a.createShape(0, "circle", [[350, 100], [450, 160]], true);
    await a.createShape(0, "line", [[100, 200], [250, 200]], false);
    await a.createShape(0, "arrow", [[100, 240], [250, 260]], false);
    await a.createShape(0, "cloud", [[300, 200], [450, 200], [450, 280], [300, 280]], false);
    const stampId = await a.placeStamp(0, 300, 360, "draft", true);
    const list = await a.annots(0);
    const circle = list.find((x) => x.kind === "circle");
    const stamp = list.find((x) => x.id === stampId);
    r.shapes = { preview, squareDrawn, polygonDrawn, kinds: list.map((x) => x.kind), circleFill: circle?.fill, stamp: stamp?.contents };
    checks.shapes = preview && squareDrawn && polygonDrawn && ["circle", "line", "arrow", "cloud"].every((k) => list.some((x) => x.kind === k)) && !!circle?.fill;
    checks.stamp = !!stamp && stamp.kind === "stamp" && stamp.contents.startsWith("BROUILLON");

    // Réponse depuis le panneau, statut, coche.
    const noteId = await a.createNote(0, 520, 60, "Faut-il garder ce paragraphe ?");
    key("Escape");
    if (!noteId) throw new Error("note non créée");
    a.openPanel("comments");
    const item = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(`[data-comment="${noteId}"]`)).find((el) => !el.closest("[hidden]")), 6000);
    item.querySelector<HTMLElement>("button[aria-current], button")?.click();
    const replyBtn = await waitFor(() => Array.from(item.querySelectorAll("button")).find((b) => b.textContent === "Répondre"), 3000);
    replyBtn.click();
    const box = await waitFor(() => item.querySelector<HTMLTextAreaElement>('textarea[aria-label="Votre réponse"]'), 3000);
    setNativeValue(box, "Oui, on le garde.");
    await sleep(50);
    Array.from(item.querySelectorAll("button")).find((b) => b.textContent === "Enregistrer")?.click();
    const replyShown = !!(await waitFor(() => item.querySelector("[data-reply]"), 4000).catch(() => null));
    if (!replyShown) {
      r.replyDebug = {
        textareaLeft: !!item.querySelector("textarea"),
        value: item.querySelector("textarea")?.value,
        buttons: Array.from(item.querySelectorAll("button")).map((b) => b.textContent),
        toasts: Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="log"]')).map((x) => x.textContent).join(" | ").slice(0, 400),
        direct: await a.reply(0, noteId, "réponse directe"),
      };
    }
    await a.setStatus(0, noteId, "accepted");
    const statusShown = !!(await waitFor(() => item.querySelector('[data-status="accepted"]'), 3000).catch(() => null));
    item.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    const marked = !!(await until(async () => (await a.annots(0)).find((x) => x.id === noteId)?.marked || null, 3000));
    // La réponse ne se dessine pas et ne se sélectionne pas sur la page.
    r.thread = { replyShown, statusShown, marked };
    checks.thread = replyShown && statusShown && marked;

    // Enregistrement : tout est relu à l'identique.
    const saved = await actions.save(doc.id);
    a = await waitFor(() => actions.doc());
    const after = await until(async () => {
      const l = await a.annots(0);
      return l.length ? l : null;
    }, 5000);
    const note = after?.find((x) => x.id === noteId);
    const reply = after?.find((x) => x.replyTo === noteId);
    r.saved = { saved, status: note?.status, marked: note?.marked, reply: reply?.contents, count: after?.length };
    checks.persisted = saved && note?.status === "accepted" && !!note?.marked && reply?.contents === "Oui, on le garde.";

    // Supprimer le commentaire emporte sa réponse.
    await a.deleteAnnot(0, noteId);
    const left = await a.annots(0);
    checks.cascade = !left.some((x) => x.id === noteId || x.replyTo === noteId);
    await actions.save(doc.id);
  } catch (e) {
    r.error = String(e);
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 5;
  return r;
}

/** Scénarios en deux lancements : « crash » modifie un document, fait sa copie de récupération et
 *  quitte sans rien nettoyer ; « recover » vérifie qu'au lancement suivant la copie est proposée,
 *  rouverte avec la modification, puis effacée à l'enregistrement. */
export async function runStage(stage: string, engine: EngineClient, actions: AppActions, first: DocInfo | null) {
  const r: Record<string, unknown> = { stage };
  try {
    if (stage === "crash") {
      if (!first) throw new Error("aucun fichier passé en argument");
      const a = await waitFor(() => actions.doc());
      r.mark = await a.addMark(0, 300, 300);
      r.snapshots = (await until(async () => (await actions.snapshotNow()) || null)) ?? 0;
      r.listed = (await engine.recoveryList()).map((x) => x.name);
      r.ok = r.snapshots === 1 && (r.listed as string[]).includes(first.name);
    } else if (stage === "recover") {
      const item = await waitFor(() => document.querySelector<HTMLElement>("[data-recovery]"), 8000);
      r.offered = item.dataset.recovery;
      const pause = await engine.e2ePause();
      if (pause) await sleep(pause);
      const btn = Array.from(item.querySelectorAll("button")).find((x) => x.textContent === "Récupérer");
      btn?.click();
      const a = await waitFor(() => actions.doc(), 8000);
      const id = actions.activeId();
      const annots = await a.annots(0);
      r.restoredMarks = annots.filter((x) => x.kind === "mark").length;
      r.title = document.title;
      const dirty = !!document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes("•") || annots.length > 0;
      r.saved = id ? await actions.save(id) : false;
      r.leftAfterSave = (await engine.recoveryList()).length;
      r.ok = !!r.offered && (r.restoredMarks as number) >= 1 && dirty && r.saved === true && r.leftAfterSave === 0;
    } else if (stage === "shots") {
      // Captures d'écran (outil externe) : propriétés du document, puis mode lecture.
      if (!first) throw new Error("aucun fichier passé en argument");
      await waitFor(() => actions.doc());
      await waitFor(() => document.querySelector(`[data-page-index="0"] img`), 8000);
      const pause = (await engine.e2ePause()) || 3000;
      const d = actions.doc()!;
      // Document avec pièces jointes : recherche avancée puis pièces jointes ; sinon propriétés puis mode lecture.
      if (first.name.includes("courier")) {
        // Formes, tampon et fil de réponses.
        await d.createShape(0, "square", [[80, 330], [230, 400]], true);
        await d.createShape(0, "circle", [[260, 330], [380, 400]], false);
        await d.createShape(0, "arrow", [[90, 450], [230, 520]], false);
        await d.createShape(0, "cloud", [[260, 440], [420, 440], [420, 530], [260, 530]], false);
        await d.placeStamp(0, 470, 380, "approved", true);
        const note = await d.createNote(0, 470, 470, "Faut-il garder ce paragraphe ?");
        key("Escape");
        if (note) {
          await d.reply(0, note, "Oui, on le garde.");
          await d.setStatus(0, note, "accepted");
        }
        d.openPanel("comments");
        await sleep(pause);
      } else if (first.attachmentCount > 0) {
        d.advancedSearch("contrat");
        await sleep(pause);
        d.openPanel("attachments");
        await sleep(pause);
      } else {
        actions.setPropertiesOpen(true);
        await waitFor(() => document.querySelector("[data-properties]"), 6000);
        await sleep(pause);
        actions.setPropertiesOpen(false);
        actions.setImmersive("reading");
        await sleep(pause);
        actions.setImmersive(null);
      }
      r.ok = true;
    } else if (stage === "update") {
      // Interroge le vrai flux de mises à jour (latest.json publié) : une erreur réseau ou un
      // fichier illisible lève une exception ; sinon, version proposée ou rien si déjà à jour.
      const found = await engine.updateCheck();
      r.app = (await engine.appInfo()).version;
      r.offered = found?.version ?? null;
      r.ok = true;
    } else {
      throw new Error("étape inconnue : " + stage);
    }
  } catch (e) {
    r.error = String(e);
    r.ok = false;
  }
  return r;
}

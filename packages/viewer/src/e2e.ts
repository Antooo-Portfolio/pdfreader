import type { AppActions } from "./App";
import { type Annot, type DocInfo, type EngineClient, type EngineRestart, isOpenError } from "./engine";
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
    steps.m3bookmarks = await runM3Bookmarks(engine, actions, path);
    steps.m3forms = await runM3FormCalc(actions, path);
    steps.m3engine = await runM3Engine(engine, actions, path);
    steps.phase2pages = await runPhase2Pages(engine, actions, path);
    steps.phase2image = await runPhase2Image(engine, actions, path);
    steps.phase2images = await runPhase2Images(engine, actions, path);
    steps.phase2password = await runPhase2Password(engine, actions, path);
    steps.phase2compress = await runPhase2Compress(engine, actions, path);
    steps.phase2pagetext = await runPhase2PageText(engine, actions, path);
    steps.ok =
      m1 &&
      (steps.m2 as { ok: boolean }).ok &&
      (annot.report.ok as boolean) &&
      (steps.fill as { ok: boolean }).ok &&
      (steps.settings as { ok: boolean }).ok &&
      (steps.m3reading as { ok: boolean }).ok &&
      (steps.m3navigation as { ok: boolean }).ok &&
      (steps.m3comments as { ok: boolean }).ok &&
      (steps.m3bookmarks as { ok: boolean }).ok &&
      (steps.m3forms as { ok: boolean }).ok &&
      (steps.m3engine as { ok: boolean }).ok &&
      (steps.phase2pages as { ok: boolean }).ok &&
      (steps.phase2image as { ok: boolean }).ok &&
      (steps.phase2images as { ok: boolean }).ok &&
      (steps.phase2password as { ok: boolean }).ok &&
      (steps.phase2compress as { ok: boolean }).ok &&
      (steps.phase2pagetext as { ok: boolean }).ok;
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

/** M3, lot « signets » : créer, renommer, réordonner, imbriquer, supprimer des signets, les
 *  enregistrer dans le fichier ; document chiffré non modifiable ; barre d'outils personnalisée. */
async function runM3Bookmarks(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  try {
    const doc = await actions.openPath(dir + "07-tailles-mixtes-rotation.pdf");
    if (!doc) throw new Error("07-tailles-mixtes-rotation.pdf introuvable");
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    await waitFor(() => Array.from(document.querySelectorAll('[data-page-index="0"] img')).find((el) => !el.closest("[hidden]")), 8000);
    a.openPanel("bookmarks");
    const panel = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>("[data-bookmarks-panel]")).find((el) => !el.closest("[hidden]")), 6000);
    const addBtn = () => Array.from(panel.querySelectorAll<HTMLElement>('button[aria-label="Ajouter un signet ici"], button')).find((b) => b.getAttribute("aria-label") === "Ajouter un signet ici" || b.textContent === "Ajouter un signet ici");
    const titles = () => Array.from(panel.querySelectorAll('[role="row"]')).map((x) => x.textContent?.replace(/\d+$/, "").trim());
    /** Ajoute un signet à la page `p` (vue actuelle) et le nomme. */
    const addNamed = async (p: number, name: string) => {
      a.jumpTo(p);
      await waitFor(() => (a.view().page === p ? true : null), 4000);
      await sleep(150);
      (await waitFor(addBtn, 3000)).click();
      const input = await waitFor(() => panel.querySelector<HTMLInputElement>('input[type="text"], form input'), 3000);
      setNativeValue(input, name);
      await sleep(50);
      input.closest("form")?.requestSubmit();
      await waitFor(() => (titles().includes(name) ? true : null), 3000);
    };
    await addNamed(3, "Chapitre trois");
    await addNamed(1, "Début");
    // « Début » a été ajouté après « Chapitre trois » (sélectionné) : on le remonte.
    const order1 = titles();
    Array.from(panel.querySelectorAll<HTMLElement>("button")).find((b) => b.getAttribute("aria-label") === "Monter")?.click();
    await sleep(150);
    const order2 = titles();
    // « Annexe » après « Chapitre trois », puis imbriquée sous lui.
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find((x) => x.textContent?.startsWith("Chapitre trois"))?.click();
    await sleep(150);
    await addNamed(5, "Annexe");
    Array.from(panel.querySelectorAll<HTMLElement>("button")).find((b) => b.getAttribute("aria-label") === "Mettre sous le signet précédent")?.click();
    await sleep(200);
    const pending = await engine.bookmarks(doc.id);
    r.editing = { order1, order2, pending: pending.map((b) => `${b.title}[${b.children.map((c) => c.title).join(",")}]`) };
    checks.editing =
      order1.join("|") === "Chapitre trois|Début" &&
      order2.join("|") === "Début|Chapitre trois" &&
      pending.length === 2 &&
      pending[1]?.title === "Chapitre trois" &&
      pending[1]?.children[0]?.title === "Annexe";

    // Enregistrement : relu depuis le fichier, pages justes.
    const saved = await actions.save(doc.id);
    const fromFile = await engine.bookmarks(doc.id);
    const pageOf = (b: { action: { kind: string; page?: number } } | undefined) => (b && b.action.kind === "goto" ? (b.action as { page: number }).page : -1);
    r.saved = { saved, titles: fromFile.map((b) => b.title), pages: [pageOf(fromFile[0]), pageOf(fromFile[1]), pageOf(fromFile[1]?.children[0])] };
    checks.saved = saved && fromFile.map((b) => b.title).join("|") === "Début|Chapitre trois" && pageOf(fromFile[0]) === 0 && pageOf(fromFile[1]) === 2 && pageOf(fromFile[1]?.children[0]) === 4;

    // Après relecture : clic sur un signet = navigation ; Suppr retire le signet sélectionné.
    a.openPanel("bookmarks");
    const panel2 = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>("[data-bookmarks-panel]")).find((el) => !el.closest("[hidden]") && el.querySelector('[role="row"]')), 6000);
    const row = Array.from(panel2.querySelectorAll<HTMLElement>('[role="row"]')).find((x) => x.textContent?.startsWith("Chapitre trois"));
    a.jumpTo(1);
    await sleep(150);
    row?.click();
    const navigated = await waitFor(() => (a.view().page === 3 ? true : null), 4000).catch(() => false);
    const first = Array.from(panel2.querySelectorAll<HTMLElement>('[role="row"]')).find((x) => x.textContent?.startsWith("Début"));
    first?.click();
    await sleep(150);
    first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await sleep(200);
    const afterDelete = (await engine.bookmarks(doc.id)).map((b) => b.title);
    r.navigation = { navigated, afterDelete };
    checks.navigation = navigated && afterDelete.join("|") === "Chapitre trois";
    await actions.save(doc.id);

    // Document chiffré : signets non modifiables.
    const enc = await actions.openPath(dir + "09-chiffre-aes256.pdf", "test1234");
    checks.encrypted = !!enc && enc.bookmarksEditable === false && doc.bookmarksEditable === true;
    if (enc) await actions.closeDoc(enc.id);

    // Barre d'outils : outils masqués puis réaffichés ; menu de personnalisation présent.
    await actions.openPath(dir + "07-tailles-mixtes-rotation.pdf");
    await waitFor(() => (actions.activeId() === doc.id ? true : null), 3000).catch(() => null);
    const toolShown = (label: string) => Array.from(document.querySelectorAll("[aria-label]")).some((el) => el.getAttribute("aria-label") === label && !el.closest("[hidden]"));
    actions.setPref("hiddenTools", ["strikeout", "callout"]);
    await sleep(200);
    const hidden = !toolShown("Barrer du texte") && !toolShown("Légende (cliquez sur le point à désigner)") && toolShown("Souligner du texte");
    actions.setPref("hiddenTools", []);
    await sleep(200);
    const back = toolShown("Barrer du texte");
    const menu = toolShown("Personnaliser la barre d'outils");
    r.toolbar = { hidden, back, menu };
    checks.toolbar = hidden && back && menu;
  } catch (e) {
    r.error = String(e);
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 5;
  return r;
}

/** M3, lot « formulaires » : calculs en chaîne déclenchés par la saisie dans l'interface,
 *  refus d'une valeur hors plage (message, valeur rétablie), champs calculés en lecture seule,
 *  préférence qui coupe les calculs. */
async function runM3FormCalc(actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  try {
    const doc = await actions.openPath(dir + "13-formulaire-calculs.pdf");
    if (!doc) throw new Error("13-formulaire-calculs.pdf introuvable");
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const input = (label: string) => waitFor(() => Array.from(document.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`)).find((el) => !el.closest("[hidden]")), 6000);
    const value = async (name: string) => (await a.fields(0)).find((f) => f.name === name)?.value ?? null;
    const typeIn = async (label: string, v: string) => {
      const el = await input(label);
      el.focus();
      setNativeValue(el, v);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      el.blur();
    };
    const waitValue = (name: string, v: string) => until(async () => ((await value(name)) === v ? true : null), 6000);

    await typeIn("Quantité", "3");
    await waitValue("qte", "3");
    await typeIn("Prix unitaire", "12,5");
    const chained = !!(await waitValue("ttc", "45"));
    const totals = { total: await value("total"), net: await value("net"), tva: await value("tva"), ttc: await value("ttc") };
    const totalInput = await input("Total");
    const readOnly = totalInput.readOnly || totalInput.disabled;
    // Le total affiché dans l'interface suit (champs relus).
    const shown = await waitFor(() => (Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="Total TTC"]')).some((el) => el.value === "45") ? true : null), 4000).catch(() => false);
    r.chain = { chained, totals, readOnly, shown };
    checks.chain = chained && totals.total === "37.5" && totals.tva === "7.5" && readOnly && shown;

    // Hors plage : message et valeur rétablie.
    await typeIn("Quantité", "150");
    const toast = await waitFor(() => (document.body.textContent?.includes("comprise entre 0 et 100") ? true : null), 4000).catch(() => false);
    const restored = !!(await waitValue("qte", "3"));
    r.rejected = { toast, restored };
    checks.rejected = toast && restored;

    // Préférence coupée : plus de calcul ; rétablie : le calcul reprend.
    actions.setPref("formScripts", false);
    await sleep(100);
    await typeIn("Remise", "5");
    await waitValue("remise", "5");
    await sleep(300);
    const netOff = await value("net");
    actions.setPref("formScripts", true);
    await sleep(100);
    await typeIn("Remise", "6");
    const recalculated = !!(await waitValue("net", "31.5"));
    r.pref = { netOff, recalculated };
    checks.pref = netOff === "37.5" && recalculated;
    await actions.save(doc.id);
  } catch (e) {
    r.error = String(e);
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 3;
  return r;
}

/** Scénarios en deux lancements : « crash » modifie un document, fait sa copie de récupération et
 *  quitte sans rien nettoyer ; « recover » vérifie qu'au lancement suivant la copie est proposée,
 *  rouverte avec la modification, puis effacée à l'enregistrement. */
/** M3, lot « moteur séparé » : le moteur PDF tourne dans un processus à part. Plantage provoqué
 *  pendant une demande sur un document : moteur relancé, documents rouverts sous le même numéro
 *  (celui qui avait des modifications, depuis sa copie de récupération), tuiles de nouveau servies,
 *  message à l'écran. Deuxième plantage sur le même document : il est fermé. Blocage : le moteur
 *  est arrêté puis relancé. */
async function runM3Engine(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const events: EngineRestart[] = [];
  const off = await engine.onEngineRestarted((e) => events.push(e));
  const nextEvent = async (n: number, ms = 45000) => waitFor(() => (events.length >= n ? events[n - 1] : null), ms);
  const tileOk = async (doc: number, generation: number) => {
    const res = await fetch(engine.tileUrl(doc, generation, 0, 0, 0.5, 0, 0)).catch(() => null);
    return !!res && res.ok && (await res.blob()).size > 0;
  };
  try {
    const a = await actions.openPath(dir + "04-vectoriel-transparence.pdf");
    const b = await actions.openPath(dir + "07-tailles-mixtes-rotation.pdf");
    if (!a || !b) throw new Error("ouverture impossible");
    // Modification sur A, puis copie de récupération (comme le fait la minuterie).
    await engine.addNote(a.id, 0, 100, 100, "Avant le plantage", [255, 200, 0]);
    await engine.recoverySnapshot(a.id, a.path, a.fingerprint);
    const genA = a.generation;
    const genB = b.generation;

    // 1. Plantage pendant une demande sur B.
    void engine.e2eEngineFault("crash", b.id).catch(() => undefined);
    const e1 = await nextEvent(1);
    const ra = e1.docs.find((d) => d.id === a.id);
    const rb = e1.docs.find((d) => d.id === b.id);
    const notes = ra ? (await engine.annotations(a.id, 0)).annots.filter((x) => x.contents === "Avant le plantage").length : 0;
    const tiles = !!ra && !!rb && (await tileOk(a.id, ra.info.generation)) && (await tileOk(b.id, rb.info.generation));
    const shown = await waitFor(() => (document.body.textContent?.includes("Le moteur PDF s'est arrêté") ? true : null), 4000).catch(() => false);
    const state = actions.openDocs();
    // Messages à l'écran : celui de la relance, et aucune erreur venue des demandes interrompues.
    const toasts = document.querySelector('[aria-label="Notifications"]')?.textContent ?? "";
    r.crash = { reason: e1.reason, culprit: e1.culprit, a: ra?.from, b: rb?.from, notes, tiles, shown, toasts };
    checks.crash =
      e1.reason === "crash" &&
      e1.culprit === b.id &&
      ra?.from === "snapshot" &&
      rb?.from === "file" &&
      ra.info.generation > genA &&
      rb.info.generation > genB &&
      notes === 1 &&
      tiles &&
      shown &&
      !toasts.includes("engine_restarted") &&
      state.find((d) => d.id === a.id)?.dirty === true &&
      state.find((d) => d.id === b.id)?.dirty === false;

    // 2. Deuxième plantage sur B : B est fermé, A reste ouvert.
    void engine.e2eEngineFault("crash", b.id).catch(() => undefined);
    const e2 = await nextEvent(2);
    const stillA = e2.docs.some((d) => d.id === a.id);
    const tabGone = await waitFor(() => (actions.openDocs().some((d) => d.id === b.id) ? null : true), 4000).catch(() => false);
    r.second = { closed: e2.closed, stillA, tabGone };
    checks.second = e2.closed.includes(b.id) && stillA && tabGone;

    // 3. Blocage pendant une demande sur A : arrêté par la surveillance, puis relancé.
    const t0 = performance.now();
    void engine.e2eEngineFault("hang", a.id).catch(() => undefined);
    const e3 = await nextEvent(3);
    const ra3 = e3.docs.find((d) => d.id === a.id);
    const hangMs = Math.round(performance.now() - t0);
    const tileAfter = !!ra3 && (await tileOk(a.id, ra3.info.generation));
    r.hang = { reason: e3.reason, culprit: e3.culprit, hangMs, tileAfter };
    checks.hang = e3.reason === "hang" && e3.culprit === a.id && tileAfter;

    // Ménage : la copie de récupération de A ne sert plus.
    await engine.recoveryClear(a.path).catch(() => undefined);
    await actions.closeDoc(a.id);
  } catch (e) {
    r.error = String(e);
  }
  off();
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 3;
  return r;
}

/** Phase 2, « Organiser les pages » : vue en grille ouverte depuis la barre d'outils, pages choisies
 *  à la souris, supprimées (touche Suppr), pivotées, page blanche insérée, annuler / rétablir au
 *  clavier, enregistrement puis relecture du fichier ; extraction, découpage, combinaison ; document
 *  protégé : pas de copie sans protection. */
async function runPhase2Pages(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).find((el) => !el.closest("[hidden]") && !el.closest(".hidden"));
  const button = (label: string) => visible<HTMLButtonElement>(`button[aria-label="${label}"]`);
  let step = "début";
  /** Vrai clic de souris (un clic « virtuel » vaut Entrée : il ouvrirait la page). */
  const mouseClick = (el: Element | undefined, opts: PointerEventInit = {}) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 3, ...opts };
    el.dispatchEvent(new PointerEvent("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: 1 }));
  };
  try {
    // Copie fraîche du document de 10 pages (la combinaison d'un seul fichier en fait une copie).
    const work = dir + "pages-organiser.pdf";
    await engine.combine([dir + "01-texte-10p.pdf"], work, { size: { kind: "a4" }, margin: 0 });
    const doc = await actions.openPath(work);
    if (!doc) throw new Error("copie introuvable");
    await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const info = () => actions.openDocs().find((d) => d.id === doc.id);
    step = "bouton Organiser";
    (await waitFor(() => button("Organiser les pages"), 6000)).click();
    step = "grille";
    const grid = await waitFor(() => visible<HTMLElement>("[data-organize] [role='grid']"), 6000);
    const rows = () => Array.from(grid.querySelectorAll<HTMLElement>("[role='row']"));
    step = "10 vignettes";
    await waitFor(() => (rows().length === 10 ? true : null), 4000);
    const status = () => visible<HTMLElement>("[data-organize-status]")?.textContent ?? "";
    const keyOn = (el: Element, k: string, opts: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

    // Supprimer la page 2 : clic puis Suppr.
    mouseClick(rows()[1]);
    await waitFor(() => (status().includes("1 pages sélectionnées") || status().includes("1 page") ? true : null), 3000).catch(() => null);
    step = "suppression";
    keyOn(rows()[1] ?? grid, "Delete");
    await waitFor(() => (rows().length === 9 ? true : null), 6000);
    const afterDelete = { rows: rows().length, dirty: info()?.dirty };
    // Pivoter la première page à droite (bouton).
    mouseClick(rows()[0]);
    await sleep(100);
    const gen0 = info()?.generation ?? 0;
    step = "rotation";
    button("Pivoter à droite")?.click();
    await waitFor(() => ((info()?.generation ?? 0) > gen0 ? true : null), 6000);
    // Page blanche après la page choisie (menu Insérer).
    step = "page blanche";
    button("Insérer des pages")?.click();
    const blank = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).find((m) => m.textContent?.includes("Page blanche")), 3000);
    blank.click();
    await waitFor(() => (rows().length === 10 ? true : null), 6000);
    // Annuler (Ctrl+Z) puis rétablir (Ctrl+Y).
    step = "annuler";
    keyOn(grid, "z", { ctrlKey: true });
    await waitFor(() => (rows().length === 9 ? true : null), 6000);
    step = "rétablir";
    keyOn(grid, "y", { ctrlKey: true });
    await waitFor(() => (rows().length === 10 ? true : null), 6000);
    r.ui = { afterDelete, rowsEnd: rows().length, status: status() };
    checks.ui = afterDelete.rows === 9 && afterDelete.dirty === true && rows().length === 10;

    // Déplacement au clavier : la dernière page en tête (Alt+Début).
    step = "déplacement";
    mouseClick(rows()[9]);
    await sleep(100);
    const gen1 = info()?.generation ?? 0;
    keyOn(rows()[9] ?? grid, "Home", { altKey: true });
    await waitFor(() => ((info()?.generation ?? 0) > gen1 ? true : null), 6000);
    r.moveStatus = status();
    // Retour à la lecture (Échap), puis enregistrement et relecture du fichier.
    step = "retour lecture";
    // Échap vide d'abord la sélection (comportement de la grille), puis ferme la vue.
    keyOn(grid, "Escape");
    await sleep(150);
    if (visible("[data-organize]")) keyOn(grid, "Escape");
    await waitFor(() => (visible("[data-organize]") ? null : true), 4000);
    step = "enregistrement";
    const saved = await actions.save(doc.id);
    await actions.closeDoc(doc.id);
    await sleep(200);
    const back = await actions.openPath(work);
    if (!back) throw new Error("relecture impossible");
    const words = async (p: number) => (await engine.textLayer(back.id, p)).flat().map((w) => w.t).join("");
    const firstText = await words(0);
    const pages = back.pages;
    r.saved = { saved, pageCount: back.pageCount, first: firstText.slice(0, 40), sizes: pages.slice(0, 3) };
    // Ordre attendu : [10, 1 (pivotée), blanche, 3, 4, …, 9] — la 2 a disparu.
    const labels: string[] = [];
    for (let p = 0; p < back.pageCount; p++) {
      const t = (await words(p)).replace(/\s/g, "");
      labels.push(/—page(\d+)/.exec(t)?.[1] ?? "-");
    }
    r.labels = labels;
    const [w0, h0] = pages[1] ?? [0, 0];
    checks.saved = saved && back.pageCount === 10 && labels.join(",") === "10,1,-,3,4,5,6,7,8,9" && w0 > h0;

    // Extraire, diviser, combiner (fichiers écrits, document ouvert inchangé).
    step = "extraction";
    const ext = dir + "pages-extrait.pdf";
    await engine.extractPages(back.id, [0, 1], ext);
    const split = await engine.splitPages(back.id, 4, dir.replace(/[\\/]$/, ""));
    const comb = dir + "pages-combine.pdf";
    const combined = await engine.combine([ext, dir + "07-tailles-mixtes-rotation.pdf"], comb, { size: { kind: "a4" }, margin: 0 });
    const e = await engine.open(ext);
    const extCount = e.pageCount;
    engine.close(e.id);
    r.files = { extCount, split: split.map((f) => f.split(/[\\/]/).pop()), combined };
    checks.files = extCount === 2 && split.length === 3 && split[0]?.endsWith("pages-organiser - partie 1.pdf") === true && combined > 2;
    await actions.closeDoc(back.id);

    // Document protégé : réorganiser oui (il reste chiffré), mais pas de copie sans protection.
    step = "document protégé";
    const locked = await actions.openPath(dir + "09-chiffre-aes256.pdf", "test1234");
    if (!locked) throw new Error("document protégé non ouvert");
    const refused = await engine.extractPages(locked.id, [0], dir + "pages-fuite.pdf").then(() => "accepté", (err) => String(err));
    r.locked = { refused };
    checks.locked = refused.includes("encrypted");
    await actions.closeDoc(locked.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
    r.status = visible<HTMLElement>("[data-organize-status]")?.textContent ?? null;
    r.rowsNow = visible<HTMLElement>("[data-organize] [role='grid']")?.querySelectorAll("[role='row']").length ?? null;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 4;
  return r;
}

/** Phase 2, « Exporter en image » : boîte ouverte depuis la barre d'outils (pages, format,
 *  résolution) et depuis l'organisation (pages choisies) ; images écrites aux bonnes dimensions,
 *  renommées si le fichier existe ; refus si l'auteur interdit la copie (bouton désactivé). */
async function runPhase2Image(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).find((el) => !el.closest("[hidden]") && !el.closest(".hidden"));
  const button = (label: string) => visible<HTMLButtonElement>(`button[aria-label="${label}"]`);
  let step = "début";
  try {
    const doc = await actions.openPath(dir + "07-tailles-mixtes-rotation.pdf");
    if (!doc) throw new Error("07 introuvable");
    await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    step = "boîte depuis la barre";
    (await waitFor(() => button("Exporter en image"), 6000)).click();
    const dlg = await waitFor(() => visible<HTMLElement>("[data-export-image]"), 4000);
    const radios = Array.from(dlg.querySelectorAll("label")).map((l) => l.textContent ?? "");
    const fromBar = { radios: radios.filter((x) => x.startsWith("Page") || x.startsWith("Toutes")), hasFormat: !!dlg.textContent?.includes("Format"), hasDpi: !!dlg.textContent?.includes("Résolution") };
    Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent === "Annuler")?.click();
    await waitFor(() => (visible("[data-export-image]") ? null : true), 3000);
    step = "boîte depuis l'organisation";
    (await waitFor(() => button("Organiser les pages"), 3000)).click();
    const grid = await waitFor(() => visible<HTMLElement>("[data-organize] [role='grid']"), 6000);
    const row = grid.querySelectorAll<HTMLElement>("[role='row']")[1];
    if (row) {
      const b = row.getBoundingClientRect();
      const init: PointerEventInit = { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: b.left + b.width / 2, clientY: b.top + b.height / 3 };
      row.dispatchEvent(new PointerEvent("pointerdown", init));
      row.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      row.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: 1 }));
    }
    await sleep(150);
    (await waitFor(() => button("Exporter les pages choisies en image"), 3000)).click();
    const dlg2 = await waitFor(() => visible<HTMLElement>("[data-export-image]"), 4000);
    const chosenLabel = Array.from(dlg2.querySelectorAll("label")).map((l) => l.textContent ?? "").find((x) => x.startsWith("Pages choisies")) ?? null;
    Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent === "Annuler")?.click();
    await waitFor(() => (visible("[data-export-image]") ? null : true), 3000);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(150);
    if (visible("[data-organize]")) grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    r.dialog = { fromBar, chosenLabel };
    checks.dialog = fromBar.radios.length >= 3 && fromBar.hasFormat && fromBar.hasDpi && chosenLabel === "Pages choisies (2)";

    step = "fichiers";
    const png = await engine.exportImage(doc.id, 0, { format: "png", dpi: 72, quality: 85, annotations: true }, dir + "image-p1.png", false);
    const jpg1 = await engine.exportImage(doc.id, 1, { format: "jpeg", dpi: 150, quality: 80, annotations: true }, dir + "image-p2.jpg", true);
    const jpg2 = await engine.exportImage(doc.id, 1, { format: "jpeg", dpi: 150, quality: 80, annotations: true }, dir + "image-p2.jpg", true);
    const size = doc.pages[1] ?? [0, 0];
    r.files = { png: [png.width, png.height], jpg: [jpg1.width, jpg1.height, jpg1.bytes], second: jpg2.path.split(/[\\/]/).pop() };
    checks.files =
      Math.abs(png.width - Math.round(doc.pages[0]?.[0] ?? 0)) <= 1 &&
      Math.abs(jpg1.width - Math.round(((size[0] ?? 0) * 150) / 72)) <= 1 &&
      jpg2.path.endsWith("image-p2 (2).jpg") &&
      jpg1.bytes > 1000;
    await actions.closeDoc(doc.id);

    step = "copie interdite";
    const locked = await actions.openPath(dir + "09-chiffre-aes256.pdf", "test1234");
    if (!locked) throw new Error("document protégé non ouvert");
    await waitFor(() => (actions.activeId() === locked.id ? true : null), 4000);
    await sleep(200);
    const disabled = button("Export en image désactivé par l'auteur")?.disabled ?? null;
    const refused = await engine.exportImage(locked.id, 0, { format: "png", dpi: 72, quality: 85, annotations: true }, dir + "image-fuite.png", false).then(() => "accepté", (e) => String(e));
    r.locked = { disabled, refused };
    checks.locked = disabled === true && refused.includes("copy_forbidden");
    await actions.closeDoc(locked.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 3;
  return r;
}

/** Phase 2, « Créer un PDF depuis des images » : images produites par l'export, PDF créé en A4
 *  (sens de l'image) ou à la taille de l'image, mélange PDF + image, image insérée dans un document
 *  ouvert (page de la taille des voisines), image absente refusée. */
async function runPhase2Images(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  let step = "début";
  try {
    step = "images de test";
    const src = await engine.open(dir + "07-tailles-mixtes-rotation.pdf");
    const portrait = await engine.exportImage(src.id, 0, { format: "png", dpi: 72, quality: 85, annotations: true }, dir + "img-portrait.png", false);
    const landscape = await engine.exportImage(src.id, 1, { format: "jpeg", dpi: 150, quality: 85, annotations: true }, dir + "img-paysage.jpg", false);
    engine.close(src.id);

    step = "A4";
    const a4 = dir + "images-a4.pdf";
    const n1 = await engine.combine([portrait.path, landscape.path], a4, { size: { kind: "a4" }, margin: 0 });
    const d1 = await engine.open(a4);
    const sizes1 = d1.pages.map(([w, h]) => [Math.round(w), Math.round(h)]);
    engine.close(d1.id);
    r.a4 = { n1, sizes1 };
    checks.a4 = n1 === 2 && sizes1[0]?.join("x") === "595x842" && sizes1[1]?.join("x") === "842x595";

    step = "taille de l'image";
    const natural = dir + "images-naturel.pdf";
    await engine.combine([portrait.path], natural, { size: { kind: "image" }, margin: 0 });
    const d2 = await engine.open(natural);
    // PNG sans résolution inscrite : 96 ppp, soit les trois quarts des pixels en points.
    const [w2, h2] = d2.pages[0] ?? [0, 0];
    engine.close(d2.id);
    r.natural = { px: [portrait.width, portrait.height], pt: [Math.round(w2), Math.round(h2)] };
    checks.natural = Math.abs(w2 - (portrait.width * 72) / 96) < 1 && Math.abs(h2 - (portrait.height * 72) / 96) < 1;

    step = "mélange PDF et image";
    const mixed = dir + "images-melange.pdf";
    const n3 = await engine.combine([dir + "01-texte-10p.pdf", landscape.path], mixed, { size: { kind: "letter" }, margin: 28.35 });
    r.mixed = n3;
    checks.mixed = n3 === 11;

    step = "image insérée";
    const doc = await actions.openPath(mixed);
    if (!doc) throw new Error("mélange non ouvert");
    const ins = await engine.pages(doc.id, { kind: "insertFile", at: 1, path: portrait.path, password: null, pages: null });
    const [iw, ih] = ins.info.pages[1] ?? [0, 0];
    const [nw, nh] = ins.info.pages[0] ?? [1, 1];
    r.inserted = { count: ins.info.pageCount, size: [Math.round(iw), Math.round(ih)], canUndo: ins.canUndo };
    checks.inserted = ins.info.pageCount === 12 && Math.round(iw) === Math.round(nw) && Math.round(ih) === Math.round(nh) && ins.canUndo;

    step = "fichier refusé";
    const bad = await engine.combine([dir + "img-absente.png"], dir + "images-faux.pdf", { size: { kind: "a4" }, margin: 0 }).then(
      () => "accepté",
      (e) => String(e),
    );
    r.bad = bad;
    checks.bad = bad !== "accepté";
    await actions.closeDoc(doc.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 5;
  return r;
}

/** Phase 2, « Protéger par mot de passe » : boîte ouverte depuis la barre, mots de passe et
 *  restrictions saisis, « Protéger et enregistrer » ; le fichier demande le mot de passe et limite
 *  les droits ; l'auteur garde tous les droits dans sa session et retire la protection. */
async function runPhase2Password(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).find((el) => !el.closest("[hidden]") && !el.closest(".hidden"));
  const button = (label: string) => visible<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const dialogButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent?.trim() === text);
  const labelled = (text: string) => Array.from(document.querySelectorAll<HTMLElement>("[data-protect] label")).find((l) => l.textContent?.trim().startsWith(text));
  let step = "début";
  try {
    const work = dir + "mot-de-passe.pdf";
    await engine.combine([dir + "01-texte-10p.pdf"], work, { size: { kind: "a4" }, margin: 0 });
    const doc = await actions.openPath(work);
    if (!doc) throw new Error("copie introuvable");
    await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const gen = () => actions.openDocs().find((d) => d.id === doc.id)?.generation ?? 0;

    step = "boîte";
    (await waitFor(() => button("Protéger par mot de passe"), 6000)).click();
    await waitFor(() => visible("[data-protect]"), 4000);
    step = "saisie";
    const pw = () => Array.from(document.querySelectorAll<HTMLInputElement>("[data-protect] input[type='password']"));
    setNativeValue(pw()[0] as HTMLInputElement, "ouvre-moi");
    setNativeValue(pw()[1] as HTMLInputElement, "ouvre-moi");
    step = "restrictions";
    const box = labelled("Limiter l'impression");
    (box?.querySelector("input") ?? box)?.click();
    await waitFor(() => (pw().length === 4 ? true : null), 3000);
    setNativeValue(pw()[2] as HTMLInputElement, "droits-auteur");
    setNativeValue(pw()[3] as HTMLInputElement, "droits-auteur");
    await sleep(100);
    const g0 = gen();
    step = "protéger";
    (await waitFor(() => dialogButton("Protéger et enregistrer"), 3000)).click();
    await waitFor(() => (gen() > g0 && !visible("[data-protect]") ? true : null), 8000);
    const dirty = actions.openDocs().find((d) => d.id === doc.id)?.dirty;

    step = "fichier protégé";
    const noPw = await engine.open(work).then(
      (d) => (engine.close(d.id), "ouvert"),
      (e) => (isOpenError(e) ? e.kind : String(e)),
    );
    const asUser = await engine.open(work, "ouvre-moi");
    const userPerms = asUser.permissions;
    engine.close(asUser.id);
    r.protected = { dirty, noPw, userPerms };
    checks.protected = dirty === false && noPw === "password_required" && userPerms.print && !userPerms.copy && !userPerms.assemble && userPerms.annotate;

    step = "retirer";
    const g1 = gen();
    (await waitFor(() => button("Protéger par mot de passe"), 3000)).click();
    await waitFor(() => visible("[data-protect]"), 4000);
    const banner = !!document.querySelector("[data-protect]")?.textContent?.includes("déjà protégé");
    (await waitFor(() => dialogButton("Retirer la protection"), 3000)).click();
    await waitFor(() => (gen() > g1 && !visible("[data-protect]") ? true : null), 8000);
    const clear = await engine.open(work);
    const clearPerms = clear.permissions;
    engine.close(clear.id);
    r.removed = { banner, encrypted: clear.encrypted, assemble: clearPerms.assemble };
    checks.removed = banner && !clear.encrypted && clearPerms.assemble && clearPerms.copy;

    step = "copie interdite sans les droits";
    // Ouvert avec le seul mot de passe d'ouverture d'un document limité : pas de changement possible.
    const restricted = await actions.openPath(dir + "09-chiffre-aes256.pdf", "test1234");
    if (!restricted) throw new Error("document protégé non ouvert");
    const refused = await engine.protect(restricted.id, null, null).then(
      () => "accepté",
      (e) => String(e),
    );
    r.refused = refused;
    checks.refused = refused.includes("owner_required");
    await actions.closeDoc(restricted.id);
    await actions.closeDoc(doc.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 3;
  return r;
}

/** Phase 2, « Compresser » : PDF lourd fabriqué (images à 600 ppp), compressé depuis la boîte
 *  (« Standard », « Compresser et remplacer ») ; fichier bien plus léger, toujours lisible ;
 *  mode sans perte dans une copie ; document protégé refusé. */
async function runPhase2Compress(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).find((el) => !el.closest("[hidden]") && !el.closest(".hidden"));
  const button = (label: string) => visible<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const dialogButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => b.textContent?.trim() === text);
  let step = "début";
  try {
    step = "PDF lourd";
    const src = await engine.open(dir + "04-vectoriel-transparence.pdf");
    const big = await engine.exportImage(src.id, 0, { format: "jpeg", dpi: 600, quality: 100, annotations: true }, dir + "lourd.jpg", false);
    const big2 = await engine.exportImage(src.id, 0, { format: "png", dpi: 400, quality: 85, annotations: true }, dir + "lourd.png", false);
    engine.close(src.id);
    const heavy = dir + "lourd.pdf";
    await engine.combine([big.path, big2.path], heavy, { size: { kind: "a4" }, margin: 0 });
    const doc = await actions.openPath(heavy);
    if (!doc) throw new Error("PDF lourd non ouvert");
    await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    const before = (await engine.properties(doc.id)).fileSize;
    const gen = () => actions.openDocs().find((d) => d.id === doc.id)?.generation ?? 0;

    step = "boîte";
    (await waitFor(() => button("Réduire la taille du fichier"), 6000)).click();
    await waitFor(() => visible("[data-compress]"), 4000);
    const g0 = gen();
    (await waitFor(() => dialogButton("Compresser et remplacer"), 3000)).click();
    await waitFor(() => (gen() > g0 && !visible("[data-compress]") ? true : null), 30000);
    const after = (await engine.properties(doc.id)).fileSize;
    const toast = document.querySelector('[aria-label="Notifications"]')?.textContent ?? "";
    const pages = actions.openDocs().find((d) => d.id === doc.id) ? (await engine.properties(doc.id)).pageCount : 0;
    const tile = await fetch(engine.tileUrl(doc.id, gen(), 0, 0, 0.3, 0, 0)).then((x) => x.ok && x.blob().then((b) => b.size > 0)).catch(() => false);
    r.dialog = { before, after, pages, tile, toast: /lourd\.pdf[^)]*\)/.exec(toast)?.[0] ?? null };
    checks.dialog = after < before / 3 && pages === 2 && !!tile && !!r.dialog && (r.dialog as { toast: string | null }).toast !== null;
    await actions.closeDoc(doc.id);

    step = "sans perte";
    const text = dir + "texte-compact.pdf";
    await engine.combine([dir + "02-texte-1000p.pdf"], dir + "texte-source.pdf", { size: { kind: "a4" }, margin: 0 });
    const t = await actions.openPath(dir + "texte-source.pdf");
    if (!t) throw new Error("texte non ouvert");
    const lossless = await engine.compress(t.id, { images: null }, text).catch((e) => String(e));
    r.lossless = typeof lossless === "string" ? lossless : lossless.report;
    checks.lossless = typeof lossless !== "string" ? lossless.report.after <= lossless.report.before : lossless.includes("no_gain");
    await actions.closeDoc(t.id);

    step = "protégé";
    const locked = await actions.openPath(dir + "09-chiffre-aes256.pdf", "test1234");
    if (!locked) throw new Error("document protégé non ouvert");
    const refused = await engine.compress(locked.id, { images: { dpi: 150, quality: 75 } }, null).then(
      () => "accepté",
      (e) => String(e),
    );
    r.refused = refused;
    checks.refused = refused.includes("encrypted");
    await actions.closeDoc(locked.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 3;
  return r;
}

/** Phase 2, « Ajouter du texte » : outil « Écrire dans la page », texte tapé dans la zone de
 *  saisie, devenu du vrai texte (couche de texte) ; bloc choisi, mis en gras, déplacé au clavier,
 *  modifié par double-clic ; enregistré et relu ; supprimé ; cyrillique accepté. */
async function runPhase2PageText(engine: EngineClient, actions: AppActions, path: string) {
  const r: Record<string, unknown> = {};
  const checks: Record<string, boolean> = {};
  const dir = dirOf(path);
  const visible = <T extends Element>(sel: string) => Array.from(document.querySelectorAll<T>(sel)).find((el) => !el.closest("[hidden]") && !el.closest(".hidden"));
  const typeInDraft = async (text: string) => {
    const ta = await waitFor(() => visible<HTMLTextAreaElement>('textarea[aria-label="Texte écrit dans la page"]'), 4000);
    setNativeValue(ta, text);
    await sleep(50);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  };
  const press = (el: Element) => {
    const b = el.getBoundingClientRect();
    const init: PointerEventInit = { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: b.left + 3, clientY: b.top + 3 };
    el.dispatchEvent(new PointerEvent("pointerdown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  };
  const words = async (id: number) => (await engine.textLayer(id, 0)).flat().map((w) => w.t).join("");
  let step = "début";
  try {
    const work = dir + "texte-ajoute.pdf";
    await engine.combine([dir + "01-texte-10p.pdf"], work, { size: { kind: "a4" }, margin: 0 });
    const doc = await actions.openPath(work);
    if (!doc) throw new Error("copie introuvable");
    const a = await waitFor(() => (actions.activeId() === doc.id ? actions.doc() : null));
    await waitFor(() => Array.from(document.querySelectorAll('[data-page-index="0"] img')).find((el) => !el.closest("[hidden]")), 8000);

    step = "écrire";
    a.setTool("pagetext");
    await sleep(150);
    a.place(0, 300, 650);
    await typeInDraft("Bonjour PDFReader\nDeuxième ligne");
    const b1 = await until(async () => ((await a.pageTexts(0)).length === 1 ? (await a.pageTexts(0))[0] : null), 6000);
    const dirty = actions.openDocs().find((d) => d.id === doc.id)?.dirty;
    const w1 = await words(doc.id);
    r.write = { text: b1?.text, x: b1?.x, dirty, inTextLayer: w1.includes("Bonjour") && w1.includes("Deuxième") };
    checks.write = b1?.text === "Bonjour PDFReader\nDeuxième ligne" && dirty === true && w1.includes("Bonjour");

    step = "choisir, gras, déplacer";
    const outline = await waitFor(() => visible<HTMLElement>("[data-page-text]"), 4000);
    press(outline);
    await waitFor(() => (visible("[data-pagetext-bar]")?.textContent ? true : null), 3000);
    visible<HTMLButtonElement>('[data-pagetext-bar] button[aria-label="Gras"]')?.click();
    await until(async () => ((await a.pageTexts(0))[0]?.style.bold ? true : null), 6000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    const b2 = await until(async () => {
      const b = (await a.pageTexts(0))[0];
      return b && b.x === 310 ? b : null;
    }, 6000);
    r.select = { bold: b2?.style.bold, x: b2?.x };
    checks.select = b2?.style.bold === true && b2.x === 310;

    step = "déplacer après enregistrement";
    await actions.save(doc.id);
    await sleep(800);
    // Après l'enregistrement (nouvelle génération), seule la version 0 est demandée : une ancienne
    // version de la page, gardée en cache, montrerait un contenu périmé.
    const afterSave = Array.from(document.querySelectorAll<HTMLImageElement>('[data-page-index="0"] img'))
      .filter((i) => !i.closest("[hidden]"))
      .map((i) => i.src.split("/").slice(-7, -4).join("/"));
    r.afterSaveTiles = [...new Set(afterSave)];
    checks.freshAfterSave = afterSave.length > 0 && afterSave.every((x) => x.split("/")[2] === "0");
    const outlineS = await waitFor(() => visible<HTMLElement>("[data-page-text]"), 4000);
    // Glisser à la souris : appui, mouvements, relâchement (comme une vraie main).
    {
      const bb = outlineS.getBoundingClientRect();
      const base: PointerEventInit = { bubbles: true, cancelable: true, pointerType: "mouse", pointerId: 7, isPrimary: true, button: 0, buttons: 1 };
      let cx = bb.left + 5;
      let cy = bb.top + 5;
      outlineS.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: cx, clientY: cy }));
      for (let k = 0; k < 10; k++) {
        cx += 6;
        cy += 4;
        await sleep(16);
        outlineS.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: cx, clientY: cy }));
      }
      await sleep(30);
      outlineS.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, clientX: cx, clientY: cy }));
    }
    await sleep(2000);
    const imgs = () =>
      Array.from(document.querySelectorAll<HTMLImageElement>('[data-page-index="0"] img'))
        .filter((i) => !i.closest("[hidden]"))
        .map((i) => `${i.src.split("/").slice(-7).join("/")} op=${i.style.opacity || "1"}`);
    const afterDrag = (await a.pageTexts(0))[0];
    const shown = imgs().filter((x) => x.endsWith("op=1"));
    r.dragAfterSave = { x: afterDrag?.x, y: afterDrag?.y, shownVersion: shown[1]?.split("/")[2] ?? null };
    // Bloc déplacé vers la droite et le bas ; la page affichée est la nouvelle version (1 après l'enregistrement).
    checks.drag = !!afterDrag && afterDrag.x > 330 && afterDrag.y > 655 && shown.length > 0 && shown.every((x) => x.split("/")[2] === "1");
    step = "modifier";
    const outline2 = await waitFor(() => visible<HTMLElement>("[data-page-text]"), 4000);
    outline2.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const ta = await waitFor(() => visible<HTMLTextAreaElement>('textarea[aria-label="Texte écrit dans la page"]'), 4000);
    const initial = ta.value;
    await typeInDraft("Texte modifié");
    const b3 = await until(async () => ((await a.pageTexts(0))[0]?.text === "Texte modifié" ? (await a.pageTexts(0))[0] : null), 6000);
    const w3 = await words(doc.id);
    r.edit = { initial, text: b3?.text, gone: !w3.includes("Bonjour") };
    checks.edit = initial === "Bonjour PDFReader\nDeuxième ligne" && b3?.text === "Texte modifié" && b3.style.bold && !w3.includes("Bonjour");

    step = "cyrillique";
    a.place(0, 60, 760);
    await typeInDraft("Привет, мир");
    await until(async () => ((await a.pageTexts(0)).length === 2 ? true : null), 6000);
    checks.cyrillic = (await words(doc.id)).includes("Привет");

    step = "enregistrer et relire";
    a.setTool("select");
    const saved = await actions.save(doc.id);
    await actions.closeDoc(doc.id);
    await sleep(200);
    const back = await actions.openPath(work);
    if (!back) throw new Error("relecture impossible");
    const a2 = await waitFor(() => (actions.activeId() === back.id ? actions.doc() : null));
    const blocks = await a2.pageTexts(0);
    const wb = await words(back.id);
    r.reload = { saved, blocks: blocks.map((b) => [b.text, b.x, b.y, b.style.bold]), original: wb.includes("page 1") || wb.includes("Textesimple") };
    checks.reload = saved && blocks.length === 2 && blocks.some((b) => b.text === "Texte modifié" && b.x > 330 && b.style.bold) && wb.includes("Привет");

    step = "supprimer";
    a2.setTool("pagetext");
    await waitFor(() => visible<HTMLElement>("[data-page-text]"), 4000);
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-page-text]")).find((el) => !el.closest("[hidden]") && el.getAttribute("aria-label")?.includes("Texte modifié"));
    if (target) press(target);
    await sleep(150);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    const left = await until(async () => ((await a2.pageTexts(0)).length === 1 ? true : null), 6000);
    const remaining = (await a2.pageTexts(0)).map((x) => x.text);
    r.delete = { targetFound: !!target, remaining };
    checks.delete = !!left && remaining.length === 1 && remaining[0] === "Привет, мир";
    a2.setTool("select");
    await actions.save(back.id);
    await actions.closeDoc(back.id);
  } catch (err) {
    r.error = `${step} : ${String(err)}`;
  }
  r.checks = checks;
  r.ok = Object.values(checks).every(Boolean) && Object.keys(checks).length >= 8;
  return r;
}

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
      if (first.name.includes("calculs")) {
        const fl = await d.fields(0);
        const at = (n: string) => fl.find((f) => f.name === n)?.index ?? -1;
        await d.setField(0, at("qte"), { kind: "text", value: "3" });
        await d.setField(0, at("prix"), { kind: "text", value: "12,5" });
        await d.setField(0, at("remise"), { kind: "text", value: "5" });
        await d.setField(0, at("qte"), { kind: "text", value: "150" });
        await sleep(pause);
      } else if (first.name.includes("tailles-mixtes")) {
        // Signets en cours de modification.
        await engine.setBookmarks(first.id, [
          { title: "Introduction", page: 0, top: null, uri: null, children: [] },
          { title: "Chapitre 1 — Méthode", page: 1, top: 120, uri: null, children: [{ title: "1.1 Données", page: 2, top: null, uri: null, children: [] }] },
          { title: "Annexes", page: 4, top: null, uri: null, children: [] },
        ]);
        d.openPanel("bookmarks");
        await sleep(400);
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-bookmarks-panel] [role="row"]'));
        rows.find((x) => x.textContent?.startsWith("Chapitre 1"))?.click();
        await sleep(pause);
      } else if (first.name.includes("courier")) {
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

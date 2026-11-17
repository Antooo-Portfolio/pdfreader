/** Phase 2, « Organiser les pages » : grille des pages du document, sélection multiple, glisser-
 *  déposer (souris et clavier), pivoter, supprimer, insérer (page blanche, autre PDF), extraire,
 *  diviser, annuler / rétablir. Les opérations modifient le document ouvert (enregistré avec
 *  Ctrl+S, comme le reste) ; extraire et diviser écrivent de nouveaux fichiers. */
import {
  t,
  Button,
  Dialog,
  GridList,
  GridListItem,
  IconButton,
  Menu,
  MenuItem,
  MenuTrigger,
  NumberField,
  Toolbar,
  ToolbarSeparator,
  useToast,
} from "@pdfreader/ui";
import { clsx } from "clsx";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileOutput,
  FilePlus2,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Key, Selection } from "react-aria-components";
import { type DocInfo, type EngineClient, type PageOp, TILE } from "./engine";
import type { OpenDoc } from "./state";

/** Largeur des vignettes de la grille (px CSS). */
const CELL = 150;

const keyOf = (i: number) => `p${i}`;
const indexOf = (k: Key) => Number(String(k).slice(1));

/** Message lisible pour une erreur du moteur. */
export function pagesError(e: unknown): string {
  const m = String(e);
  if (m.includes("assemble_forbidden"))
    return t("L'auteur de ce document interdit d'en réorganiser les pages.");
  if (m.includes("last_page"))
    return t("Un document doit garder au moins une page.");
  if (m.includes("source_password"))
    return t(
      "Ce fichier est protégé par un mot de passe : ses pages ne peuvent pas être insérées.",
    );
  if (m.includes("encrypted"))
    return t(
      "Ce document est protégé : en extraire des pages créerait une copie sans protection.",
    );
  if (m.includes("source_unreadable"))
    return t("Ce fichier n'a pas pu être lu : il est peut-être endommagé.");
  return t("L'opération a échoué : {detail}", { detail: m });
}

/** Plages lisibles (« 2-4, 7 ») d'une liste d'index triés (à partir de 0). */
export function rangesLabel(pages: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === (pages[j] ?? 0) + 1) j++;
    const a = (pages[i] ?? 0) + 1;
    const b = (pages[j] ?? 0) + 1;
    out.push(a === b ? String(a) : `${a}-${b}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function OrganizeView({
  engine,
  doc,
  dpr,
  history,
  onHistory,
  onChanged,
  onOpenPath,
  onClose,
}: {
  engine: EngineClient;
  doc: OpenDoc;
  dpr: number;
  /** Peut-on annuler / rétablir (selon la dernière opération) ? */
  history: { canUndo: boolean; canRedo: boolean };
  onHistory: (h: { canUndo: boolean; canRedo: boolean }) => void;
  onChanged: (info: DocInfo) => void;
  onOpenPath: (path: string) => void;
  /** Retour à la lecture, éventuellement sur une page (à partir de 1). */
  onClose: (page?: number) => void;
}) {
  const { info } = doc;
  const toast = useToast();
  const [selected, setSelected] = useState<Set<Key>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [perFile, setPerFile] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  /** Glisser en cours : pages déplacées, position d'arrivée (avant la page `before`), trait d'insertion. */
  const [drag, setDrag] = useState<{
    pages: number[];
    before: number;
    bar: { x: number; y: number; h: number } | null;
  } | null>(null);
  const press = useRef<{
    x: number;
    y: number;
    index: number;
    selected: boolean;
    id: number;
  } | null>(null);

  const chosen = useMemo(
    () =>
      [...selected]
        .map(indexOf)
        .filter((i) => i >= 0 && i < info.pageCount)
        .sort((a, b) => a - b),
    [selected, info.pageCount],
  );
  const all = chosen.length === info.pageCount;

  const apply = useCallback(
    async (
      op: PageOp,
      select?: (map: (number | null)[] | null, count: number) => number[],
    ) => {
      if (busy) return;
      setBusy(true);
      try {
        const r = await engine.pages(info.id, op);
        onChanged(r.info);
        onHistory({ canUndo: r.canUndo, canRedo: r.canRedo });
        const next = select
          ? select(r.map, r.info.pageCount)
          : r.map
            ? chosen
                .map((i) => r.map?.[i] ?? null)
                .filter((i): i is number => i !== null)
            : [];
        setSelected(new Set(next.map(keyOf)));
      } catch (e) {
        toast({ tone: "error", message: pagesError(e) });
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      engine,
      info.id,
      info.pageCount,
      chosen,
      onChanged,
      onHistory,
      toast,
    ],
  );

  /** Pages insérées : index absents de la correspondance des anciennes pages. */
  const inserted = (map: (number | null)[] | null, count: number) => {
    const taken = new Set((map ?? []).filter((i): i is number => i !== null));
    return Array.from({ length: count }, (_, i) => i).filter(
      (i) => !taken.has(i),
    );
  };
  const insertAt = chosen.length ? (chosen.at(-1) ?? 0) + 1 : info.pageCount;

  const rotate = (quarters: number) =>
    chosen.length && void apply({ kind: "rotate", pages: chosen, quarters });
  const remove = () =>
    chosen.length &&
    !all &&
    void apply({ kind: "delete", pages: chosen }, () => []);
  const insertBlank = () => {
    const ref = info.pages[chosen.at(-1) ?? info.pageCount - 1] ?? [595, 842];
    void apply(
      { kind: "insertBlank", at: insertAt, width: ref[0], height: ref[1] },
      inserted,
    );
  };
  const insertFile = async () => {
    const files = await engine.pickFiles();
    const path = files[0];
    if (!path) return;
    await apply(
      { kind: "insertFile", at: insertAt, path, password: null, pages: null },
      inserted,
    );
  };
  const undo = () => history.canUndo && void apply({ kind: "undo" }, () => []);
  const redo = () => history.canRedo && void apply({ kind: "redo" }, () => []);

  const stem = info.name.replace(/\.pdf$/i, "");
  const extract = async () => {
    if (!chosen.length) return;
    const target = await engine.pickSavePath(
      info.path.replace(/[^\\/]+$/, "") +
        t("{name} (pages {pages}).pdf", {
          name: stem,
          pages: rangesLabel(chosen),
        }).replace(/[,:]/g, ""),
    );
    if (!target) return;
    try {
      await engine.extractPages(info.id, chosen, target);
      toast({
        tone: "success",
        message: t("{count} pages extraites dans « {name} ».", {
          count: chosen.length,
          name: target.split(/[\\/]/).pop() ?? "",
        }),
        action: { label: t("Ouvrir"), onAction: () => onOpenPath(target) },
      });
    } catch (e) {
      toast({ tone: "error", message: pagesError(e) });
    }
  };
  const split = async () => {
    const folder = await engine.pickFolder();
    if (!folder) return;
    setSplitOpen(false);
    try {
      const files = await engine.splitPages(info.id, perFile, folder);
      toast({
        tone: "success",
        message: t("{count} fichiers créés dans « {folder} ».", {
          count: files.length,
          folder: folder.split(/[\\/]/).pop() || folder,
        }),
      });
    } catch (e) {
      toast({ tone: "error", message: pagesError(e) });
    }
  };

  /** Déplace la sélection d'une place (ou au début / à la fin). */
  const shift = (where: "left" | "right" | "start" | "end") => {
    if (!chosen.length || busy) return;
    const first = chosen[0] ?? 0;
    const last = chosen.at(-1) ?? 0;
    const before =
      where === "start"
        ? 0
        : where === "end"
          ? info.pageCount
          : where === "left"
            ? Math.max(0, first - 1)
            : Math.min(info.pageCount, last + 2);
    void apply({ kind: "move", pages: chosen, before });
  };

  // Glisser-déposer à la souris, géré ici : le glisser-déposer natif de la WebView est réservé aux
  // fichiers venus de l'Explorateur (Tauri l'intercepte sous Windows).
  const items = () =>
    Array.from(
      scrollBox.current?.querySelectorAll<HTMLElement>("[data-cell]") ?? [],
    );
  /** Position d'arrivée sous le pointeur : avant la vignette visée, ou après si le pointeur est sur sa moitié droite. */
  const dropAt = (x: number, y: number) => {
    const box = scrollBox.current;
    const cells = items();
    if (!box || !cells.length) return null;
    const base = box.getBoundingClientRect();
    let best: {
      before: number;
      bar: { x: number; y: number; h: number };
      d: number;
    } | null = null;
    cells.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const inRow = y >= r.top - 8 && y <= r.bottom + 8;
      const d = inRow
        ? Math.abs(x - (r.left + r.width / 2))
        : Math.abs(y - (r.top + r.height / 2)) + 10000;
      if (!best || d < best.d) {
        const after = x > r.left + r.width / 2;
        best = {
          before: after ? i + 1 : i,
          bar: {
            x: (after ? r.right + 8 : r.left - 8) - base.left + box.scrollLeft,
            y: r.top - base.top + box.scrollTop,
            h: r.height,
          },
          d,
        };
      }
    });
    return best as {
      before: number;
      bar: { x: number; y: number; h: number };
    } | null;
  };
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell) return;
    const index = Number(cell.dataset.cell);
    const isSelected = selected.has(keyOf(index));
    press.current = {
      x: e.clientX,
      y: e.clientY,
      index,
      selected: isSelected,
      id: e.pointerId,
    };
    // Page déjà choisie, sans Ctrl ni Maj : on garde toute la sélection pour la glisser (le clic
    // simple, sans glisser, la réduit à cette page au relâchement).
    if (isSelected && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      e.stopPropagation();
      cell.closest<HTMLElement>("[role='row']")?.focus();
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId || busy) return;
    if (!drag) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      const pages = p.selected ? chosen : [p.index];
      if (!p.selected) setSelected(new Set([keyOf(p.index)]));
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ pages, before: p.index, bar: null });
    }
    // Défilement quand le pointeur approche du bord.
    const box = scrollBox.current;
    if (box) {
      const r = box.getBoundingClientRect();
      if (e.clientY < r.top + 40) box.scrollTop -= 24;
      else if (e.clientY > r.bottom - 40) box.scrollTop += 24;
    }
    const at = dropAt(e.clientX, e.clientY);
    if (at) setDrag((d) => (d ? { ...d, before: at.before, bar: at.bar } : d));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || p.id !== e.pointerId) return;
    if (drag) {
      const { pages, before } = drag;
      setDrag(null);
      // Déposer une page à sa propre place ne change rien.
      const unchanged =
        pages.every(
          (pg, k) => pg === before - pages.filter((x) => x < before).length + k,
        ) &&
        pages.length > 0 &&
        pages.every((pg, k) => k === 0 || pg === (pages[k - 1] ?? 0) + 1);
      if (!unchanged) void apply({ kind: "move", pages, before });
    } else if (p.selected && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      setSelected(new Set([keyOf(p.index)]));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    let handled = true;
    if (e.ctrlKey && e.altKey && (k === "ArrowRight" || k === "ArrowLeft"))
      rotate(k === "ArrowRight" ? 1 : -1);
    else if (
      e.altKey &&
      !e.ctrlKey &&
      (k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End")
    )
      shift(
        k === "ArrowLeft"
          ? "left"
          : k === "ArrowRight"
            ? "right"
            : k === "Home"
              ? "start"
              : "end",
      );
    else if (!e.ctrlKey && k === "Escape" && drag) {
      setDrag(null);
      press.current = null;
    } else if (e.ctrlKey && !e.shiftKey && k.toLowerCase() === "z") undo();
    else if (
      e.ctrlKey &&
      (k.toLowerCase() === "y" || (e.shiftKey && k.toLowerCase() === "z"))
    )
      redo();
    else if (!e.ctrlKey && (k === "Delete" || k === "Backspace")) remove();
    else if (!e.ctrlKey && k === "Escape" && !splitOpen) onClose();
    else handled = false;
    if (handled) e.preventDefault();
    // Les raccourcis de la lecture (et les touches seules des outils) ne s'appliquent pas ici ;
    // Ctrl+S, Ctrl+W, Ctrl+P… restent ceux de l'application.
    if (handled || !e.ctrlKey) e.stopPropagation();
  };

  const scaleFor = (pw: number, ph: number) =>
    Math.round(
      Math.min((CELL * dpr) / pw, (TILE - 2) / ph, (TILE - 2) / pw) * 10000,
    ) / 10000;

  return (
    <div
      ref={root}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      data-organize
    >
      <Toolbar
        aria-label={t("Organiser les pages")}
        className="h-(--layout-toolbar) shrink-0 gap-1 border-b border-border bg-bg px-2"
      >
        <IconButton
          label={t("Revenir au document")}
          shortcut="Échap"
          icon={<ArrowLeft size={18} />}
          onPress={() => onClose()}
        />
        <span className="mx-2 truncate text-base font-semibold">
          {t("Organiser les pages")}
        </span>
        <ToolbarSeparator />
        <IconButton
          label={t("Pivoter à gauche")}
          shortcut="Ctrl+Alt+←"
          icon={<RotateCcw size={18} />}
          onPress={() => rotate(-1)}
          isDisabled={!chosen.length || busy}
        />
        <IconButton
          label={t("Pivoter à droite")}
          shortcut="Ctrl+Alt+→"
          icon={<RotateCw size={18} />}
          onPress={() => rotate(1)}
          isDisabled={!chosen.length || busy}
        />
        <IconButton
          label={t("Déplacer d'une place vers le début")}
          shortcut="Alt+←"
          icon={<ChevronLeft size={18} />}
          onPress={() => shift("left")}
          isDisabled={!chosen.length || (chosen[0] ?? 0) === 0 || busy}
        />
        <IconButton
          label={t("Déplacer d'une place vers la fin")}
          shortcut="Alt+→"
          icon={<ChevronRight size={18} />}
          onPress={() => shift("right")}
          isDisabled={
            !chosen.length ||
            (chosen.at(-1) ?? 0) === info.pageCount - 1 ||
            busy
          }
        />
        <IconButton
          label={
            all
              ? t("Supprimer (il doit rester une page)")
              : t("Supprimer les pages")
          }
          shortcut="Suppr"
          icon={<Trash2 size={18} />}
          onPress={remove}
          isDisabled={!chosen.length || all || busy}
        />
        <MenuTrigger>
          <IconButton
            label={t("Insérer des pages")}
            icon={<FilePlus2 size={18} />}
            isDisabled={busy}
          />
          <Menu aria-label={t("Insérer des pages")}>
            <MenuItem id="blank" onAction={insertBlank}>
              {t("Page blanche")}
            </MenuItem>
            <MenuItem id="file" onAction={() => void insertFile()}>
              {t("Pages d'un autre PDF…")}
            </MenuItem>
          </Menu>
        </MenuTrigger>
        <ToolbarSeparator />
        <IconButton
          label={t("Extraire les pages dans un nouveau fichier")}
          icon={<FileOutput size={18} />}
          onPress={() => void extract()}
          isDisabled={!chosen.length || busy}
        />
        <IconButton
          label={t("Diviser le document")}
          icon={<Scissors size={18} />}
          onPress={() => setSplitOpen(true)}
          isDisabled={busy}
        />
        <ToolbarSeparator />
        <IconButton
          label={t("Annuler")}
          shortcut="Ctrl+Z"
          icon={<Undo2 size={18} />}
          onPress={undo}
          isDisabled={!history.canUndo || busy}
        />
        <IconButton
          label={t("Rétablir")}
          shortcut="Ctrl+Y"
          icon={<Redo2 size={18} />}
          onPress={redo}
          isDisabled={!history.canRedo || busy}
        />
        <span
          className="ml-auto pr-2 text-sm text-muted"
          role="status"
          data-organize-status
        >
          {chosen.length
            ? t("{count} pages sélectionnées sur {total}", {
                count: chosen.length,
                total: info.pageCount,
              })
            : t("{total} pages", { total: info.pageCount })}
        </span>
        <Button variant="primary" size="sm" onPress={() => onClose()}>
          {t("Terminer")}
        </Button>
      </Toolbar>
      <div
        ref={scrollBox}
        className={clsx(
          "relative min-h-0 flex-1 overflow-auto bg-canvas p-6 select-none",
          drag && "cursor-grabbing",
        )}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
      >
        {drag?.bar && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 w-1 rounded-full bg-accent"
            style={{
              left: drag.bar.x - 2,
              top: drag.bar.y,
              height: drag.bar.h,
            }}
          />
        )}
        {drag && (
          <div role="status" className="sr-only">
            {t("Déposer avant la page {page}", { page: drag.before + 1 })}
          </div>
        )}
        <p className="mb-4 text-sm text-muted">
          {t(
            "Cliquez pour choisir des pages (Ctrl ou Maj pour plusieurs), faites-les glisser pour les déplacer. Au clavier : flèches pour aller de page en page, Espace pour choisir, Alt+← ou Alt+→ pour déplacer. Double-clic ou Entrée : ouvrir la page.",
          )}
        </p>
        <GridList
          aria-label={t("Pages de {name}", { name: info.name })}
          layout="grid"
          selectionMode="multiple"
          selectionBehavior="replace"
          selectedKeys={selected}
          onSelectionChange={(keys: Selection) =>
            setSelected(
              keys === "all"
                ? new Set(info.pages.map((_, i) => keyOf(i)))
                : new Set(keys),
            )
          }
          onAction={(k) => onClose(indexOf(k) + 1)}
          className="flex flex-wrap content-start gap-4"
        >
          {info.pages.map((size, i) => {
            const [pw, ph] = size;
            const h = Math.min(CELL * 1.6, (CELL * ph) / pw);
            const w = (h * pw) / ph;
            const scale = scaleFor(pw, ph);
            return (
              <GridListItem
                key={keyOf(i)}
                id={keyOf(i)}
                textValue={t("Page {page}", { page: i + 1 })}
                className={clsx(
                  "group relative w-[172px] p-2",
                  drag?.pages.includes(i) && "opacity-50",
                )}
              >
                <div
                  data-cell={i}
                  className="flex flex-col items-center gap-1.5"
                >
                  <div
                    className="relative grid place-items-center"
                    style={{ width: CELL, height: CELL * 1.6 }}
                  >
                    <img
                      src={engine.tileUrl(
                        info.id,
                        info.generation,
                        doc.pageVersions[i] ?? 0,
                        i,
                        scale,
                        0,
                        0,
                      )}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      className="bg-page shadow-sm outline-offset-2 group-data-selected:outline-2 group-data-selected:outline-accent"
                      style={{ width: w, height: h }}
                    />
                  </div>
                  <span className="text-sm tabular-nums" data-page-label>
                    {i + 1}
                  </span>
                </div>
              </GridListItem>
            );
          })}
        </GridList>
      </div>

      {splitOpen && (
        <Dialog
          title={t("Diviser le document")}
          size="sm"
          isOpen
          onOpenChange={(o) => !o && setSplitOpen(false)}
          footer={(close) => (
            <>
              <Button onPress={close}>{t("Annuler")}</Button>
              <Button variant="primary" onPress={() => void split()}>
                {t("Choisir le dossier…")}
              </Button>
            </>
          )}
        >
          <div className="flex flex-col gap-3 text-base">
            <NumberField
              label={t("Pages par fichier")}
              minValue={1}
              maxValue={Math.max(1, info.pageCount)}
              value={perFile}
              onChange={(v) => setPerFile(Number.isFinite(v) ? v : 1)}
              className="max-w-40"
            />
            <p className="text-sm text-muted">
              {t(
                "{files} fichiers seront créés, nommés « {name} - partie 1.pdf », « partie 2 »… Le document ouvert n'est pas modifié.",
                {
                  files: Math.ceil(info.pageCount / Math.max(1, perFile)),
                  name: stem,
                },
              )}
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

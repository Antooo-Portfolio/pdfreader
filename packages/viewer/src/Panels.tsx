import { t, PanelHeader, IconButton, EmptyState, Tree, type TreeNode, Spinner, Button, TextField, Toolbar } from "@pdfreader/ui";
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, Bookmark as BookmarkIcon, BookmarkPlus, ChevronsDownUp, ChevronsUpDown, Download, FileText, IndentDecrease, IndentIncrease, LocateFixed, Paperclip, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Attachment, type Bookmark, type EngineClient, type LinkAction, type Rotation, THUMB_WIDTH, thumbScale } from "./engine";
import { getAt, idOf, indent, insertAfter, move, outdent, type Path, pathOf, remove, update } from "./bookmarks";
import { formatSize } from "./PropertiesDialog";
import { displaySize, rotationTransform } from "./layout";
import type { OpenDoc } from "./state";

const THUMB_PAD = 8;
const THUMB_LABEL = 20;

/* ---------------------------------------------------------------- S06 Vignettes */

export function ThumbnailsPanel({
  engine,
  doc,
  rotation,
  page,
  dpr,
  onGoTo,
  onClose,
}: {
  engine: EngineClient;
  doc: OpenDoc;
  rotation: Rotation;
  /** Page courante (à partir de 1). */
  page: number;
  dpr: number;
  onGoTo: (page: number) => void;
  onClose: () => void;
}) {
  const { info } = doc;
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const focusAfter = useRef<number | null>(null);

  // Hauteur de chaque vignette (largeur fixe, hauteur selon la page affichée).
  const items = useMemo(() => {
    let y = THUMB_PAD;
    return info.pages.map((size) => {
      const [dw, dh] = displaySize(size, rotation);
      // Largeur fixe ; une page très haute est limitée à deux fois la largeur.
      const h = Math.min(THUMB_WIDTH * 2, (THUMB_WIDTH * dh) / dw);
      const w = (h * dw) / dh;
      const top = y;
      y += h + THUMB_LABEL + THUMB_PAD * 2;
      return { top, w, h };
    });
  }, [info.pages, rotation]);
  const total = (items.at(-1)?.top ?? 0) + (items.at(-1)?.h ?? 0) + THUMB_LABEL + THUMB_PAD * 2;

  const first = Math.max(0, items.findIndex((it) => it.top + it.h + THUMB_LABEL >= view.top - 400));
  let last = first;
  while (last < items.length - 1 && (items[last + 1]?.top ?? 0) <= view.top + view.height + 400) last++;

  // La page courante reste visible dans le panneau.
  useLayoutEffect(() => {
    const el = scroller.current;
    const it = items[page - 1];
    if (!el || !it) return;
    if (it.top < el.scrollTop || it.top + it.h + THUMB_LABEL > el.scrollTop + el.clientHeight) {
      el.scrollTop = it.top - el.clientHeight / 2 + it.h / 2;
    }
    if (focusAfter.current === page) {
      requestAnimationFrame(() => {
        scroller.current?.querySelector<HTMLElement>(`[data-thumb="${page}"]`)?.focus();
        focusAfter.current = null;
      });
    }
  }, [page, items]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const move = (to: number) => {
    const p = Math.min(info.pageCount, Math.max(1, to));
    focusAfter.current = p;
    onGoTo(p);
  };

  return (
    <section aria-label={t("Vignettes des pages")} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t("Vignettes")} actions={<IconButton label={t("Fermer le panneau")} size="sm" icon={<X size={16} />} onPress={onClose} />} />
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onKeyDown={(e) => {
          const keys: Record<string, number> = { ArrowDown: page + 1, ArrowUp: page - 1, PageDown: page + 5, PageUp: page - 5, Home: 1, End: info.pageCount };
          const to = keys[e.key];
          if (to !== undefined) {
            e.preventDefault();
            move(to);
          }
        }}
      >
        <ul className="relative" style={{ height: total }} aria-label={t("{count} pages", { count: info.pageCount })}>
          {items.slice(first, last + 1).map((it, j) => {
            const i = first + j;
            const current = i + 1 === page;
            const size = info.pages[i] ?? [612, 792];
            const s = thumbScale(size[0], size[1], dpr);
            const iw = (size[0] * s) / dpr;
            const ih = (size[1] * s) / dpr;
            const sideways = rotation === 90 || rotation === 270;
            // L'image est rendue à l'échelle de la vignette puis ajustée à la boîte affichée.
            const fit = it.w / (sideways ? ih : iw);
            return (
              <li key={i} className="absolute inset-x-0 flex justify-center" style={{ top: it.top }}>
                <button
                  type="button"
                  data-thumb={i + 1}
                  tabIndex={current ? 0 : -1}
                  aria-current={current ? "page" : undefined}
                  aria-label={t("Page {page}", { page: i + 1 })}
                  onClick={() => onGoTo(i + 1)}
                  className="focus-ring flex cursor-default flex-col items-center gap-1 rounded-md p-1 outline-none hover:bg-surface-hover"
                >
                  <span
                    className={clsx("pdf-page relative block overflow-hidden", current && "outline-2 outline-offset-2 outline-accent forced-colors:outline-[Highlight]")}
                    style={{ width: it.w, height: it.h }}
                  >
                    <img
                      alt=""
                      draggable={false}
                      loading="lazy"
                      src={engine.tileUrl(info.id, info.generation, doc.pageVersions[i] ?? 0, i, s, 0, 0)}
                      className="absolute top-0 left-0 max-w-none origin-top-left"
                      style={{ width: iw, height: ih, transform: `scale(${fit}) ${rotationTransform(rotation, iw, ih) ?? ""}` }}
                    />
                  </span>
                  <span className={clsx("text-xs tabular-nums", current ? "font-semibold text-fg" : "text-muted")} style={{ height: THUMB_LABEL - 4 }}>
                    {i + 1}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- S07 Signets */

interface Indexed {
  nodes: TreeNode[];
  actions: Map<string, LinkAction>;
  parents: string[];
}

function index(bookmarks: Bookmark[]): Indexed {
  const actions = new Map<string, LinkAction>();
  const parents: string[] = [];
  const walk = (list: Bookmark[], prefix: string): TreeNode[] =>
    list.map((b, i) => {
      const id = prefix ? `${prefix}.${i}` : String(i);
      actions.set(id, b.action);
      if (b.children.length) parents.push(id);
      return {
        id,
        label: b.title || t("(sans titre)"),
        page: b.action.kind === "goto" ? b.action.page + 1 : undefined,
        children: b.children.length ? walk(b.children, id) : undefined,
      };
    });
  return { nodes: walk(bookmarks, ""), actions, parents };
}

export function BookmarksPanel({
  engine,
  docId,
  cache,
  editable,
  currentDest,
  suggestedTitle,
  onChange,
  onLink,
  onClose,
}: {
  engine: EngineClient;
  docId: number;
  /** Signets déjà lus (le panneau peut être fermé et rouvert sans relire le document). */
  cache: { current: Bookmark[] | null };
  /** Modification permise (document non chiffré, commentaires autorisés). */
  editable: boolean;
  /** Destination d'un nouveau signet : la vue actuelle (page à partir de 0, haut en points). */
  currentDest: () => { page: number; top: number | null };
  /** Titre proposé : le texte sélectionné dans le document, s'il y en a un. */
  suggestedTitle: () => string;
  onChange: (list: Bookmark[]) => void;
  onLink: (a: LinkAction) => void;
  onClose: () => void;
}) {
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(cache.current);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string | number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  useEffect(() => {
    if (bookmarks) return;
    let alive = true;
    engine
      .bookmarks(docId)
      .then((b) => {
        cache.current = b;
        if (alive) setBookmarks(b);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [engine, docId, bookmarks, cache]);

  const idx = useMemo(() => (bookmarks ? index(bookmarks) : null), [bookmarks]);
  const allOpen = !!idx && idx.parents.length > 0 && idx.parents.every((p) => expanded.has(p));
  const current = bookmarks && selected !== null ? getAt(bookmarks, pathOf(selected)) : null;

  /** Applique une modification : arbre, sélection, parents dépliés pour la garder visible. */
  const commit = (next: Bookmark[], sel: Path | null) => {
    cache.current = next;
    setBookmarks(next);
    const id = sel ? idOf(sel) : null;
    setSelected(id);
    if (sel && sel.length > 1) {
      setExpanded((e) => {
        const n = new Set(e);
        for (let i = 1; i < sel.length; i++) n.add(idOf(sel.slice(0, i)));
        return n;
      });
    }
    onChange(next);
  };

  const add = () => {
    if (!bookmarks) return;
    const dest = currentDest();
    const title = suggestedTitle() || t("Page {page}", { page: dest.page + 1 });
    const [next, path] = insertAfter(bookmarks, selected === null ? null : pathOf(selected), { title, action: { kind: "goto", page: dest.page, top: dest.top }, children: [] });
    commit(next, path);
    setRenaming({ id: idOf(path), value: title });
  };
  const act = (f: (l: Bookmark[], p: Path) => [Bookmark[], Path]) => {
    if (!bookmarks || selected === null) return;
    const [next, path] = f(bookmarks, pathOf(selected));
    if (next !== bookmarks) commit(next, path);
  };
  const removeSelected = () => {
    if (!bookmarks || selected === null) return;
    commit(remove(bookmarks, pathOf(selected)), null);
  };
  const setDestHere = () => {
    if (!bookmarks || selected === null) return;
    const dest = currentDest();
    commit(update(bookmarks, pathOf(selected), { action: { kind: "goto", page: dest.page, top: dest.top } }), pathOf(selected));
  };
  const finishRename = () => {
    if (!renaming || !bookmarks) return;
    const v = renaming.value.trim();
    setRenaming(null);
    if (v && v !== getAt(bookmarks, pathOf(renaming.id))?.title) commit(update(bookmarks, pathOf(renaming.id), { title: v }), pathOf(renaming.id));
  };

  return (
    <section aria-label={t("Signets")} className="flex min-h-0 flex-1 flex-col" data-bookmarks-panel>
      <PanelHeader
        title={t("Signets")}
        actions={
          <>
            {editable && idx && <IconButton label={t("Ajouter un signet ici")} size="sm" icon={<BookmarkPlus size={16} />} onPress={add} />}
            {idx && idx.parents.length > 0 && (
              <IconButton
                label={allOpen ? t("Tout replier") : t("Tout déplier")}
                size="sm"
                icon={allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
                onPress={() => setExpanded(allOpen ? new Set() : new Set(idx.parents))}
              />
            )}
            <IconButton label={t("Fermer le panneau")} size="sm" icon={<X size={16} />} onPress={onClose} />
          </>
        }
      />
      {renaming && (
        <form
          className="border-b border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            finishRename();
          }}
        >
          <TextField
            label={t("Nom du signet")}
            size="sm"
            autoFocus
            value={renaming.value}
            maxLength={300}
            onChange={(value) => setRenaming({ ...renaming, value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(null);
              }
            }}
            onBlur={finishRename}
          />
        </form>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto p-1"
        onKeyDown={(e) => {
          if (!editable || renaming || selected === null) return;
          const stop = () => {
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopPropagation();
          };
          if (e.key === "F2") {
            stop();
            setRenaming({ id: selected, value: current?.title ?? "" });
          } else if (e.key === "Delete") {
            stop();
            removeSelected();
          } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            stop();
            act((l, p) => move(l, p, e.key === "ArrowUp" ? -1 : 1));
          } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
            stop();
            act(e.key === "ArrowRight" ? indent : outdent);
          }
        }}
      >
        {error ? (
          <p className="p-3 text-sm text-danger">{t("Les signets n'ont pas pu être lus.")}</p>
        ) : !idx ? (
          <div className="grid place-items-center p-6">
            <Spinner label={t("Lecture des signets")} />
          </div>
        ) : idx.nodes.length === 0 ? (
          <EmptyState icon={<BookmarkIcon size={24} />} title={t("Aucun signet")}>
            {editable ? (
              <Button size="sm" icon={<BookmarkPlus size={14} />} onPress={add}>
                {t("Ajouter un signet ici")}
              </Button>
            ) : (
              t("Ce document n'a pas de table des matières.")
            )}
          </EmptyState>
        ) : (
          <Tree
            aria-label={t("Signets du document")}
            nodes={idx.nodes}
            expandedKeys={expanded}
            onExpandedChange={setExpanded}
            selectionMode="single"
            selectedKeys={selected === null ? [] : [selected]}
            onSelectionChange={(keys) => {
              const k = [...(keys as Set<string | number>)][0];
              if (k === undefined) return;
              setSelected(String(k));
              const a = idx.actions.get(String(k));
              if (a) onLink(a);
            }}
            onAction={(key) => {
              // Clic ou Entrée : aller à la page, et sélectionner le signet pour le modifier.
              setSelected(String(key));
              const a = idx.actions.get(String(key));
              if (a) onLink(a);
            }}
          />
        )}
      </div>
      {editable && current && !renaming && (
        <Toolbar aria-label={t("Modifier le signet")} className="flex flex-wrap gap-0.5 border-t border-border p-1" data-bookmark-tools>
          <IconButton label={t("Renommer")} shortcut="F2" size="sm" icon={<Pencil size={16} />} onPress={() => setRenaming({ id: selected!, value: current.title })} />
          <IconButton label={t("Pointer vers la vue actuelle")} size="sm" icon={<LocateFixed size={16} />} onPress={setDestHere} />
          <IconButton label={t("Monter")} shortcut="Alt+↑" size="sm" icon={<ArrowUp size={16} />} onPress={() => act((l, p) => move(l, p, -1))} />
          <IconButton label={t("Descendre")} shortcut="Alt+↓" size="sm" icon={<ArrowDown size={16} />} onPress={() => act((l, p) => move(l, p, 1))} />
          <IconButton label={t("Mettre sous le signet précédent")} shortcut="Alt+→" size="sm" icon={<IndentIncrease size={16} />} onPress={() => act(indent)} />
          <IconButton label={t("Remonter d'un niveau")} shortcut="Alt+←" size="sm" icon={<IndentDecrease size={16} />} onPress={() => act(outdent)} />
          <IconButton label={t("Supprimer le signet")} shortcut="Suppr" size="sm" icon={<Trash2 size={16} />} onPress={removeSelected} />
        </Toolbar>
      )}
      {!editable && idx && idx.nodes.length > 0 && <p className="border-t border-border p-2 text-xs text-muted">{t("Document protégé : ses signets ne peuvent pas être modifiés.")}</p>}
    </section>
  );
}

/* ---------------------------------------------------------------- S09 Pièces jointes */

export function AttachmentsPanel({
  engine,
  docId,
  onOpenPdf,
  onSave,
  onClose,
}: {
  engine: EngineClient;
  docId: number;
  /** Ouvre une pièce jointe PDF dans un nouvel onglet. */
  onOpenPdf: (a: Attachment) => void;
  onSave: (a: Attachment) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<Attachment[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    engine
      .attachments(docId)
      .then((l) => alive && setList(l))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [engine, docId]);

  return (
    <section aria-label={t("Pièces jointes")} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={t("Pièces jointes")} actions={<IconButton label={t("Fermer le panneau")} size="sm" icon={<X size={16} />} onPress={onClose} />} />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <p className="p-3 text-sm text-danger">{t("Les pièces jointes n'ont pas pu être lues.")}</p>
        ) : !list ? (
          <div className="grid place-items-center p-6">
            <Spinner label={t("Lecture des pièces jointes")} />
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Paperclip size={24} />} title={t("Aucune pièce jointe")} />
        ) : (
          <>
            <ul className="flex flex-col gap-1" aria-label={t("Pièces jointes du document")} data-attachments>
              {list.map((a) => {
                const isPdf = a.name.toLowerCase().endsWith(".pdf");
                return (
                  <li key={a.index} className="flex flex-col gap-1 rounded-md border border-border p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText size={16} aria-hidden className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate text-base" title={a.name}>
                        {a.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">{formatSize(a.size)}</span>
                    </div>
                    <div className="flex gap-1">
                      {isPdf && (
                        <Button size="sm" onPress={() => onOpenPdf(a)}>
                          {t("Ouvrir")}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon={<Download size={14} />} onPress={() => onSave(a)}>
                        {t("Enregistrer sous…")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">
              {t("Par sécurité, PDFReader n'ouvre que les pièces jointes PDF. Enregistrez les autres et ouvrez-les vous-même si vous faites confiance à leur auteur.")}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

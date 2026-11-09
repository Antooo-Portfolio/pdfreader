import { EmptyState, IconButton, PanelHeader, Spinner, Tree, type TreeNode } from "@pdfreader/ui";
import { clsx } from "clsx";
import { Bookmark as BookmarkIcon, ChevronsDownUp, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Bookmark, type EngineClient, type LinkAction, type Rotation, THUMB_WIDTH, thumbScale } from "./engine";
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
    <section aria-label="Vignettes des pages" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Vignettes" actions={<IconButton label="Fermer le panneau" size="sm" icon={<X size={16} />} onPress={onClose} />} />
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
        <ul className="relative" style={{ height: total }} aria-label={`${info.pageCount} pages`}>
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
                  aria-label={`Page ${i + 1}`}
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
        label: b.title || "(sans titre)",
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
  onLink,
  onClose,
}: {
  engine: EngineClient;
  docId: number;
  /** Signets déjà lus (le panneau peut être fermé et rouvert sans relire le document). */
  cache: { current: Bookmark[] | null };
  onLink: (a: LinkAction) => void;
  onClose: () => void;
}) {
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(cache.current);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string | number>>(new Set());

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

  return (
    <section aria-label="Signets" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Signets"
        actions={
          <>
            {idx && idx.parents.length > 0 && (
              <IconButton
                label={allOpen ? "Tout replier" : "Tout déplier"}
                size="sm"
                icon={allOpen ? <ChevronsDownUp size={16} /> : <ChevronsUpDown size={16} />}
                onPress={() => setExpanded(allOpen ? new Set() : new Set(idx.parents))}
              />
            )}
            <IconButton label="Fermer le panneau" size="sm" icon={<X size={16} />} onPress={onClose} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? (
          <p className="p-3 text-sm text-danger">Les signets n'ont pas pu être lus.</p>
        ) : !idx ? (
          <div className="grid place-items-center p-6">
            <Spinner label="Lecture des signets" />
          </div>
        ) : idx.nodes.length === 0 ? (
          <EmptyState icon={<BookmarkIcon size={24} />} title="Aucun signet">
            Ce document n'a pas de table des matières.
          </EmptyState>
        ) : (
          <Tree
            aria-label="Signets du document"
            nodes={idx.nodes}
            expandedKeys={expanded}
            onExpandedChange={setExpanded}
            onAction={(key) => {
              const a = idx.actions.get(String(key));
              if (a) onLink(a);
            }}
          />
        )}
      </div>
    </section>
  );
}

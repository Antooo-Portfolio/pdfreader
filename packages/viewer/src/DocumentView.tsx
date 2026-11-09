import {
  Banner,
  Button,
  Dialog,
  FindBar,
  IconButton,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
  PageNavigator,
  ToolButton,
  Toolbar,
  ToolbarSeparator,
  ToolGroup,
  useToast,
  ZoomControl,
} from "@pdfreader/ui";
import { clsx } from "clsx";
import { BookOpen, Bookmark as BookmarkIcon, FolderOpen, GalleryVertical, Highlighter, MousePointer2, RotateCcw, RotateCw, Save, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bookmark, Box, EngineClient, Layout, LinkAction, PageLink, PanelId, Rotation, TextWord, ViewState, ZoomMode } from "./engine";
import { PT_TO_CSS } from "./engine";
import { clampZoom, computeLayout, type DocLayout, fitZoom, groupRows, isContinuous, isSpread, PAGE_GAP, rotateBox, rowAt } from "./layout";
import { PageView } from "./PageView";
import { BookmarksPanel, ThumbnailsPanel } from "./Panels";
import type { OpenDoc } from "./state";

interface Props {
  engine: EngineClient;
  doc: OpenDoc;
  isActive: boolean;
  tool: "select" | "highlight";
  onToolChange: (t: "select" | "highlight") => void;
  onHighlightSelection: () => void;
  onSave: () => void;
  onOpen: () => void;
  /** Conteneur des pages (pour convertir la sélection en coordonnées PDF). */
  pagesRef: (el: HTMLDivElement | null) => void;
}

/** Point d'ancrage : garde la même portion du document sous les yeux quand le zoom, la rotation
 *  ou le mode d'affichage changent. */
interface Anchor {
  page: number;
  fy: number;
  vy: number;
  fx: number;
  vx: number;
}

interface SearchState {
  perPage: Map<number, Box[][]>;
  /** Tous les résultats dans l'ordre : [page, rang sur la page]. */
  flat: [number, number][];
  current: number;
  searching: boolean;
  pagesWithText: number;
}

const EMPTY_SEARCH: SearchState = { perPage: new Map(), flat: [], current: -1, searching: false, pagesWithText: -1 };
const SEARCH_BATCH = 10;
const LAYOUT_LABELS: Record<Layout, string> = {
  single: "Une page à la fois",
  continuous: "Défilement continu",
  double: "Deux pages à la fois",
  "continuous-double": "Deux pages en continu",
};

export function DocumentView({ engine, doc, isActive, tool, onToolChange, onHighlightSelection, onSave, onOpen, pagesRef }: Props) {
  const toast = useToast();
  const { info } = doc;
  const saved = info.viewState;
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<string, TextWord[][]>()).current;
  const linkCache = useRef(new Map<string, PageLink[]>()).current;
  const bookmarkCache = useRef<Bookmark[] | null>(null);

  // ------------------------------------------------------------ état de la vue
  const [zoomMode, setZoomMode] = useState<ZoomMode>(saved?.zoomMode ?? "fit-width");
  const [customZoom, setCustomZoom] = useState(saved?.zoom ?? 1);
  const [layoutMode, setLayoutMode] = useState<Layout>(saved?.layout ?? "continuous");
  const [cover, setCover] = useState(saved?.cover ?? false);
  const [rotation, setRotation] = useState<Rotation>(saved?.rotation ?? 0);
  const [panel, setPanel] = useState<PanelId | null>(saved?.panel ?? null);
  const [page, setPage] = useState(() => Math.min(info.pageCount, Math.max(1, saved?.page ?? 1)));
  const [rows, setRows] = useState<[number, number]>([0, 0]);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [restrictionsDismissed, setRestrictionsDismissed] = useState(false);
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const pendingScroll = useRef<(() => void) | null>(null);

  const zoom = useMemo(
    () => (zoomMode === "custom" || viewport.w === 0 ? clampZoom(customZoom) : fitZoom(zoomMode, info.pages, rotation, layoutMode, viewport.w, viewport.h)),
    [zoomMode, customZoom, info.pages, rotation, layoutMode, viewport.w, viewport.h],
  );
  const continuous = isContinuous(layoutMode);
  // Rangée de chaque page (indépendante du zoom).
  const spreadRows = useMemo(() => {
    const out: number[] = [];
    groupRows(info.pageCount, layoutMode, cover).forEach((g, r) => g.forEach((p) => (out[p] = r)));
    return out;
  }, [info.pageCount, layoutMode, cover]);
  const currentRow = spreadRows[page - 1] ?? 0;
  const L: DocLayout = useMemo(
    () => computeLayout(info.pages, zoom, rotation, layoutMode, cover, viewport.w, currentRow),
    [info.pages, zoom, rotation, layoutMode, cover, viewport.w, currentRow],
  );
  const LRef = useRef(L);
  LRef.current = L;
  const pageRef = useRef(page);
  pageRef.current = page;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // ------------------------------------------------------------ mesures
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0) return;
      // En mode ajusté, le zoom suit la taille de la fenêtre : on garde le même endroit en vue.
      if (viewportRef.current.w > 0) captureAnchorRef.current();
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const m = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [dpr]);

  /** Ancre au point (vx, vy) de la zone visible (par défaut : le haut, au centre). */
  const captureAnchor = useCallback((vx?: number, vy?: number) => {
    const el = scroller.current;
    const lay = LRef.current;
    if (!el || lay.rows.length === 0) return;
    const x = vx ?? el.clientWidth / 2;
    const y = vy ?? 0;
    const cy = el.scrollTop + y;
    const row = lay.rows[rowAt(lay.rows, cy)];
    const p = row?.pages[0] ?? 0;
    const b = lay.boxes[p];
    if (!b) return;
    anchor.current = { page: p, fy: (cy - b.top) / Math.max(1, b.height), vy: y, fx: (el.scrollLeft + x) / Math.max(1, lay.width), vx: x };
  }, []);
  const captureAnchorRef = useRef(() => captureAnchor());
  captureAnchorRef.current = () => {
    if (isContinuous(layoutMode)) captureAnchor();
  };

  // Après un changement de zoom, de rotation ou de mode : on remet l'ancre en place.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pendingScroll.current) {
      const f = pendingScroll.current;
      pendingScroll.current = null;
      f();
      return;
    }
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const b = L.boxes[a.page];
    if (b) el.scrollTop = b.top + a.fy * b.height - a.vy;
    el.scrollLeft = a.fx * L.width - a.vx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L]);

  // ------------------------------------------------------------ défilement
  const onScroll = useCallback(() => {
    const el = scroller.current;
    const lay = LRef.current;
    // Tant que la zone n'est pas mesurée, la mise en page est provisoire : ne rien en déduire.
    if (!el || lay.rows.length === 0 || viewportRef.current.w === 0) return;
    if (!isContinuous(layoutMode)) return;
    const top = el.scrollTop;
    const h = el.clientHeight;
    const cur = rowAt(lay.rows, top + h / 3);
    const first = rowAt(lay.rows, Math.max(0, top - h));
    const last = rowAt(lay.rows, top + h * 2);
    const p = (lay.rows[cur]?.pages[0] ?? 0) + 1;
    setPage((old) => (old === p ? old : p));
    setRows((old) => (old[0] === first && old[1] === last ? old : [first, last]));
  }, [layoutMode]);

  useEffect(() => {
    onScroll();
  }, [onScroll, L]);

  /** Fait défiler jusqu'à une page (à partir de 1), éventuellement à une ordonnée en points
   *  depuis le haut de la page non tournée. */
  const goTo = useCallback(
    (p: number, topPt?: number | null) => {
      const target = Math.min(info.pageCount, Math.max(1, Math.round(p)));
      const scrollThere = () => {
        const el = scroller.current;
        const lay = LRef.current;
        const b = lay.boxes[target - 1];
        if (!el || !b) return;
        let y = b.top - PAGE_GAP / 2;
        if (topPt != null) {
          const size = info.pages[target - 1] ?? [0, 0];
          const [, ry] = rotateBox([0, topPt, 0, 0], size[0], size[1], rotation);
          y = b.top + ry * PT_TO_CSS * zoom - PAGE_GAP / 2;
        }
        el.scrollTop = y;
      };
      const sameRow = spreadRows[target - 1] === spreadRows[pageRef.current - 1];
      setPage(target);
      if (isContinuous(layoutMode) || sameRow) scrollThere();
      else pendingScroll.current = scrollThere;
    },
    [info.pageCount, info.pages, layoutMode, rotation, zoom, spreadRows],
  );

  // Restaurer la dernière page vue, une fois la zone mesurée.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || viewport.w === 0) return;
    restored.current = true;
    const p = saved?.page ?? 1;
    if (p > 1) goTo(p);
  }, [viewport.w, saved, goTo]);

  const stepRow = useCallback(
    (dir: 1 | -1, atEnd = false) => {
      const lay = LRef.current;
      const r = Math.min(lay.rows.length - 1, Math.max(0, (spreadRows[page - 1] ?? 0) + dir));
      const first = lay.rows[r]?.pages[0];
      if (first === undefined) return;
      if (isContinuous(layoutMode)) return goTo(first + 1);
      if (first + 1 === pageRef.current) return;
      setPage(first + 1);
      pendingScroll.current = () => {
        const el = scroller.current;
        if (el) el.scrollTop = atEnd ? el.scrollHeight : 0;
      };
    },
    [spreadRows, page, layoutMode, goTo],
  );

  // ------------------------------------------------------------ zoom, rotation, mode
  const zoomTo = useCallback(
    (z: number, at?: { x: number; y: number }) => {
      captureAnchor(at?.x, at?.y ?? (scroller.current ? scroller.current.clientHeight / 2 : 0));
      setCustomZoom(clampZoom(z));
      setZoomMode("custom");
    },
    [captureAnchor],
  );
  const fit = useCallback(
    (mode: "fit-page" | "fit-width") => {
      captureAnchor();
      setZoomMode(mode);
    },
    [captureAnchor],
  );
  const rotate = useCallback(
    (dir: 1 | -1) => {
      captureAnchor();
      setRotation((r) => (((r + dir * 90 + 360) % 360) as Rotation));
    },
    [captureAnchor],
  );
  const changeLayout = useCallback((l: Layout) => {
    anchor.current = null;
    setLayoutMode(l);
    // Après le changement : la page courante en haut de la vue.
    pendingScroll.current = () => {
      const el = scroller.current;
      const b = LRef.current.boxes[pageRef.current - 1];
      if (el && b) el.scrollTop = isContinuous(l) ? b.top - PAGE_GAP / 2 : 0;
    };
  }, []);

  // ------------------------------------------------------------ mémoriser la vue
  const viewState: ViewState = useMemo(
    () => ({ page, zoomMode, zoom: zoomMode === "custom" ? customZoom : null, layout: layoutMode, cover, rotation, panel }),
    [page, zoomMode, customZoom, layoutMode, cover, rotation, panel],
  );
  const latestView = useRef({ fp: info.fingerprint, vs: viewState });
  latestView.current = { fp: info.fingerprint, vs: viewState };
  useEffect(() => {
    const t = setTimeout(() => void engine.setViewState(info.fingerprint, viewState).catch(() => undefined), 600);
    return () => clearTimeout(t);
  }, [engine, info.fingerprint, viewState]);
  useEffect(
    () => () => {
      const { fp, vs } = latestView.current;
      void engine.setViewState(fp, vs).catch(() => undefined);
    },
    [engine],
  );

  // ------------------------------------------------------------ recherche (S05)
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const searchRef = useRef(search);
  searchRef.current = search;

  const showHit = useCallback(
    (s: SearchState, i: number) => {
      const hit = s.flat[i];
      if (!hit) return;
      const [p, j] = hit;
      const boxes = s.perPage.get(p)?.[j];
      const first = boxes?.[0];
      if (!first) return;
      const scrollThere = () => {
        const el = scroller.current;
        const lay = LRef.current;
        const b = lay.boxes[p];
        if (!el || !b) return;
        const size = info.pages[p] ?? [0, 0];
        const k = PT_TO_CSS * zoom;
        const [x, y, w, h] = rotateBox(first, size[0], size[1], rotation);
        const top = b.top + y * k;
        const left = b.left + x * k;
        if (top < el.scrollTop + 40 || top + h * k > el.scrollTop + el.clientHeight - 40) el.scrollTop = top - el.clientHeight / 3;
        if (left < el.scrollLeft || left + w * k > el.scrollLeft + el.clientWidth) el.scrollLeft = left - el.clientWidth / 3;
      };
      if (isContinuous(layoutMode)) {
        scrollThere();
      } else {
        setPage(p + 1);
        pendingScroll.current = scrollThere;
      }
    },
    [info.pages, zoom, rotation, layoutMode],
  );

  useEffect(() => {
    setSearch(EMPTY_SEARCH);
    const q = query.trim();
    if (!findOpen || !q) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const startPage = pageRef.current - 1;
      let perPage = new Map<number, Box[][]>();
      let flat: [number, number][] = [];
      let current = -1;
      let withText = 0;
      setSearch({ ...EMPTY_SEARCH, searching: true });
      try {
        for (let from = 0; from < info.pageCount; from += SEARCH_BATCH) {
          const r = await engine.search(info.id, from, SEARCH_BATCH, q, matchCase, wholeWord);
          if (cancelled) return;
          withText += r.pagesWithText;
          if (r.pages.length) {
            perPage = new Map(perPage);
            flat = [...flat];
            for (const pg of r.pages) {
              perPage.set(pg.page, pg.hits);
              pg.hits.forEach((_, j) => flat.push([pg.page, j]));
            }
          }
          let jump = false;
          if (current < 0) {
            const i = flat.findIndex(([p]) => p >= startPage);
            if (i >= 0) {
              current = i;
              jump = true;
            }
          }
          const s: SearchState = { perPage, flat, current, searching: from + SEARCH_BATCH < info.pageCount, pagesWithText: withText };
          if (current < 0 && !s.searching && flat.length) {
            s.current = current = 0;
            jump = true;
          }
          setSearch(s);
          if (jump) showHit(s, current);
        }
      } catch (e) {
        if (!cancelled) {
          setSearch((s) => ({ ...s, searching: false }));
          toast({ tone: "error", message: `La recherche a échoué : ${String(e)}` });
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // showHit dépend du zoom : relancer la recherche à chaque zoom serait inutile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeWord, findOpen, engine, info.id, info.generation, info.pageCount]);

  const stepHit = useCallback(
    (dir: 1 | -1) => {
      const s = searchRef.current;
      if (s.flat.length === 0) return;
      const current = (s.current + dir + s.flat.length) % s.flat.length;
      const next = { ...s, current };
      searchRef.current = next;
      setSearch(next);
      showHit(next, current);
    },
    [showHit],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    scroller.current?.focus();
  }, []);

  // ------------------------------------------------------------ liens
  const onLink = useCallback(
    (a: LinkAction) => {
      if (a.kind === "goto") goTo(a.page + 1, a.top);
      else if (a.kind === "uri") setConfirmUrl(a.uri);
    },
    [goTo],
  );

  // ------------------------------------------------------------ clavier
  const ctx = useRef({ zoom, zoomTo, fit, rotate, goTo, stepRow, page, continuous, openFind, findOpen, stepHit, closeFind });
  ctx.current = { zoom, zoomTo, fit, rotate, goTo, stepRow, page, continuous, openFind, findOpen, stepHit, closeFind };
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const c = ctx.current;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const inDoc = !t || t === document.body || !!scroller.current?.contains(t);
      const key = e.key;
      if (e.ctrlKey && !e.altKey) {
        const k = key.toLowerCase();
        let handled = true;
        if (e.shiftKey && key === "ArrowRight") c.rotate(1);
        else if (e.shiftKey && key === "ArrowLeft") c.rotate(-1);
        else if (key === "=" || key === "+") c.zoomTo(c.zoom * 1.25);
        else if (key === "-") c.zoomTo(c.zoom / 1.25);
        else if (key === "1") c.zoomTo(1);
        else if (key === "0") c.fit("fit-page");
        else if (key === "2") c.fit("fit-width");
        else if (k === "f") c.openFind();
        else if (key === "PageDown") c.goTo(c.page + 1);
        else if (key === "PageUp") c.goTo(c.page - 1);
        else if (key === "Home" && !typing) c.goTo(1);
        else if (key === "End" && !typing) c.goTo(Number.MAX_SAFE_INTEGER);
        else handled = false;
        if (handled) e.preventDefault();
        return;
      }
      if (key === "F3") {
        e.preventDefault();
        if (!c.findOpen) c.openFind();
        else c.stepHit(e.shiftKey ? -1 : 1);
        return;
      }
      if (key === "Escape" && c.findOpen && (typing || inDoc)) {
        c.closeFind();
        return;
      }
      if (typing || !inDoc || e.altKey || e.metaKey) return;
      const el = scroller.current;
      if (!el) return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 1;
      const noHScroll = el.scrollWidth <= el.clientWidth + 1;
      if (key === "Home") {
        e.preventDefault();
        c.goTo(1);
      } else if (key === "End") {
        e.preventDefault();
        c.goTo(Number.MAX_SAFE_INTEGER);
      } else if (noHScroll && key === "ArrowRight") {
        e.preventDefault();
        c.stepRow(1);
      } else if (noHScroll && key === "ArrowLeft") {
        e.preventDefault();
        c.stepRow(-1);
      } else if (!c.continuous && (key === "PageDown" || key === " ") && atBottom && !e.shiftKey) {
        e.preventDefault();
        c.stepRow(1);
      } else if (!c.continuous && (key === "PageUp" || (key === " " && e.shiftKey)) && atTop) {
        e.preventDefault();
        c.stepRow(-1, true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current;
    if (!el) return;
    if (e.ctrlKey) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
      return;
    }
    if (!continuous) {
      if (e.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) stepRow(1);
      else if (e.deltaY < 0 && el.scrollTop <= 1) stepRow(-1, true);
    }
  };

  // Ctrl+molette : le zoom du navigateur ne doit jamais s'appliquer (écouteur non passif).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const block = (e: WheelEvent) => e.ctrlKey && e.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, []);

  // ------------------------------------------------------------ rendu
  const perms = info.permissions;
  const canAnnotate = perms.annotate;
  const restricted = !perms.copy || !perms.annotate || !perms.print;
  const restrictions = [!perms.copy && "copie du texte", !perms.annotate && "commentaires", !perms.print && "impression"].filter(Boolean).join(", ");
  const currentHit = search.flat[search.current];
  const shownRows = continuous ? rows : [currentRow, currentRow];
  const visiblePages: number[] = [];
  for (let r = shownRows[0] ?? 0; r <= (shownRows[1] ?? -1); r++) for (const p of L.rows[r]?.pages ?? []) visiblePages.push(p);
  const notice = !search.searching && search.flat.length === 0 && search.pagesWithText === 0 ? "Aucun texte dans ce document (numérisé ?)" : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" hidden={!isActive}>
      <Toolbar aria-label="Barre d'outils du document" className="h-(--layout-toolbar) shrink-0 border-b border-border bg-bg px-2">
        <IconButton label="Ouvrir un fichier" shortcut="Ctrl+O" icon={<FolderOpen size={18} />} onPress={onOpen} />
        <IconButton label="Enregistrer" shortcut="Ctrl+S" icon={<Save size={18} />} onPress={onSave} isDisabled={!doc.dirty} />
        <ToolbarSeparator />
        <ToolGroup
          aria-label="Outils"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([canAnnotate ? tool : "select"])}
          onSelectionChange={(keys) => {
            const k = [...keys][0];
            if (k === "select" || k === "highlight") onToolChange(k);
          }}
        >
          <ToolButton id="select" label="Sélectionner du texte" shortcut="V" icon={<MousePointer2 size={18} />} />
          <ToolButton id="highlight" label={canAnnotate ? "Surligner (sélectionnez du texte)" : "Surligner : désactivé par l'auteur"} shortcut="U" icon={<Highlighter size={18} />} isDisabled={!canAnnotate} />
        </ToolGroup>
        <Button size="sm" variant="ghost" icon={<Highlighter size={16} />} onPress={onHighlightSelection} className="ml-1 max-lg:hidden" isDisabled={!canAnnotate}>
          Surligner la sélection
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Rechercher" shortcut="Ctrl+F" icon={<Search size={18} />} onPress={openFind} />
          <ToolbarSeparator />
          <PageNavigator page={page} total={info.pageCount} onChange={(p) => goTo(p)} />
          <ToolbarSeparator />
          <ZoomControl value={Math.round(zoom * 100)} onChange={(v) => zoomTo(v / 100)} onFit={fit} fit={zoomMode === "custom" ? null : zoomMode} />
          <MenuTrigger>
            <IconButton label="Affichage des pages" icon={<BookOpen size={18} />} />
            <Menu aria-label="Affichage des pages">
              <MenuSection
                title="Mode d'affichage"
                selectionMode="single"
                selectedKeys={[layoutMode]}
                onSelectionChange={(keys) => {
                  const k = [...(keys as Set<string>)][0] as Layout | undefined;
                  if (k) changeLayout(k);
                }}
              >
                {(Object.keys(LAYOUT_LABELS) as Layout[]).map((l) => (
                  <MenuItem key={l} id={l}>
                    {LAYOUT_LABELS[l]}
                  </MenuItem>
                ))}
              </MenuSection>
              <MenuSection
                selectionMode="multiple"
                selectedKeys={cover ? ["cover"] : []}
                onSelectionChange={(keys) => {
                  captureAnchor();
                  setCover((keys as Set<string>).has("cover"));
                }}
              >
                <MenuItem id="cover" isDisabled={!isSpread(layoutMode)}>
                  Première page seule (couverture)
                </MenuItem>
              </MenuSection>
              <MenuSeparator />
              <MenuSection>
                <MenuItem id="rot-r" icon={<RotateCw size={16} />} shortcut="Ctrl+Maj+→" onAction={() => rotate(1)}>
                  Pivoter à droite
                </MenuItem>
                <MenuItem id="rot-l" icon={<RotateCcw size={16} />} shortcut="Ctrl+Maj+←" onAction={() => rotate(-1)}>
                  Pivoter à gauche
                </MenuItem>
              </MenuSection>
            </Menu>
          </MenuTrigger>
        </div>
      </Toolbar>

      {info.isXfa && (
        <Banner tone="warning">Ce document utilise des formulaires XFA, qui ne sont pas pris en charge : certaines pages peuvent s'afficher incomplètes.</Banner>
      )}
      {restricted && !restrictionsDismissed && (
        <Banner tone="info" onDismiss={() => setRestrictionsDismissed(true)}>
          L'auteur de ce document a désactivé : {restrictions}.
        </Banner>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {findOpen && (
            <div className="absolute top-2 right-4 z-(--z-toolbar)">
              <FindBar
                inputRef={findInput}
                query={query}
                onQueryChange={setQuery}
                index={search.current + 1}
                total={search.flat.length}
                searching={search.searching}
                notice={notice}
                matchCase={matchCase}
                onMatchCaseChange={setMatchCase}
                wholeWord={wholeWord}
                onWholeWordChange={setWholeWord}
                onNext={() => stepHit(1)}
                onPrevious={() => stepHit(-1)}
                onClose={closeFind}
              />
            </div>
          )}
          <div
            ref={(el) => {
              scroller.current = el;
              pagesRef(el);
            }}
            onScroll={onScroll}
            onWheel={onWheel}
            onCopy={(e) => {
              if (!perms.copy) {
                e.preventDefault();
                toast({ tone: "info", message: "L'auteur de ce document a désactivé la copie du texte." });
              }
            }}
            tabIndex={0}
            role="document"
            aria-label={`${info.name}, page ${page} sur ${info.pageCount}`}
            className={clsx("focus-ring-inset min-h-0 flex-1 overflow-auto bg-canvas [scrollbar-gutter:stable]", tool === "highlight" && canAnnotate && "cursor-text")}
            onMouseUp={() => {
              if (tool === "highlight" && canAnnotate) onHighlightSelection();
            }}
          >
            <div className="relative" style={{ width: L.width, height: L.height }}>
              {viewport.w > 0 &&
                visiblePages.map((i) => {
                  const box = L.boxes[i];
                  if (!box) return null;
                  return (
                    <PageView
                      key={i}
                      engine={engine}
                      docId={info.id}
                      generation={info.generation}
                      version={doc.pageVersions[i] ?? 0}
                      index={i}
                      size={info.pages[i] ?? [612, 792]}
                      box={box}
                      zoom={zoom}
                      dpr={dpr}
                      rotation={rotation}
                      active={isActive}
                      textCache={textCache}
                      linkCache={linkCache}
                      hits={search.perPage.get(i)}
                      currentHit={currentHit && currentHit[0] === i ? currentHit[1] : -1}
                      onLink={onLink}
                    />
                  );
                })}
            </div>
          </div>
        </div>

        {panel && (
          <aside className="flex w-(--layout-sidepanel) shrink-0 flex-col border-l border-border bg-surface">
            {panel === "thumbnails" ? (
              <ThumbnailsPanel engine={engine} doc={doc} rotation={rotation} page={page} dpr={dpr} onGoTo={(p) => goTo(p)} onClose={() => setPanel(null)} />
            ) : (
              <BookmarksPanel engine={engine} docId={info.id} cache={bookmarkCache} onLink={onLink} onClose={() => setPanel(null)} />
            )}
          </aside>
        )}
        <Toolbar aria-label="Panneaux" orientation="vertical" className="flex w-(--layout-panel-rail) shrink-0 flex-col items-center gap-1 border-l border-border bg-bg py-2">
          <ToolButton
            label="Vignettes"
            icon={<GalleryVertical size={18} />}
            isSelected={panel === "thumbnails"}
            onChange={(on) => setPanel(on ? "thumbnails" : null)}
          />
          <ToolButton label="Signets" icon={<BookmarkIcon size={18} />} isSelected={panel === "bookmarks"} onChange={(on) => setPanel(on ? "bookmarks" : null)} />
        </Toolbar>
      </div>

      {confirmUrl && (
        <Dialog
          title="Ouvrir ce lien ?"
          size="sm"
          isOpen
          onOpenChange={(o) => !o && setConfirmUrl(null)}
          footer={(close) => (
            <>
              <Button onPress={close}>Annuler</Button>
              <Button
                variant="primary"
                autoFocus
                onPress={() => {
                  const url = confirmUrl;
                  close();
                  engine.openUrl(url).catch(() => toast({ tone: "error", message: "Ce lien n'a pas pu être ouvert." }));
                }}
              >
                Ouvrir
              </Button>
            </>
          )}
        >
          <div className="flex flex-col gap-2">
            <p className="text-base">
              {confirmUrl.toLowerCase().startsWith("mailto:") ? "Le document propose d'écrire un e-mail avec votre messagerie :" : "Le document propose d'ouvrir cette adresse dans votre navigateur :"}
            </p>
            <p className="rounded-md bg-surface px-2 py-1.5 font-mono text-sm break-all">{confirmUrl}</p>
            {!/^(https?:|mailto:)/i.test(confirmUrl) && <p className="text-sm text-danger">Ce type d'adresse n'est pas autorisé et ne sera pas ouvert.</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

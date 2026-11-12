import {
  Banner,
  Button,
  Dialog,
  FindBar,
  isModalOpen,
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
import {
  Check,
  BookOpen,
  Bookmark as BookmarkIcon,
  Eraser,
  FolderOpen,
  GalleryVertical,
  Highlighter,
  Printer,
  MessageSquare,
  MousePointer2,
  PenLine,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Signature as SignatureIcon,
  StickyNote,
  Type,
  X as XIcon,
  Strikethrough,
  Underline,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_STYLES, hitTest, isMarkupTool, KIND_LABELS, type Tool, type ToolStyle, type ToolStyles, toHex } from "./annot";
import { PropertyBar } from "./AnnotTools";
import { CommentsPanel } from "./CommentsPanel";
import { SignatureDialog } from "./FillTools";
import type { Annot, AnnotPatch, AnnotResult, Field, FieldInput, SavedSignature, SignatureKind, Bookmark, Box, EngineClient, Layout, LinkAction, MarkupKind, PageLink, PanelId, Rotation, TextWord, ViewState, ZoomMode } from "./engine";
import { PT_TO_CSS } from "./engine";
import { clampZoom, computeLayout, type DocLayout, fitZoom, groupRows, isContinuous, isSpread, PAGE_GAP, rotateBox, rowAt, unrotatePoint } from "./layout";
import { PageView } from "./PageView";
import { BookmarksPanel, ThumbnailsPanel } from "./Panels";
import { selectionToPageRects } from "./selection";
import type { OpenDoc } from "./state";

interface Props {
  engine: EngineClient;
  doc: OpenDoc;
  isActive: boolean;
  tool: Tool;
  onToolChange: (t: Tool) => void;
  styles: ToolStyles;
  onStyleChange: (kind: keyof ToolStyles, patch: Partial<ToolStyle>) => void;
  author: string;
  onAuthorChange: (name: string) => void;
  /** Une page a été modifiée (document à enregistrer, tuiles à recharger). */
  onAnnotated: (page: number) => void;
  onSave: () => void;
  onOpen: () => void;
  onPrint: () => void;
  /** Actions exposées au scénario de bout en bout. */
  register?: (actions: DocActions | null) => void;
  /** Vue à l'ouverture (préférences), et faut-il reprendre la dernière vue du document. */
  defaults: { zoom: "fit-width" | "fit-page" | "actual"; layout: Layout; restoreView: boolean };
  /** Le fichier a été modifié par un autre programme. */
  externalChange: boolean;
  onReload: () => void;
  onSaveAs: () => void;
}

export interface DocActions {
  /** Page courante, à partir de 1. */
  currentPage: () => number;
  markupSelection: (kind: MarkupKind) => Promise<number>;
  fields: (page: number) => Promise<Field[]>;
  setField: (page: number, index: number, input: FieldInput) => Promise<Field[] | null>;
  addText: (page: number, x: number, y: number, text: string) => Promise<string | null>;
  addMark: (page: number, x: number, y: number) => Promise<string | null>;
  saveSignature: (kind: SignatureKind, data: string) => Promise<void>;
  placeSignature: (page: number, x: number, y: number, kind: SignatureKind) => Promise<string | null>;
  createNote: (page: number, x: number, y: number, text: string) => Promise<string | null>;
  createInk: (page: number, strokes: [number, number][][]) => Promise<string | null>;
  updateAnnot: (page: number, id: string, patch: AnnotPatch) => Promise<boolean>;
  deleteAnnot: (page: number, id: string) => Promise<boolean>;
  annots: (page: number) => Promise<Annot[]>;
  openPanel: (p: PanelId | null) => void;
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

const TOOL_LABELS: Record<Exclude<Tool, "select" | "eraser">, string> = {
  highlight: "Surligner",
  underline: "Souligner",
  strikeout: "Barrer",
  note: "Note",
  ink: "Dessin",
  text: "Texte",
  check: "Coche",
  sign: "Signer",
};
const STAMP_KINDS = new Set(["text", "mark", "signature", "stamp"]);

export function DocumentView({
  engine,
  doc,
  isActive,
  tool,
  onToolChange,
  styles,
  onStyleChange,
  author,
  onAuthorChange,
  onAnnotated,
  onSave,
  onOpen,
  onPrint,
  register,
  defaults,
  externalChange,
  onReload,
  onSaveAs,
}: Props) {
  const toast = useToast();
  const { info } = doc;
  // Dernière vue du document, sauf si l'utilisateur préfère toujours la vue par défaut.
  const saved = defaults.restoreView ? info.viewState : null;
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const textCache = useRef(new Map<string, TextWord[][]>()).current;
  const linkCache = useRef(new Map<string, PageLink[]>()).current;
  const bookmarkCache = useRef<Bookmark[] | null>(null);

  // ------------------------------------------------------------ état de la vue
  const [zoomMode, setZoomMode] = useState<ZoomMode>(saved?.zoomMode ?? (defaults.zoom === "actual" ? "custom" : defaults.zoom));
  const [customZoom, setCustomZoom] = useState(saved?.zoom ?? 1);
  const [layoutMode, setLayoutMode] = useState<Layout>(saved?.layout ?? defaults.layout);
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

  // ------------------------------------------------------------ commentaires
  const perms = info.permissions;
  const canAnnotate = perms.annotate;
  const [annots, setAnnots] = useState<Map<number, Annot[]>>(() => new Map());
  const annotsRef = useRef(annots);
  annotsRef.current = annots;
  const loadingAnnots = useRef(new Map<number, Promise<Annot[]>>());
  const [selected, setSelected] = useState<{ page: number; id: string } | null>(null);
  const [editing, setEditing] = useState<{ page: number; id: string; isNew: boolean } | null>(null);
  const [pagesLoaded, setPagesLoaded] = useState(0);
  const stylesRef = useRef(styles);
  stylesRef.current = styles;

  // Après un enregistrement, le document est relu : les rangs « #n » peuvent changer.
  const firstGen = useRef(true);
  useEffect(() => {
    if (firstGen.current) {
      firstGen.current = false;
      return;
    }
    loadingAnnots.current.clear();
    setAnnots(new Map());
    setSelected(null);
    setEditing(null);
    setPagesLoaded(0);
  }, [info.generation]);

  const loadAnnots = useCallback(
    (p: number): Promise<Annot[]> => {
      const have = annotsRef.current.get(p);
      if (have) return Promise.resolve(have);
      const inflight = loadingAnnots.current.get(p);
      if (inflight) return inflight;
      const job = engine
        .annotations(info.id, p)
        .then((r) => r.annots)
        .catch(() => [] as Annot[])
        .then((list) => {
          loadingAnnots.current.delete(p);
          setAnnots((m) => (m.has(p) ? m : new Map(m).set(p, list)));
          return list;
        });
      loadingAnnots.current.set(p, job);
      return job;
    },
    [engine, info.id],
  );

  // Panneau Commentaires : lecture de toutes les pages, par lots, sans bloquer le rendu.
  useEffect(() => {
    if (panel !== "comments") return;
    let cancelled = false;
    (async () => {
      for (let p = 0; p < info.pageCount; p++) {
        if (cancelled) return;
        if (!annotsRef.current.has(p)) await loadAnnots(p);
        if (p % 20 === 19 || p === info.pageCount - 1) setPagesLoaded(p + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, info.pageCount, info.generation, loadAnnots]);

  const apply = useCallback(
    (p: number, r: AnnotResult) => {
      annotsRef.current = new Map(annotsRef.current).set(p, r.annots);
      setAnnots(annotsRef.current);
      onAnnotated(p);
    },
    [onAnnotated],
  );

  const attempt = useCallback(
    async <T,>(f: () => Promise<T>, what: string): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        toast({ tone: "error", message: `${what} (${String(e)})` });
        return null;
      }
    },
    [toast],
  );

  const markupSelection = useCallback(
    async (kind: MarkupKind): Promise<number> => {
      if (!canAnnotate || !scroller.current) return 0;
      const byPage = selectionToPageRects(scroller.current);
      if (byPage.size === 0) return 0;
      const st = stylesRef.current[kind];
      let n = 0;
      for (const [p, rects] of byPage) {
        const r = await attempt(() => engine.addMarkup(info.id, p, kind, rects, st.color, st.opacity), "Le commentaire n'a pas pu être ajouté");
        if (r) {
          apply(p, r);
          n++;
        }
      }
      window.getSelection()?.removeAllRanges();
      return n;
    },
    [canAnnotate, attempt, engine, info.id, apply],
  );

  const createNote = useCallback(
    async (p: number, x: number, y: number, text = ""): Promise<string | null> => {
      const r = await attempt(() => engine.addNote(info.id, p, x, y, text, stylesRef.current.note.color), "La note n'a pas pu être ajoutée");
      if (!r?.id) return null;
      apply(p, r);
      setSelected({ page: p, id: r.id });
      setEditing({ page: p, id: r.id, isNew: true });
      onToolChange("select");
      return r.id;
    },
    [attempt, engine, info.id, apply, onToolChange],
  );

  const createInk = useCallback(
    async (p: number, strokes: [number, number][][]): Promise<string | null> => {
      const st = stylesRef.current.ink;
      const r = await attempt(() => engine.addInk(info.id, p, strokes, st.color, st.opacity, st.width), "Le dessin n'a pas pu être ajouté");
      if (!r) return null;
      apply(p, r);
      return r.id;
    },
    [attempt, engine, info.id, apply],
  );

  const updateAnnot = useCallback(
    async (p: number, id: string, patch: AnnotPatch): Promise<boolean> => {
      const r = await attempt(() => engine.updateAnnot(info.id, p, id, patch), "La modification a échoué");
      if (r) apply(p, r);
      return !!r;
    },
    [attempt, engine, info.id, apply],
  );

  const deleteAnnot = useCallback(
    async (p: number, id: string): Promise<boolean> => {
      const r = await attempt(() => engine.deleteAnnot(info.id, p, id), "La suppression a échoué");
      if (!r) return false;
      apply(p, r);
      setSelected((s) => (s && s.page === p && s.id === id ? null : s));
      setEditing((s) => (s && s.page === p && s.id === id ? null : s));
      return true;
    },
    [attempt, engine, info.id, apply],
  );

  const saveNote = useCallback(
    async (p: number, id: string, text: string) => {
      if (await updateAnnot(p, id, { contents: text })) setEditing(null);
    },
    [updateAnnot],
  );

  // Réglages du commentaire sélectionné : appliqués après une courte pause (curseurs).
  const pendingPatch = useRef<{ page: number; id: string; patch: AnnotPatch; timer: number } | null>(null);
  const patchSelected = useCallback(
    (patch: Partial<ToolStyle>) => {
      if (!selected) return;
      const prev = pendingPatch.current && pendingPatch.current.id === selected.id ? pendingPatch.current : null;
      if (prev) window.clearTimeout(prev.timer);
      const merged: AnnotPatch = { ...(prev?.patch ?? {}), ...patch };
      const job = { page: selected.page, id: selected.id, patch: merged, timer: 0 };
      job.timer = window.setTimeout(() => {
        pendingPatch.current = null;
        void updateAnnot(job.page, job.id, job.patch);
      }, 220);
      pendingPatch.current = job;
      // Aperçu immédiat dans la barre de propriétés.
      setAnnots((m) => {
        const list = m.get(selected.page);
        if (!list) return m;
        return new Map(m).set(
          selected.page,
          list.map((a) => (a.id === selected.id ? { ...a, ...(patch.color ? { color: patch.color } : {}), ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}), ...(patch.width !== undefined ? { width: patch.width } : {}) } : a)),
        );
      });
    },
    [selected, updateAnnot],
  );

  /** Texte d'un commentaire. Pour un tampon « texte », le texte affiché change aussi : on le
   *  recrée au même endroit, à la même taille. */
  const saveComment = useCallback(
    async (a: Annot, text: string) => {
      if (a.kind !== "text") return void updateAnnot(a.page, a.id, { contents: text });
      if (!text.trim()) return void deleteAnnot(a.page, a.id);
      const st = stylesRef.current.text;
      const r = await attempt(() => engine.addText(info.id, a.page, a.rect[0] + 1, a.rect[1] + 1, text, a.fontSize ?? st.width, a.color ?? st.color), "Le texte n'a pas pu être modifié");
      if (r) {
        apply(a.page, r);
        await deleteAnnot(a.page, a.id);
      }
    },
    [updateAnnot, deleteAnnot, attempt, engine, info.id, apply],
  );

  const selectAnnot = useCallback(
    (a: Annot) => {
      setSelected({ page: a.page, id: a.id });
      setEditing(null);
      goTo(a.page + 1, Math.max(0, a.rect[1] - 48));
    },
    [goTo],
  );

  // Choisir un outil de création désélectionne le commentaire courant ; un outil de marquage
  // s'applique tout de suite au texte déjà sélectionné.
  useEffect(() => {
    if (tool !== "select") {
      setSelected(null);
      setEditing(null);
    }
    if (!isActive || !isMarkupTool(tool)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && scroller.current?.contains(sel.anchorNode)) void markupSelection(tool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // ------------------------------------------------------------ formulaires et signature (S11, S12)
  const canFill = perms.fillForms;
  const [fields, setFields] = useState<Map<number, Field[]>>(() => new Map());
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const loadingFields = useRef(new Map<number, Promise<Field[]>>());
  const [highlightFields, setHighlightFields] = useState(true);
  const [formBannerClosed, setFormBannerClosed] = useState(false);
  const [textDraft, setTextDraft] = useState<{ page: number; x: number; y: number } | null>(null);
  const [markCross, setMarkCross] = useState(false);
  const [sigKind, setSigKind] = useState<SignatureKind>("signature");
  const [sigs, setSigs] = useState<Partial<Record<SignatureKind, SavedSignature | null>>>({});
  const [sigDialog, setSigDialog] = useState<{ kind: SignatureKind; then?: (s: SavedSignature) => void } | null>(null);

  useEffect(() => {
    loadingFields.current.clear();
    setFields(new Map());
  }, [info.generation]);

  const loadFields = useCallback(
    (p: number): Promise<Field[]> => {
      if (!info.hasForm) return Promise.resolve([]);
      const have = fieldsRef.current.get(p);
      if (have) return Promise.resolve(have);
      const inflight = loadingFields.current.get(p);
      if (inflight) return inflight;
      const job = engine
        .fields(info.id, p)
        .catch(() => [] as Field[])
        .then((list) => {
          loadingFields.current.delete(p);
          setFields((m) => (m.has(p) ? m : new Map(m).set(p, list)));
          return list;
        });
      loadingFields.current.set(p, job);
      return job;
    },
    [engine, info.id, info.hasForm],
  );

  const setField = useCallback(
    async (p: number, index: number, input: FieldInput): Promise<Field[] | null> => {
      const r = await attempt(() => engine.setField(info.id, p, index, input), "La saisie n'a pas pu être enregistrée");
      if (!r) return null;
      fieldsRef.current = new Map(fieldsRef.current).set(p, r);
      setFields(fieldsRef.current);
      onAnnotated(p);
      return r;
    },
    [attempt, engine, info.id, onAnnotated],
  );

  const addText = useCallback(
    async (p: number, x: number, y: number, text: string): Promise<string | null> => {
      const st = stylesRef.current.text;
      const r = await attempt(() => engine.addText(info.id, p, x, y, text, st.width, st.color), "Le texte n'a pas pu être ajouté");
      if (!r) return null;
      apply(p, r);
      return r.id;
    },
    [attempt, engine, info.id, apply],
  );

  const markCrossRef = useRef(markCross);
  markCrossRef.current = markCross;
  const addMark = useCallback(
    async (p: number, x: number, y: number): Promise<string | null> => {
      const st = stylesRef.current.check;
      // La coche est centrée sur le clic.
      const r = await attempt(() => engine.addMark(info.id, p, Math.max(0, x - st.width / 2), Math.max(0, y - st.width / 2), st.width, markCrossRef.current, st.color), "La coche n'a pas pu être ajoutée");
      if (!r) return null;
      apply(p, r);
      return r.id;
    },
    [attempt, engine, info.id, apply],
  );

  const getSignature = useCallback(
    async (kind: SignatureKind): Promise<SavedSignature | null> => {
      if (sigs[kind] !== undefined) return sigs[kind] ?? null;
      const s = await engine.signature(kind).catch(() => null);
      setSigs((m) => ({ ...m, [kind]: s }));
      return s;
    },
    [engine, sigs],
  );
  useEffect(() => {
    if (tool === "sign") {
      void getSignature("signature");
      void getSignature("initials");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const saveSignature = useCallback(
    async (kind: SignatureKind, data: string, method: SavedSignature["method"] = "image", font: string | null = null) => {
      await engine.setSignature(kind, method, data, font);
      const s = await engine.signature(kind);
      setSigs((m) => ({ ...m, [kind]: s }));
    },
    [engine],
  );

  /** Taille de la signature posée : largeur fixe (signature 150 pt, initiales 60 pt), hauteur selon
   *  l'image ; ou ajustée à un champ de signature. */
  const signatureSize = async (s: SavedSignature, kind: SignatureKind, fit?: [number, number]): Promise<[number, number]> => {
    const img = new Image();
    img.src = s.data;
    await img.decode().catch(() => undefined);
    const ratio = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.35;
    if (fit) {
      const [fw, fh] = fit;
      const w = Math.min(fw, fh / ratio);
      return [w, w * ratio];
    }
    const w = kind === "initials" ? 60 : 150;
    return [w, w * ratio];
  };

  const placeSignature = useCallback(
    async (p: number, x: number, y: number, kind: SignatureKind, fit?: Field): Promise<string | null> => {
      const s = await getSignature(kind);
      if (!s) return null;
      const [w, h] = await signatureSize(s, kind, fit ? [fit.rect[2], fit.rect[3]] : undefined);
      const [pw, ph] = info.pages[p] ?? [612, 792];
      const rect: Box = fit
        ? [fit.rect[0] + (fit.rect[2] - w) / 2, fit.rect[1] + (fit.rect[3] - h) / 2, w, h]
        : [Math.min(Math.max(0, x - w / 2), pw - w), Math.min(Math.max(0, y - h / 2), ph - h), w, h];
      const r = await attempt(() => engine.addSignature(info.id, p, rect, kind), "La signature n'a pas pu être posée");
      if (!r) return null;
      apply(p, r);
      return r.id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getSignature, info.pages, attempt, engine, info.id, apply],
  );

  /** Signer : avec la signature mémorisée, ou après l'avoir créée. */
  const signAt = useCallback(
    async (p: number, x: number, y: number, kind: SignatureKind, fit?: Field) => {
      const s = await getSignature(kind);
      if (s) return void placeSignature(p, x, y, kind, fit);
      setSigDialog({ kind, then: () => void placeSignature(p, x, y, kind, fit) });
    },
    [getSignature, placeSignature],
  );

  const onPlace = useCallback(
    (p: number, t: Tool, x: number, y: number) => {
      if (t === "note") void createNote(p, Math.max(0, x - 10), Math.max(0, y - 10));
      else if (t === "text") setTextDraft({ page: p, x, y });
      else if (t === "check") void addMark(p, x, y);
      else if (t === "sign") void signAt(p, x, y, sigKind);
    },
    [createNote, addMark, signAt, sigKind],
  );

  /** Clic sur la page avec l'outil de sélection : sélectionne le commentaire sous le pointeur. */
  const onDocClick = (e: React.MouseEvent) => {
    if (tool !== "select" && !isMarkupTool(tool)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pageEl = (e.target as Element).closest<HTMLElement>("[data-page-index]");
    if (!pageEl) {
      setSelected(null);
      setEditing(null);
      return;
    }
    const p = Number(pageEl.dataset.pageIndex);
    const [pw, ph] = info.pages[p] ?? [612, 792];
    const r = pageEl.getBoundingClientRect();
    const sideways = rotation === 90 || rotation === 270;
    const W = sideways ? r.height : r.width;
    const H = sideways ? r.width : r.height;
    const [u, v] = unrotatePoint(e.clientX - r.left, e.clientY - r.top, W, H, rotation);
    const hit = hitTest(annotsRef.current.get(p) ?? [], (u / W) * pw, (v / H) * ph, 3 / (PT_TO_CSS * zoom));
    if (hit) {
      setSelected({ page: p, id: hit.id });
      setEditing(hit.kind === "note" ? { page: p, id: hit.id, isNew: false } : null);
    } else {
      setSelected(null);
      setEditing(null);
    }
  };

  useEffect(() => {
    register?.({
      currentPage: () => pageRef.current,
      fields: loadFields,
      setField,
      addText,
      addMark,
      saveSignature: (kind, data) => saveSignature(kind, data, "drawn"),
      placeSignature: (p, x, y, kind) => placeSignature(p, x, y, kind),
      markupSelection,
      createNote,
      createInk,
      updateAnnot,
      deleteAnnot,
      annots: (p) => {
        const known = annotsRef.current.get(p);
        return known ? Promise.resolve(known) : loadAnnots(p);
      },
      openPanel: setPanel,
    });
  }, [register, markupSelection, createNote, createInk, updateAnnot, deleteAnnot, loadAnnots, loadFields, setField, addText, addMark, saveSignature, placeSignature]);
  useEffect(() => () => register?.(null), [register]);

  // ------------------------------------------------------------ clavier
  const ctx = useRef({ zoom, zoomTo, fit, rotate, goTo, stepRow, page, continuous, openFind, findOpen, stepHit, closeFind, selected, deleteAnnot, tool, onToolChange });
  ctx.current = { zoom, zoomTo, fit, rotate, goTo, stepRow, page, continuous, openFind, findOpen, stepHit, closeFind, selected, deleteAnnot, tool, onToolChange };
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen()) return;
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
      if (typing || e.altKey || e.metaKey) return;
      if ((key === "Delete" || key === "Backspace") && c.selected) {
        e.preventDefault();
        void c.deleteAnnot(c.selected.page, c.selected.id);
        return;
      }
      if (key === "Escape") {
        if (c.selected) setSelected(null);
        else if (c.tool !== "select") c.onToolChange("select");
        return;
      }
      if (!inDoc) return;
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
  const restricted = !perms.copy || !perms.annotate || !perms.print;
  const restrictions = [!perms.copy && "copie du texte", !perms.annotate && "commentaires", !perms.print && "impression"].filter(Boolean).join(", ");
  const currentHit = search.flat[search.current];
  const shownRows = continuous ? rows : [currentRow, currentRow];
  const visiblePages: number[] = [];
  for (let r = shownRows[0] ?? 0; r <= (shownRows[1] ?? -1); r++) for (const p of L.rows[r]?.pages ?? []) visiblePages.push(p);
  const visibleKey = visiblePages.join(",");
  useEffect(() => {
    if (!isActive) return;
    for (const p of visibleKey.split(",")) if (p !== "") {
      void loadAnnots(Number(p));
      void loadFields(Number(p));
    }
  }, [visibleKey, isActive, loadAnnots, loadFields, annots, fields]);
  const selectedAnnot = selected ? annots.get(selected.page)?.find((a) => a.id === selected.id) : undefined;
  const styleTool = tool === "select" || tool === "eraser" ? null : tool;
  const sig = sigs[sigKind];
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
            if (typeof k === "string") onToolChange(k as Tool);
          }}
        >
          <ToolButton id="select" label="Sélectionner (texte et commentaires)" shortcut="V" icon={<MousePointer2 size={18} />} />
          <ToolButton id="highlight" label={canAnnotate ? "Surligner du texte" : "Commentaires désactivés par l'auteur"} shortcut="U" icon={<Highlighter size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="underline" label="Souligner du texte" icon={<Underline size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="strikeout" label="Barrer du texte" icon={<Strikethrough size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="note" label="Ajouter une note (cliquez sur la page)" shortcut="N" icon={<StickyNote size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="ink" label="Dessiner à main levée" shortcut="D" icon={<PenLine size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="eraser" label="Gomme (efface les dessins)" shortcut="E" icon={<Eraser size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="text" label="Ajouter du texte (cliquez sur la page)" shortcut="T" icon={<Type size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="check" label="Ajouter une coche ou une croix" icon={<Check size={18} />} isDisabled={!canAnnotate} />
          <ToolButton id="sign" label="Signer (cliquez sur la page)" shortcut="S" icon={<SignatureIcon size={18} />} isDisabled={!canAnnotate} />
        </ToolGroup>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Imprimer" shortcut="Ctrl+P" icon={<Printer size={18} />} onPress={onPrint} />
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

      {canAnnotate && selectedAnnot && !selectedAnnot.locked ? (
        <PropertyBar
          title={`Sélection : ${KIND_LABELS[selectedAnnot.kind]}`}
          style={{ color: selectedAnnot.color ?? DEFAULT_STYLES.highlight.color, opacity: selectedAnnot.opacity, width: selectedAnnot.width }}
          showColor={!STAMP_KINDS.has(selectedAnnot.kind)}
          showOpacity={!STAMP_KINDS.has(selectedAnnot.kind) && selectedAnnot.kind !== "note"}
          showWidth={selectedAnnot.kind === "ink"}
          onChange={patchSelected}
          onDelete={() => void deleteAnnot(selectedAnnot.page, selectedAnnot.id)}
        />
      ) : (
        canAnnotate &&
        styleTool &&
        (styleTool === "sign" ? (
          <PropertyBar
            title="Signer"
            style={styles.text}
            showColor={false}
            showOpacity={false}
            showWidth={false}
            onChange={() => undefined}
            extra={
              <div className="flex items-center gap-3">
                <ToolGroup
                  aria-label="Que poser"
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([sigKind])}
                  onSelectionChange={(k) => {
                    const v = [...k][0];
                    if (v === "signature" || v === "initials") setSigKind(v);
                  }}
                >
                  <ToolButton id="signature" label="Signature" icon={<SignatureIcon size={16} />} size="sm" />
                  <ToolButton id="initials" label="Initiales" icon={<Type size={16} />} size="sm" />
                </ToolGroup>
                {sig ? (
                  <img src={sig.data} alt={sigKind === "initials" ? "Vos initiales" : "Votre signature"} className="h-7 max-w-40 rounded-sm bg-page object-contain px-1" />
                ) : (
                  <span className="text-sm text-muted">{sigKind === "initials" ? "Aucunes initiales enregistrées" : "Aucune signature enregistrée"}</span>
                )}
                <Button size="sm" onPress={() => setSigDialog({ kind: sigKind })}>
                  {sig ? "Modifier" : "Créer"}
                </Button>
                {sig && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={async () => {
                      await engine.deleteSignature(sigKind).catch(() => undefined);
                      setSigs((m) => ({ ...m, [sigKind]: null }));
                    }}
                  >
                    Oublier
                  </Button>
                )}
                <span className="text-sm text-muted">Cliquez sur la page pour la poser.</span>
              </div>
            }
          />
        ) : (
          <PropertyBar
            title={TOOL_LABELS[styleTool]}
            style={styles[styleTool]}
            showOpacity={styleTool !== "note" && styleTool !== "text" && styleTool !== "check"}
            showWidth={styleTool === "ink" || styleTool === "text" || styleTool === "check"}
            widthLabel={styleTool === "ink" ? "Épaisseur" : "Taille"}
            widthRange={styleTool === "ink" ? [0.5, 12, 0.5] : [6, 48, 1]}
            onChange={(patch) => onStyleChange(styleTool, patch)}
            extra={
              styleTool === "check" ? (
                <ToolGroup
                  aria-label="Forme"
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([markCross ? "cross" : "check"])}
                  onSelectionChange={(k) => setMarkCross([...k][0] === "cross")}
                >
                  <ToolButton id="check" label="Coche" icon={<Check size={16} />} size="sm" />
                  <ToolButton id="cross" label="Croix" icon={<XIcon size={16} />} size="sm" />
                </ToolGroup>
              ) : undefined
            }
          />
        ))
      )}
      {externalChange && (
        <Banner
          tone="warning"
          actions={
            <>
              {doc.dirty && (
                <Button size="sm" onPress={onSaveAs}>
                  Enregistrer mes modifications sous…
                </Button>
              )}
              <Button size="sm" variant={doc.dirty ? "ghost" : "primary"} onPress={onReload}>
                {doc.dirty ? "Recharger (perdre mes modifications)" : "Recharger"}
              </Button>
            </>
          }
        >
          Ce fichier a été modifié par un autre programme depuis son ouverture.
        </Banner>
      )}
      {info.isXfa && (
        <Banner tone="warning">Ce document utilise des formulaires XFA, qui ne sont pas pris en charge : certaines pages peuvent s'afficher incomplètes.</Banner>
      )}
      {info.hasForm && !info.isXfa && !formBannerClosed && (
        <Banner
          tone="info"
          onDismiss={() => setFormBannerClosed(true)}
          actions={
            <Button size="sm" variant="ghost" onPress={() => setHighlightFields((h) => !h)}>
              {highlightFields ? "Ne plus surligner les champs" : "Surligner les champs"}
            </Button>
          }
        >
          {canFill ? "Ce document contient un formulaire : cliquez dans les champs pour les remplir (Tab passe au suivant)." : "Ce document contient un formulaire, mais son auteur en a interdit le remplissage."}
        </Banner>
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
            ref={scroller}
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
            className={clsx("focus-ring-inset min-h-0 flex-1 overflow-auto bg-canvas [scrollbar-gutter:stable]", isMarkupTool(tool) && canAnnotate && "cursor-text")}
            onMouseUp={() => {
              if (isMarkupTool(tool) && canAnnotate) void markupSelection(tool);
            }}
            onClick={onDocClick}
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
                      annots={annots.get(i) ?? null}
                      selectedId={selected?.page === i ? selected.id : null}
                      editing={editing?.page === i ? editing : null}
                      tool={canAnnotate ? tool : "select"}
                      toolStyle={styles.ink}
                      onPlace={onPlace}
                      fields={fields.get(i) ?? null}
                      canFill={canFill}
                      highlightFields={highlightFields}
                      onSetField={(pg, idx, input) => void setField(pg, idx, input)}
                      onSignField={(f) => void signAt(f.page, 0, 0, "signature", f)}
                      textDraft={textDraft?.page === i ? { x: textDraft.x, y: textDraft.y, size: styles.text.width, color: toHex(styles.text.color) } : null}
                      onCommitText={(pg, x, y, t) => {
                        setTextDraft(null);
                        void addText(pg, x, y, t);
                      }}
                      onCancelText={() => setTextDraft(null)}
                      onCreateInk={createInk}
                      onDeleteAnnot={deleteAnnot}
                      onSaveNote={saveNote}
                      onCloseEditor={() => setEditing(null)}
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
            ) : panel === "bookmarks" ? (
              <BookmarksPanel engine={engine} docId={info.id} cache={bookmarkCache} onLink={onLink} onClose={() => setPanel(null)} />
            ) : (
              <CommentsPanel
                annots={annots}
                pageCount={info.pageCount}
                pagesLoaded={pagesLoaded}
                selected={selected}
                author={author}
                canEdit={canAnnotate}
                onAuthorChange={onAuthorChange}
                onSelect={selectAnnot}
                onSave={(a, t) => void saveComment(a, t)}
                onDelete={(a) => void deleteAnnot(a.page, a.id)}
                onClose={() => setPanel(null)}
              />
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
          <ToolButton label="Commentaires" icon={<MessageSquare size={18} />} isSelected={panel === "comments"} onChange={(on) => setPanel(on ? "comments" : null)} />
        </Toolbar>
      </div>

      {sigDialog && (
        <SignatureDialog
          kind={sigDialog.kind}
          initialName={author}
          onClose={() => setSigDialog(null)}
          onSave={async (method, data, font) => {
            await saveSignature(sigDialog.kind, data, method, font);
            const s = await engine.signature(sigDialog.kind);
            if (s) sigDialog.then?.(s);
          }}
        />
      )}
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

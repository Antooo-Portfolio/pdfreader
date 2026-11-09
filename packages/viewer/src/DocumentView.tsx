import {
  Banner,
  Button,
  IconButton,
  PageNavigator,
  ToolButton,
  Toolbar,
  ToolbarSeparator,
  ToolGroup,
  ZoomControl,
} from "@pdfreader/ui";
import { FolderOpen, Highlighter, MousePointer2, Save } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type EngineClient, PT_TO_CSS, type TextWord } from "./engine";
import { PageView } from "./PageView";
import type { OpenDoc } from "./state";

const PAGE_GAP = 16;

interface Props {
  engine: EngineClient;
  doc: OpenDoc;
  isActive: boolean;
  tool: "select" | "highlight";
  onToolChange: (t: "select" | "highlight") => void;
  onZoom: (zoom: number) => void;
  onHighlightSelection: () => void;
  onSave: () => void;
  onOpen: () => void;
  /** Conteneur des pages (pour convertir la sélection en coordonnées PDF). */
  pagesRef: (el: HTMLDivElement | null) => void;
}

export function DocumentView({ engine, doc, isActive, tool, onToolChange, onZoom, onHighlightSelection, onSave, onOpen, pagesRef }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [range, setRange] = useState<[number, number]>([0, 2]);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const textCache = useRef(new Map<string, TextWord[][]>()).current;
  const { info, zoom } = doc;

  // Ajuster à la largeur à la première ouverture.
  useLayoutEffect(() => {
    if (doc.zoom > 0 || !scroller.current) return;
    const first = info.pages[0];
    if (!first) return;
    // Marges (2 × 24 px) + place de la barre de défilement verticale qui apparaîtra.
    const avail = scroller.current.clientWidth - 48 - 20;
    const z = Math.min(4, Math.max(0.25, avail / (first[0] * PT_TO_CSS)));
    onZoom(Math.round(z * 20) / 20);
  }, [doc.zoom, info.pages, onZoom]);

  useEffect(() => {
    const m = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const on = () => setDpr(window.devicePixelRatio || 1);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [dpr]);

  const offsets = useCallback(() => {
    let y = PAGE_GAP;
    return info.pages.map(([, h]) => {
      const top = y;
      y += h * PT_TO_CSS * zoom + PAGE_GAP;
      return top;
    });
  }, [info.pages, zoom]);

  // Page courante et pages à rendre (zone visible + une hauteur d'écran de chaque côté).
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || zoom <= 0) return;
    const tops = offsets();
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    const marker = viewTop + el.clientHeight / 3;
    let current = 0;
    for (let i = 0; i < tops.length; i++) if ((tops[i] ?? 0) <= marker) current = i;
    let first = tops.length - 1;
    let last = 0;
    for (let i = 0; i < tops.length; i++) {
      const top = tops[i] ?? 0;
      const bottom = top + (info.pages[i]?.[1] ?? 0) * PT_TO_CSS * zoom;
      if (bottom >= viewTop - el.clientHeight && top <= viewBottom + el.clientHeight) {
        first = Math.min(first, i);
        last = Math.max(last, i);
      }
    }
    setPage(current + 1);
    setRange([first, last]);
  }, [offsets, info.pages, zoom]);

  useEffect(() => {
    onScroll();
  }, [onScroll]);

  const goTo = (p: number) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: (offsets()[p - 1] ?? 0) - PAGE_GAP / 2 });
  };

  // Zoom en gardant la même page sous les yeux.
  const zoomTo = (z: number) => {
    const el = scroller.current;
    const z2 = Math.min(64, Math.max(0.08, z));
    if (!el || zoom <= 0) return onZoom(z2);
    const ratio = el.scrollTop / Math.max(1, el.scrollHeight);
    onZoom(z2);
    requestAnimationFrame(() => {
      el.scrollTop = ratio * el.scrollHeight;
    });
  };

  // Ctrl+molette et Ctrl+= / Ctrl+- sur le document actif.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomTo(zoom * 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomTo(zoom / 1.25);
      } else if (e.key === "1") {
        e.preventDefault();
        zoomTo(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

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
          selectedKeys={new Set([tool])}
          onSelectionChange={(keys) => {
            const k = [...keys][0];
            if (k === "select" || k === "highlight") onToolChange(k);
          }}
        >
          <ToolButton id="select" label="Sélectionner du texte" shortcut="V" icon={<MousePointer2 size={18} />} />
          <ToolButton id="highlight" label="Surligner (sélectionnez du texte)" shortcut="U" icon={<Highlighter size={18} />} />
        </ToolGroup>
        <Button size="sm" variant="ghost" icon={<Highlighter size={16} />} onPress={onHighlightSelection} className="ml-1">
          Surligner la sélection
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <PageNavigator page={page} total={info.pageCount} onChange={goTo} />
          <ToolbarSeparator />
          <ZoomControl value={Math.round(zoom * 100)} onChange={(v) => zoomTo(v / 100)} />
        </div>
      </Toolbar>
      {info.isXfa && (
        <Banner tone="warning">Ce document utilise des formulaires XFA, qui ne sont pas pris en charge : certaines pages peuvent s'afficher incomplètes.</Banner>
      )}
      <div
        ref={(el) => {
          scroller.current = el;
          pagesRef(el);
        }}
        onScroll={onScroll}
        onWheel={onWheel}
        tabIndex={0}
        role="document"
        aria-label={`${info.name}, page ${page} sur ${info.pageCount}`}
        className={`focus-ring-inset min-h-0 flex-1 overflow-auto bg-canvas ${tool === "highlight" ? "cursor-text" : ""}`}
        onMouseUp={() => {
          if (tool === "highlight") onHighlightSelection();
        }}
      >
        <div className="flex flex-col items-center" style={{ gap: PAGE_GAP, padding: `${PAGE_GAP}px 24px` }}>
          {zoom > 0 &&
            info.pages.map((size, i) => (
              <PageView
                key={i}
                engine={engine}
                docId={info.id}
                generation={info.generation}
                version={doc.pageVersions[i] ?? 0}
                index={i}
                size={size}
                zoom={zoom}
                dpr={dpr}
                active={isActive && i >= range[0] && i <= range[1]}
                textCache={textCache}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

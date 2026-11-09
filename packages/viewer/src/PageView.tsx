import { clsx } from "clsx";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Tool, ToolStyle } from "./annot";
import { AnnotLayer, NoteEditor } from "./AnnotTools";
import { type Annot, type Box, type EngineClient, type LinkAction, type PageLink, PT_TO_CSS, type Rotation, TILE, type TextWord, thumbScale } from "./engine";
import { type PageBox, rotationTransform } from "./layout";

const measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

interface Props {
  engine: EngineClient;
  docId: number;
  generation: number;
  version: number;
  index: number;
  /** Taille de la page en points, sans la rotation de la vue. */
  size: [number, number];
  /** Position et taille affichées (rotation comprise), en px CSS. */
  box: PageBox;
  zoom: number;
  dpr: number;
  rotation: Rotation;
  /** Rendue (tuiles, texte, liens) seulement quand la page est proche de la zone visible. */
  active: boolean;
  textCache: Map<string, TextWord[][]>;
  linkCache: Map<string, PageLink[]>;
  /** Résultats de recherche de la page et rang du résultat courant sur cette page (-1 : aucun). */
  hits?: Box[][];
  currentHit: number;
  onLink: (action: LinkAction) => void;
  /** Commentaires de la page (null : pas encore lus). */
  annots: Annot[] | null;
  selectedId: string | null;
  /** Note en cours d'édition sur cette page. */
  editing: { id: string; isNew: boolean } | null;
  tool: Tool;
  toolStyle: ToolStyle;
  onCreateNote: (page: number, x: number, y: number) => void;
  onCreateInk: (page: number, strokes: [number, number][][]) => void;
  onDeleteAnnot: (page: number, id: string) => void;
  onSaveNote: (page: number, id: string, text: string) => void;
  onCloseEditor: () => void;
}

/** Une page : aperçu basse résolution, tuiles WebP rendues par le moteur, résultats de
 *  recherche, couche de texte DOM (sélection, copier, lecteurs d'écran) et liens. La rotation de
 *  la vue tourne le tout d'un bloc. */
export const PageView = memo(function PageView(p: Props) {
  const { engine, docId, generation, version, index, size, box, zoom, dpr, rotation, active, textCache, linkCache } = p;
  const [pw, ph] = size;
  const cssW = pw * PT_TO_CSS * zoom;
  const cssH = ph * PT_TO_CSS * zoom;
  const scale = PT_TO_CSS * zoom * dpr;
  const devW = Math.ceil(pw * scale);
  const devH = Math.ceil(ph * scale);
  const cacheKey = `${docId}:${generation}:${index}`;
  const [lines, setLines] = useState<TextWord[][] | null>(() => textCache.get(cacheKey) ?? null);
  const [links, setLinks] = useState<PageLink[] | null>(() => linkCache.get(cacheKey) ?? null);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    setLines(textCache.get(cacheKey) ?? null);
    setLinks(linkCache.get(cacheKey) ?? null);
  }, [cacheKey, textCache, linkCache]);

  useEffect(() => {
    if (!active || lines) return;
    let alive = true;
    engine
      .textLayer(docId, index)
      .then((l) => {
        textCache.set(cacheKey, l);
        if (alive) setLines(l);
      })
      .catch(() => alive && setTextError(true));
    return () => {
      alive = false;
    };
  }, [active, lines, engine, docId, index, cacheKey, textCache]);

  useEffect(() => {
    if (!active || links) return;
    let alive = true;
    engine
      .links(docId, index)
      .then((l) => {
        linkCache.set(cacheKey, l);
        if (alive) setLinks(l);
      })
      .catch(() => alive && setLinks([]));
    return () => {
      alive = false;
    };
  }, [active, links, engine, docId, index, cacheKey, linkCache]);

  const tiles = useMemo(() => {
    if (!active) return [];
    const t: { x: number; y: number; w: number; h: number }[] = [];
    for (let y = 0; y < devH; y += TILE) for (let x = 0; x < devW; x += TILE) t.push({ x, y, w: Math.min(TILE, devW - x), h: Math.min(TILE, devH - y) });
    return t;
  }, [active, devW, devH]);

  // Après une modification (nouvelle version de la page), les anciennes tuiles restent affichées
  // jusqu'à ce que toutes les nouvelles soient chargées : pas de page floue qui clignote.
  const [shownVersion, setShownVersion] = useState(version);
  const waiting = useRef(0);
  useEffect(() => {
    if (version === shownVersion) return;
    waiting.current = tiles.length;
    if (tiles.length === 0) setShownVersion(version);
  }, [version, shownVersion, tiles.length]);
  const onNewTile = () => {
    waiting.current -= 1;
    if (waiting.current <= 0) setShownVersion(version);
  };
  const tileLayer = (ver: number, hidden: boolean) =>
    tiles.map((t) => (
      <img
        key={`${ver}-${t.x}-${t.y}-${scale}`}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        src={engine.tileUrl(docId, generation, ver, index, scale, t.x, t.y)}
        onLoad={hidden ? onNewTile : undefined}
        onError={hidden ? onNewTile : undefined}
        className="pointer-events-none absolute max-w-none"
        style={{ left: t.x / dpr, top: t.y / dpr, width: t.w / dpr, height: t.h / dpr, opacity: hidden ? 0 : 1 }}
      />
    ));

  const k = PT_TO_CSS * zoom;
  const preview = thumbScale(pw, ph, dpr);

  return (
    <div
      className="pdf-page absolute select-none"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      data-page-index={index}
      data-pw={pw}
      data-ph={ph}
      data-rot={rotation}
      role="region"
      aria-label={`Page ${index + 1}`}
    >
      {!active && (
        <span aria-hidden className="absolute inset-0 grid place-items-center text-sm text-muted">
          {index + 1}
        </span>
      )}
      <div className="absolute top-0 left-0 origin-top-left" style={{ width: cssW, height: cssH, transform: rotationTransform(rotation, cssW, cssH) }}>
        {active && (
          // Aperçu flou affiché tout de suite (même image que la vignette), recouvert par les tuiles.
          <img
            alt=""
            aria-hidden
            draggable={false}
            src={engine.tileUrl(docId, generation, shownVersion, index, preview, 0, 0)}
            className="pointer-events-none absolute inset-0 size-full max-w-none"
          />
        )}
        {tileLayer(shownVersion, false)}
        {shownVersion !== version && tileLayer(version, true)}
        {p.hits && <Hits hits={p.hits} current={p.currentHit} k={k} />}
        {active && lines && <TextLayer lines={lines} k={k} />}
        {active && links && links.length > 0 && <Links links={links} k={k} onLink={p.onLink} />}
      </div>
      {active && textError && <span className="sr-only">Le texte de cette page n'a pas pu être lu.</span>}
      {active && p.annots && (
        <AnnotLayer
          size={size}
          k={k}
          rotation={rotation}
          box={box}
          tool={p.tool}
          style={p.toolStyle}
          annots={p.annots}
          selectedId={p.selectedId}
          onCreateNote={(x, y) => p.onCreateNote(index, x, y)}
          onCreateInk={(s) => p.onCreateInk(index, s)}
          onErase={(id) => p.onDeleteAnnot(index, id)}
        />
      )}
      {active &&
        p.editing &&
        p.annots?.map((a) =>
          a.id === p.editing?.id ? (
            <NoteEditor
              key={a.id}
              annot={a}
              size={size}
              k={k}
              rotation={rotation}
              isNew={p.editing.isNew}
              onSave={(text) => p.onSaveNote(index, a.id, text)}
              onDelete={() => p.onDeleteAnnot(index, a.id)}
              onClose={p.onCloseEditor}
            />
          ) : null,
        )}
    </div>
  );
});

function Hits({ hits, current, k }: { hits: Box[][]; current: number; k: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {hits.map((boxes, i) =>
        boxes.map(([x, y, w, h], j) => (
          <div
            key={`${i}-${j}`}
            data-current-hit={i === current ? "" : undefined}
            className={clsx(
              "absolute rounded-[1px] mix-blend-multiply forced-colors:mix-blend-normal forced-colors:outline-2 forced-colors:outline-[Highlight]",
              i === current ? "bg-search-hit-current outline-2 outline-offset-1 outline-search-hit-current" : "bg-search-hit opacity-70",
            )}
            style={{ left: x * k - 1, top: y * k - 1, width: w * k + 2, height: h * k + 2 }}
          />
        )),
      )}
    </div>
  );
}

function linkLabel(a: LinkAction): string {
  if (a.kind === "goto") return `Lien vers la page ${a.page + 1}`;
  if (a.kind === "uri") return a.uri.toLowerCase().startsWith("mailto:") ? `Lien e-mail : ${a.uri.slice(7)}` : `Lien vers ${a.uri}`;
  return "Lien";
}

function Links({ links, k, onLink }: { links: PageLink[]; k: number; onLink: (a: LinkAction) => void }) {
  return (
    <div className="absolute inset-0">
      {links.map((l, i) => (
        <a
          key={i}
          href="#"
          aria-label={linkLabel(l.action)}
          title={l.action.kind === "uri" ? l.action.uri : linkLabel(l.action)}
          onClick={(e) => {
            e.preventDefault();
            onLink(l.action);
          }}
          className="focus-ring absolute cursor-pointer rounded-[2px] hover:bg-accent/10"
          style={{ left: l.x * k, top: l.y * k, width: Math.max(4, l.w * k), height: Math.max(4, l.h * k) }}
        />
      ))}
    </div>
  );
}

/** Mots placés au-dessus de l'image, texte transparent : la sélection et le copier sont natifs. */
function TextLayer({ lines, k }: { lines: TextWord[][]; k: number }) {
  const words = useMemo(() => {
    const out: { key: string; text: string; left: number; top: number; fontSize: number; sx: number; br: boolean }[] = [];
    lines.forEach((line, li) =>
      line.forEach((w, wi) => {
        const fontSize = w.h * k * 0.92;
        let sx = 1;
        if (measureCtx) {
          measureCtx.font = `${fontSize}px sans-serif`;
          const m = measureCtx.measureText(w.t.trimEnd()).width;
          if (m > 0) sx = (w.w * k) / m;
        }
        out.push({ key: `${li}-${wi}`, text: w.t, left: w.x * k, top: w.y * k, fontSize, sx, br: wi === line.length - 1 });
      }),
    );
    return out;
  }, [lines, k]);
  return (
    <div className="pdf-text-layer absolute inset-0 select-text" lang="fr">
      {words.map((w) => (
        <span key={w.key}>
          <span
            className="absolute origin-top-left whitespace-pre leading-none text-transparent"
            style={{ left: w.left, top: w.top, fontSize: w.fontSize, transform: `scaleX(${w.sx})`, fontFamily: "sans-serif" }}
          >
            {w.text}
          </span>
          {w.br && <br />}
        </span>
      ))}
    </div>
  );
}

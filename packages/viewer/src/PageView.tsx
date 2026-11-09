import { memo, useEffect, useMemo, useRef, useState } from "react";
import { type EngineClient, PT_TO_CSS, TILE, type TextWord } from "./engine";

const measureCtx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;

interface Props {
  engine: EngineClient;
  docId: number;
  generation: number;
  version: number;
  index: number;
  size: [number, number];
  zoom: number;
  dpr: number;
  /** Rendue (tuiles + texte) seulement quand la page est proche de la zone visible. */
  active: boolean;
  textCache: Map<string, TextWord[][]>;
}

/** Une page : tuiles WebP rendues par le moteur, couche de texte DOM par-dessus (sélection,
 *  copier, lecteurs d'écran). Hors zone visible : simple emplacement de la bonne taille. */
export const PageView = memo(function PageView({ engine, docId, generation, version, index, size, zoom, dpr, active, textCache }: Props) {
  const [pw, ph] = size;
  const cssW = pw * PT_TO_CSS * zoom;
  const cssH = ph * PT_TO_CSS * zoom;
  const scale = PT_TO_CSS * zoom * dpr;
  const devW = Math.ceil(pw * scale);
  const devH = Math.ceil(ph * scale);
  const cacheKey = `${docId}:${generation}:${index}`;
  const [lines, setLines] = useState<TextWord[][] | null>(() => textCache.get(cacheKey) ?? null);
  const [textError, setTextError] = useState(false);

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

  const tiles = useMemo(() => {
    if (!active) return [];
    const t: { x: number; y: number; w: number; h: number }[] = [];
    for (let y = 0; y < devH; y += TILE) for (let x = 0; x < devW; x += TILE) t.push({ x, y, w: Math.min(TILE, devW - x), h: Math.min(TILE, devH - y) });
    return t;
  }, [active, devW, devH]);

  return (
    <div
      className="pdf-page relative mx-auto select-none"
      style={{ width: cssW, height: cssH }}
      data-page-index={index}
      data-pw={pw}
      data-ph={ph}
      role="region"
      aria-label={`Page ${index + 1}`}
    >
      {!active && (
        <span aria-hidden className="absolute inset-0 grid place-items-center text-sm text-muted">
          {index + 1}
        </span>
      )}
      {tiles.map((t) => (
        <img
          key={`${t.x}-${t.y}-${scale}`}
          alt=""
          aria-hidden
          draggable={false}
          decoding="async"
          src={engine.tileUrl(docId, generation, version, index, scale, t.x, t.y)}
          className="pointer-events-none absolute max-w-none"
          style={{ left: t.x / dpr, top: t.y / dpr, width: t.w / dpr, height: t.h / dpr }}
        />
      ))}
      {active && lines && <TextLayer lines={lines} k={PT_TO_CSS * zoom} />}
      {active && textError && <span className="sr-only">Le texte de cette page n'a pas pu être lu.</span>}
    </div>
  );
});

/** Mots placés au-dessus de l'image, texte transparent : la sélection et le copier sont natifs. */
function TextLayer({ lines, k }: { lines: TextWord[][]; k: number }) {
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className="pdf-text-layer absolute inset-0 select-text" lang="fr">
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

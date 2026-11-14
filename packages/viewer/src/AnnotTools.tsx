import { t, Button, ColorSwatches, IconButton, Toolbar, ToolbarSeparator, Slider } from "@pdfreader/ui";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatDate, fromHex, hitTest, isMultiPoint, KIND_LABELS, parsePdfDate, tint, type Tool, type ToolStyle, toHex } from "./annot";
import type { Annot, Box, Rotation, ShapeKind } from "./engine";
import { type PageBox, rotateBox, unrotatePoint } from "./layout";

/* ---------------------------------------------------------------- calque d'une page */

interface LayerProps {
  /** Taille de la page en points (sans la rotation de la vue). */
  size: [number, number];
  /** px CSS par point. */
  k: number;
  rotation: Rotation;
  box: PageBox;
  tool: Tool;
  style: ToolStyle;
  annots: Annot[];
  selectedId: string | null;
  /** Clic avec un outil qui pose quelque chose (note, texte, coche, signature). */
  onPlace: (tool: Tool, x: number, y: number) => void;
  onCreateInk: (strokes: [number, number][][]) => void;
  onErase: (id: string) => void;
  /** Outil Formes : forme choisie, remplissage, et création (points en points depuis le haut). */
  shapeKind: ShapeKind;
  shapeFill: boolean;
  onCreateShape: (points: [number, number][]) => void;
}

/** Calque des outils Note, Dessin et Gomme (au-dessus de la page, qui n'est pas tournée) et
 *  contour du commentaire sélectionné. Les coordonnées sont ramenées en points sur la page non
 *  tournée. */
export function AnnotLayer(p: LayerProps) {
  const [pw, ph] = p.size;
  // Le tracé en cours vit dans une référence : les mouvements rapides arrivent plus vite que
  // les rendus, aucun point ne doit se perdre. L'état ne sert qu'à l'affichage.
  const strokeRef = useRef<[number, number][] | null>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const [pending, setPending] = useState<[number, number][] | null>(null);
  const erased = useRef(new Set<string>());
  const down = useRef<{ x: number; y: number } | null>(null);
  // Formes : glisser (rectangle, ellipse, ligne, flèche) ou sommets cliqués (polygone…).
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [verts, setVerts] = useState<[number, number][]>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const shaping = p.tool === "shape";
  const multi = shaping && isMultiPoint(p.shapeKind);
  const finishMulti = (pts: [number, number][]) => {
    const need = p.shapeKind === "polyline" ? 2 : 3;
    setVerts([]);
    setHover(null);
    if (pts.length >= need) p.onCreateShape(pts);
  };
  const finishRef = useRef(finishMulti);
  finishRef.current = finishMulti;
  const vertsRef = useRef(verts);
  vertsRef.current = verts;
  // Entrée termine le polygone, Échap l'abandonne ; changer d'outil ou de forme aussi.
  useEffect(() => {
    if (!multi) return;
    const onKey = (e: KeyboardEvent) => {
      if (vertsRef.current.length === 0) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finishRef.current(vertsRef.current);
      } else if (e.key === "Escape") {
        setVerts([]);
        setHover(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [multi]);
  useEffect(() => {
    setVerts([]);
    setDrag(null);
  }, [p.tool, p.shapeKind]);

  // Le tracé provisoire reste affiché jusqu'à ce que la page relue le contienne.
  useEffect(() => setPending(null), [p.annots]);

  const toPt = (e: React.PointerEvent): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    const sideways = p.rotation === 90 || p.rotation === 270;
    const W = sideways ? r.height : r.width;
    const H = sideways ? r.width : r.height;
    const [u, v] = unrotatePoint(e.clientX - r.left, e.clientY - r.top, W, H, p.rotation);
    return [Math.max(0, Math.min(pw, (u / W) * pw)), Math.max(0, Math.min(ph, (v / H) * ph))];
  };

  const erase = (x: number, y: number) => {
    const hit = hitTest(p.annots, x, y, 4 / p.k, true);
    if (hit && !erased.current.has(hit.id) && !hit.locked) {
      erased.current.add(hit.id);
      p.onErase(hit.id);
    }
  };

  const placing = p.tool === "note" || p.tool === "text" || p.tool === "textbox" || p.tool === "callout" || p.tool === "check" || p.tool === "sign" || p.tool === "stamp";
  const active = placing || p.tool === "ink" || p.tool === "eraser" || shaping;
  const cssW = pw * p.k;
  const cssH = ph * p.k;
  const transform = p.rotation ? rotationCss(p.rotation, cssW, cssH) : undefined;
  const selected = p.selectedId ? p.annots.find((a) => a.id === p.selectedId) : undefined;
  const live = stroke ?? pending;

  return (
    <>
      <div aria-hidden className="pointer-events-none absolute top-0 left-0 origin-top-left" style={{ width: cssW, height: cssH, transform }}>
        {selected && <Outline annot={selected} k={p.k} />}
        {live && live.length > 0 && (
          <svg className="absolute inset-0 overflow-visible" width={cssW} height={cssH}>
            <polyline
              points={live.map(([x, y]) => `${x * p.k},${y * p.k}`).join(" ")}
              fill="none"
              stroke={toHex(p.style.color)}
              strokeOpacity={p.style.opacity}
              strokeWidth={p.style.width * p.k}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {shaping && (drag || verts.length > 0) && (
          <ShapePreview kind={p.shapeKind} drag={drag} verts={hover ? [...verts, hover] : verts} k={p.k} style={p.style} fill={p.shapeFill} w={cssW} h={cssH} />
        )}
      </div>
      {active && (
        <div
          className="absolute inset-0 touch-none"
          data-draw-layer
          style={{ cursor: p.tool === "text" || p.tool === "textbox" ? "text" : p.tool === "callout" || shaping ? "crosshair" : placing ? "copy" : p.tool === "ink" ? "crosshair" : "cell" }}
          onDoubleClick={(e) => {
            if (!multi) return;
            e.preventDefault();
            // Le double-clic a déjà posé deux sommets au même endroit : un seul compte.
            const pts = vertsRef.current.filter((v, i, arr) => i === 0 || Math.hypot(v[0] - (arr[i - 1]?.[0] ?? 0), v[1] - (arr[i - 1]?.[1] ?? 0)) * p.k > 3);
            finishMulti(pts);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Pointeur sans capture possible (événement de test) : le tracé fonctionne quand même.
            }
            const [x, y] = toPt(e);
            down.current = { x: e.clientX, y: e.clientY };
            if (p.tool === "ink") {
              strokeRef.current = [[x, y]];
              setStroke(strokeRef.current);
            }
            if (p.tool === "eraser") {
              erased.current = new Set();
              erase(x, y);
            }
            if (shaping && !multi) setDrag({ a: [x, y], b: [x, y] });
          }}
          onPointerMove={(e) => {
            if (multi && verts.length > 0) setHover(toPt(e));
            if (!down.current) return;
            const [x, y] = toPt(e);
            if (shaping && !multi) setDrag((d) => (d ? { a: d.a, b: [x, y] } : d));
            const cur = strokeRef.current;
            if (p.tool === "ink" && cur) {
              const last = cur[cur.length - 1];
              if (!last || Math.hypot(x - last[0], y - last[1]) * p.k >= 1.5) {
                strokeRef.current = [...cur, [x, y]];
                setStroke(strokeRef.current);
              }
            }
            if (p.tool === "eraser") erase(x, y);
          }}
          onPointerUp={(e) => {
            const start = down.current;
            down.current = null;
            if (!start) return;
            const [x, y] = toPt(e);
            if (placing && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) p.onPlace(p.tool, x, y);
            if (shaping && !multi) {
              const d = drag;
              setDrag(null);
              if (d && Math.hypot(x - d.a[0], y - d.a[1]) * p.k >= 4) p.onCreateShape([d.a, [x, y]]);
            }
            if (multi) {
              // Clic près du premier sommet : la forme se ferme.
              const first = verts[0];
              if (first && verts.length >= 3 && Math.hypot(x - first[0], y - first[1]) * p.k < 8) finishMulti(verts);
              else setVerts((v) => [...v, [x, y]]);
            }
            const done = strokeRef.current;
            strokeRef.current = null;
            if (p.tool === "ink" && done && done[0]) {
              // Un simple clic laisse un point : on le prolonge d'un demi-point pour qu'il se voie.
              const s: [number, number][] = done.length === 1 ? [done[0], [done[0][0] + 0.5, done[0][1] + 0.5]] : done;
              setPending(s);
              setStroke(null);
              p.onCreateInk([s]);
            }
          }}
        />
      )}
    </>
  );
}

/** Aperçu de la forme en cours (points en points PDF depuis le haut, `k` px par point). */
function ShapePreview({
  kind,
  drag,
  verts,
  k,
  style,
  fill,
  w,
  h,
}: {
  kind: ShapeKind;
  drag: { a: [number, number]; b: [number, number] } | null;
  verts: [number, number][];
  k: number;
  style: ToolStyle;
  fill: boolean;
  w: number;
  h: number;
}) {
  const stroke = toHex(style.color);
  const common = { stroke, strokeOpacity: style.opacity, strokeWidth: style.width * k, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  let shape: React.ReactNode = null;
  if (drag) {
    const [x0, y0] = drag.a;
    const [x1, y1] = drag.b;
    const fillColor = fill && (kind === "square" || kind === "circle") ? toHex(tint(style.color)) : "none";
    if (kind === "square") shape = <rect x={Math.min(x0, x1) * k} y={Math.min(y0, y1) * k} width={Math.abs(x1 - x0) * k} height={Math.abs(y1 - y0) * k} fill={fillColor} {...common} />;
    else if (kind === "circle")
      shape = <ellipse cx={((x0 + x1) / 2) * k} cy={((y0 + y1) / 2) * k} rx={(Math.abs(x1 - x0) / 2) * k} ry={(Math.abs(y1 - y0) / 2) * k} fill={fillColor} {...common} />;
    else shape = <line x1={x0 * k} y1={y0 * k} x2={x1 * k} y2={y1 * k} markerEnd={kind === "arrow" ? "url(#shape-arrow)" : undefined} {...common} />;
  } else if (verts.length) {
    const pts = verts.map(([x, y]) => `${x * k},${y * k}`).join(" ");
    shape = kind === "polyline" ? <polyline points={pts} fill="none" {...common} /> : <polygon points={pts} fill="none" strokeDasharray={kind === "cloud" ? `${4 * k} ${3 * k}` : undefined} {...common} />;
  }
  return (
    <svg className="absolute inset-0 overflow-visible" width={w} height={h} data-shape-preview>
      <defs>
        <marker id="shape-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10" fill="none" stroke={stroke} strokeWidth="1.5" />
        </marker>
      </defs>
      {shape}
      {verts.map(([x, y], i) => (
        <circle key={i} cx={x * k} cy={y * k} r={3} fill="var(--bg)" stroke={stroke} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

function rotationCss(rotation: Rotation, w: number, h: number) {
  if (rotation === 90) return `translate(${h}px, 0) rotate(90deg)`;
  if (rotation === 180) return `translate(${w}px, ${h}px) rotate(180deg)`;
  return `translate(0, ${w}px) rotate(270deg)`;
}

function Outline({ annot, k }: { annot: Annot; k: number }) {
  const boxes: Box[] = annot.boxes.length ? annot.boxes : [annot.rect];
  return (
    <>
      {boxes.map(([x, y, w, h], i) => (
        <div
          key={i}
          data-selected-annot={annot.id}
          className="absolute rounded-[2px] outline-2 outline-offset-2 outline-accent outline-dashed forced-colors:outline-[Highlight]"
          style={{ left: x * k, top: y * k, width: w * k, height: h * k }}
        />
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- éditeur de note */

export function NoteEditor({
  annot,
  size,
  k,
  rotation,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  annot: Annot;
  size: [number, number];
  k: number;
  rotation: Rotation;
  isNew: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(annot.contents);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const [x, y, w] = rotateBox(annot.rect, size[0], size[1], rotation);
  const commit = () => {
    if (text !== annot.contents) onSave(text);
    else if (isNew && !text.trim()) onDelete();
    else onClose();
  };
  return (
    <div
      role="dialog"
      aria-label={`Note de ${annot.author || "auteur inconnu"}`}
      className="absolute z-(--z-popover) flex w-64 flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 shadow-pop select-text"
      style={{ left: (x + w) * k + 6, top: y * k }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          if (isNew && !annot.contents && !text.trim()) onDelete();
          else onClose();
        } else if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          commit();
        }
      }}
    >
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted">
        <span className="truncate font-semibold text-fg">{annot.author || "Auteur inconnu"}</span>
        <span className="shrink-0">{formatDate(parsePdfDate(annot.modified ?? annot.created))}</span>
      </div>
      <textarea
        ref={ref}
        aria-label={t("Texte de la note")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={t("Votre commentaire")}
        className="focus-ring resize-y rounded-md border border-border-input bg-bg p-2 text-base"
      />
      <div className="flex items-center justify-between">
        <IconButton label={t("Supprimer la note")} size="sm" variant="ghost" icon={<Trash2 size={16} />} onPress={onDelete} />
        <div className="flex gap-1">
          <Button size="sm" onPress={onClose}>
            {t("Fermer")}
          </Button>
          <Button size="sm" variant="primary" onPress={commit}>
            {t("Enregistrer")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- barre de propriétés */

export function PropertyBar({
  title,
  style,
  showWidth,
  showOpacity,
  showColor = true,
  widthLabel = t("Épaisseur"),
  widthRange = [0.5, 12, 0.5],
  extra,
  onChange,
  onDelete,
}: {
  /** Nom de l'outil, ou « Sélection : … » pour un commentaire sélectionné. */
  title: string;
  style: ToolStyle;
  showWidth: boolean;
  showOpacity: boolean;
  showColor?: boolean;
  widthLabel?: string;
  /** min, max, pas. */
  widthRange?: [number, number, number];
  /** Réglages propres à l'outil (coche ou croix, signature ou initiales…). */
  extra?: React.ReactNode;
  onChange: (s: Partial<ToolStyle>) => void;
  onDelete?: () => void;
}) {
  return (
    <Toolbar aria-label={title} className="flex h-(--layout-propbar) shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
      <span className="shrink-0 text-sm font-medium whitespace-nowrap text-muted">{title}</span>
      {showColor && (
        <ColorSwatches
          aria-label={t("Couleur")}
          value={toHex(style.color)}
          onChange={(c) => {
            const rgb = fromHex(c.toString("hex"));
            if (rgb) onChange({ color: rgb });
          }}
        />
      )}
      {showOpacity && (
        <>
          <ToolbarSeparator />
          <Slider
            label={t("Opacité")}
            unit=" %"
            minValue={10}
            maxValue={100}
            step={5}
            value={Math.round(style.opacity * 100)}
            onChange={(v) => onChange({ opacity: (v as number) / 100 })}
            className="w-36! shrink-0"
          />
        </>
      )}
      {showWidth && (
        <>
          <ToolbarSeparator />
          <Slider
            label={widthLabel}
            unit=" pt"
            minValue={widthRange[0]}
            maxValue={widthRange[1]}
            step={widthRange[2]}
            value={style.width}
            onChange={(v) => onChange({ width: v as number })}
            className="w-36! shrink-0"
          />
        </>
      )}
      {extra}
      {onDelete && (
        <Button size="sm" variant="ghost" icon={<Trash2 size={16} />} onPress={onDelete} className="ml-auto">
          {t("Supprimer")}
        </Button>
      )}
    </Toolbar>
  );
}

export const kindLabel = (a: Annot) => t(KIND_LABELS[a.kind]);

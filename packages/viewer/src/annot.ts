import { locale, msg, t } from "@pdfreader/ui";
/** Outils de commentaire, styles par outil et fonctions utilitaires (libellés, couleurs, dates,
 *  détection du commentaire sous le pointeur). */
import type { Annot, AnnotKind, MarkupKind, Rgb } from "./engine";

export type Tool = "select" | MarkupKind | "note" | "ink" | "eraser" | "text" | "textbox" | "callout" | "check" | "sign";
export const MARKUP_TOOLS: MarkupKind[] = ["highlight", "underline", "strikeout"];
export const isMarkupTool = (t: Tool): t is MarkupKind => (MARKUP_TOOLS as string[]).includes(t);

export interface ToolStyle {
  color: Rgb;
  opacity: number;
  /** Épaisseur du trait en points (dessin). */
  width: number;
}

export type ToolStyles = Record<MarkupKind | "note" | "ink" | "text" | "check", ToolStyle>;

export const DEFAULT_STYLES: ToolStyles = {
  highlight: { color: [255, 225, 77], opacity: 1, width: 1 },
  underline: { color: [229, 72, 77], opacity: 1, width: 1 },
  strikeout: { color: [229, 72, 77], opacity: 1, width: 1 },
  note: { color: [255, 225, 77], opacity: 1, width: 1 },
  ink: { color: [22, 24, 28], opacity: 1, width: 2 },
  // Texte et coche : « width » est la taille en points.
  text: { color: [22, 24, 28], opacity: 1, width: 12 },
  check: { color: [22, 24, 28], opacity: 1, width: 14 },
};

export const KIND_LABELS: Record<AnnotKind, string> = {
  highlight: msg("Surlignage"),
  underline: msg("Souligné"),
  strikeout: msg("Barré"),
  squiggly: msg("Ondulé"),
  note: msg("Note"),
  ink: msg("Dessin"),
  freetext: msg("Zone de texte"),
  line: msg("Ligne"),
  square: msg("Rectangle"),
  circle: msg("Ellipse"),
  polygon: msg("Polygone"),
  polyline: msg("Ligne brisée"),
  stamp: msg("Tampon"),
  text: msg("Texte"),
  mark: msg("Coche"),
  signature: msg("Signature"),
  textbox: msg("Zone de texte"),
  callout: msg("Légende"),
  other: msg("Annotation"),
};

export const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export function fromHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  return m ? [Number.parseInt(m[1] ?? "0", 16), Number.parseInt(m[2] ?? "0", 16), Number.parseInt(m[3] ?? "0", 16)] : null;
}

/** Date PDF (« D:20261109183000+01'00' », « D:20261109173000Z », parties finales facultatives). */
export function parsePdfDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const n = (i: number, d: number) => (m[i] ? Number(m[i]) : d);
  let t = Date.UTC(n(1, 2000), n(2, 1) - 1, n(3, 1), n(4, 0), n(5, 0), n(6, 0));
  const sign = m[7];
  if (sign === "+" || sign === "-") t -= (sign === "+" ? 1 : -1) * (n(8, 0) * 60 + n(9, 0)) * 60_000;
  else if (!sign) t += new Date(t).getTimezoneOffset() * 60_000; // sans fuseau : heure locale
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(d: Date | null): string {
  if (!d) return "";
  const today = new Date();
  const time = d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return t("aujourd'hui, {time}", { time });
  return `${d.toLocaleDateString(locale(), { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

function distToSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const inBox = (x: number, y: number, [bx, by, bw, bh]: [number, number, number, number], pad = 0) =>
  x >= bx - pad && x <= bx + bw + pad && y >= by - pad && y <= by + bh + pad;

/** Commentaire sous le point (x, y) en points, le plus haut placé d'abord. `tolerance` en points. */
export function hitTest(annots: Annot[], x: number, y: number, tolerance: number, inkOnly = false): Annot | null {
  for (let i = annots.length - 1; i >= 0; i--) {
    const a = annots[i];
    if (!a || (inkOnly && a.kind !== "ink")) continue;
    if (a.kind === "ink") {
      const reach = a.width / 2 + tolerance;
      if (a.strokes.some((s) => s.some((p, j) => j > 0 && distToSegment(x, y, s[j - 1] ?? p, p) <= reach) || (s.length === 1 && s[0] && Math.hypot(x - s[0][0], y - s[0][1]) <= reach))) return a;
    } else if (a.boxes.length) {
      if (a.boxes.some((b) => inBox(x, y, b, tolerance / 2))) return a;
    } else if (inBox(x, y, a.rect, tolerance / 2)) {
      return a;
    }
  }
  return null;
}

/** Texte court qui résume un commentaire (liste, lecteurs d'écran). */
export function annotSummary(a: Annot): string {
  return a.contents.trim() || t(KIND_LABELS[a.kind]);
}

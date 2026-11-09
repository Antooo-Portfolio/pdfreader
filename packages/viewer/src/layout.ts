/** Mise en page du document : modes d'affichage (continu ou non, une ou deux pages, couverture),
 *  rotation de l'affichage et zooms ajustés. Fonctions pures, testables sans interface. */
import { type Box, type Layout, PT_TO_CSS, type Rotation } from "./engine";

/** Espace entre deux rangées de pages et en haut / bas du document (px CSS). */
export const PAGE_GAP = 16;
/** Marge à gauche et à droite du document (px CSS). */
export const SIDE_PAD = 24;
/** Espace entre les deux pages d'une double page (px CSS). */
export const SPREAD_GAP = 4;

export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Row {
  pages: number[];
  top: number;
  height: number;
}

export interface DocLayout {
  rows: Row[];
  /** Rangée de chaque page. */
  rowOf: number[];
  /** Position de chaque page dans le contenu, en px CSS. Pour un mode non continu, seules les
   *  pages de la rangée affichée ont une position utile (les autres sont en haut). */
  boxes: PageBox[];
  width: number;
  height: number;
}

export const isSpread = (l: Layout) => l === "double" || l === "continuous-double";
export const isContinuous = (l: Layout) => l === "continuous" || l === "continuous-double";

/** Taille affichée d'une page (points), rotation de la vue comprise. */
export function displaySize([w, h]: [number, number], rotation: Rotation): [number, number] {
  return rotation === 90 || rotation === 270 ? [h, w] : [w, h];
}

/** Regroupe les pages en rangées (une page, ou deux côte à côte ; avec couverture, la première
 *  page est seule). */
export function groupRows(count: number, layout: Layout, cover: boolean): number[][] {
  const out: number[][] = [];
  if (!isSpread(layout)) {
    for (let i = 0; i < count; i++) out.push([i]);
    return out;
  }
  let i = 0;
  if (cover && count > 0) {
    out.push([0]);
    i = 1;
  }
  for (; i < count; i += 2) out.push(i + 1 < count ? [i, i + 1] : [i]);
  return out;
}

export function computeLayout(
  sizes: [number, number][],
  zoom: number,
  rotation: Rotation,
  layout: Layout,
  cover: boolean,
  viewportWidth: number,
  /** Rangée affichée en mode non continu. */
  currentRow: number,
): DocLayout {
  const k = PT_TO_CSS * zoom;
  const disp = sizes.map((s) => displaySize(s, rotation));
  const spread = isSpread(layout);
  const groups = groupRows(sizes.length, layout, cover);
  let slot = 0;
  for (const [w] of disp) slot = Math.max(slot, w * k);
  const rowWidth = spread ? slot * 2 + SPREAD_GAP : slot;
  const width = Math.max(viewportWidth, rowWidth + SIDE_PAD * 2);
  const center = width / 2;
  const rowOf = new Array<number>(sizes.length).fill(0);
  const boxes: PageBox[] = new Array(sizes.length);
  const rows: Row[] = [];
  const continuous = isContinuous(layout);
  let y = PAGE_GAP;
  groups.forEach((pages, r) => {
    const shown = continuous || r === currentRow;
    const top = shown ? y : PAGE_GAP;
    let height = 0;
    for (const p of pages) height = Math.max(height, (disp[p]?.[1] ?? 0) * k);
    pages.forEach((p, j) => {
      rowOf[p] = r;
      const w = (disp[p]?.[0] ?? 0) * k;
      const h = (disp[p]?.[1] ?? 0) * k;
      let left: number;
      if (!spread) left = center - w / 2;
      else if (pages.length === 2) left = j === 0 ? center - SPREAD_GAP / 2 - w : center + SPREAD_GAP / 2;
      // Page seule d'une double page : la couverture à droite, la dernière page à gauche.
      else left = cover && p === 0 ? center + SPREAD_GAP / 2 : center - SPREAD_GAP / 2 - w;
      boxes[p] = { left, top: top + (height - h) / 2, width: w, height: h };
    });
    rows.push({ pages, top, height });
    if (continuous) y += height + PAGE_GAP;
    else if (shown) y = top + height + PAGE_GAP;
  });
  const height = continuous ? y : (rows[currentRow]?.height ?? 0) + PAGE_GAP * 2;
  return { rows, rowOf, boxes, width, height };
}

/** Zoom qui fait tenir la largeur (et, pour « page entière », la hauteur) de la plus grande page
 *  du document dans la zone visible. Calculé sur tout le document pour rester stable pendant le
 *  défilement d'un document aux pages de tailles différentes. */
export function fitZoom(
  mode: "fit-page" | "fit-width",
  sizes: [number, number][],
  rotation: Rotation,
  layout: Layout,
  viewportWidth: number,
  viewportHeight: number,
): number {
  let maxW = 0;
  let maxH = 0;
  for (const s of sizes) {
    const [w, h] = displaySize(s, rotation);
    maxW = Math.max(maxW, w);
    maxH = Math.max(maxH, h);
  }
  if (maxW <= 0 || maxH <= 0) return 1;
  const availW = Math.max(80, viewportWidth - SIDE_PAD * 2 - (isSpread(layout) ? SPREAD_GAP : 0));
  const availH = Math.max(80, viewportHeight - PAGE_GAP * 2);
  const zw = availW / ((isSpread(layout) ? 2 : 1) * maxW * PT_TO_CSS);
  const z = mode === "fit-width" ? zw : Math.min(zw, availH / (maxH * PT_TO_CSS));
  return clampZoom(Math.floor(z * 1000) / 1000);
}

export const clampZoom = (z: number) => Math.min(64, Math.max(0.08, z));

/** Rangée sous un point vertical du contenu (recherche dichotomique). */
export function rowAt(rows: Row[], y: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((rows[mid]?.top ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Boîte en points (depuis le haut à gauche de la page non tournée) vers la page affichée. */
export function rotateBox([x, y, w, h]: Box, pw: number, ph: number, rotation: Rotation): Box {
  switch (rotation) {
    case 90:
      return [ph - (y + h), x, h, w];
    case 180:
      return [pw - (x + w), ph - (y + h), w, h];
    case 270:
      return [y, pw - (x + w), h, w];
    default:
      return [x, y, w, h];
  }
}

/** Point de la page affichée (px depuis son coin haut gauche) vers la page non tournée. */
export function unrotatePoint(u: number, v: number, w: number, h: number, rotation: Rotation): [number, number] {
  // w, h : taille de la page NON tournée, dans la même unité que u, v.
  switch (rotation) {
    case 90:
      return [v, h - u];
    case 180:
      return [w - u, h - v];
    case 270:
      return [w - v, u];
    default:
      return [u, v];
  }
}

/** Transformation CSS qui tourne la page (origine en haut à gauche) dans sa boîte affichée. */
export function rotationTransform(rotation: Rotation, w: number, h: number): string | undefined {
  switch (rotation) {
    case 90:
      return `translate(${h}px, 0) rotate(90deg)`;
    case 180:
      return `translate(${w}px, ${h}px) rotate(180deg)`;
    case 270:
      return `translate(0, ${w}px) rotate(270deg)`;
    default:
      return undefined;
  }
}

import type { PdfRect, Rotation } from "./engine";
import { unrotatePoint } from "./layout";

interface R {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Convertit la sélection du navigateur en rectangles PDF, page par page (un par ligne).
 *  Chaque page porte `data-page-index`, sa taille en points dans `data-pw` / `data-ph` et la
 *  rotation de l'affichage dans `data-rot`. */
export function selectionToPageRects(root: HTMLElement): Map<number, PdfRect[]> {
  const out = new Map<number, PdfRect[]>();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return out;
  const range = sel.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-page-index]"));
  for (const page of pages) {
    const box = page.getBoundingClientRect();
    const pw = Number(page.dataset.pw);
    const ph = Number(page.dataset.ph);
    const rot = (Number(page.dataset.rot) || 0) as Rotation;
    const index = Number(page.dataset.pageIndex);
    const inPage = rects.filter((r) => r.top < box.bottom && r.bottom > box.top && r.left < box.right && r.right > box.left);
    if (inPage.length === 0) continue;
    // Taille de la page non tournée, en px CSS.
    const sideways = rot === 90 || rot === 270;
    const W = sideways ? box.height : box.width;
    const H = sideways ? box.width : box.height;
    // Rectangles ramenés sur la page non tournée (les lignes y redeviennent horizontales).
    const flat: R[] = inPage.map((r) => {
      const [x0, y0] = unrotatePoint(r.left - box.left, r.top - box.top, W, H, rot);
      const [x1, y1] = unrotatePoint(r.right - box.left, r.bottom - box.top, W, H, rot);
      return { left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) };
    });
    // Fusion par ligne : mêmes ordonnées (à 40 % de la hauteur près).
    const lines: R[] = [];
    for (const r of flat.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - r.top) < (r.bottom - r.top) * 0.4) {
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
      } else {
        lines.push({ ...r });
      }
    }
    const kx = pw / W;
    const ky = ph / H;
    out.set(
      index,
      lines.map((r) => [r.left * kx, ph - r.bottom * ky, r.right * kx, ph - r.top * ky] as PdfRect),
    );
  }
  return out;
}

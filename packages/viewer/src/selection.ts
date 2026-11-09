import type { PdfRect } from "./engine";

/** Convertit la sélection du navigateur en rectangles PDF, page par page (un par ligne).
 *  Chaque page porte `data-page-index` et la taille de page en points dans `data-pw` / `data-ph`. */
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
    const index = Number(page.dataset.pageIndex);
    const inPage = rects.filter((r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left < box.right && r.right > box.left);
    if (inPage.length === 0) continue;
    // Fusion par ligne : mêmes ordonnées (à 40 % de la hauteur près).
    const lines: DOMRect[] = [];
    for (const r of inPage.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.top - r.top) < r.height * 0.4) {
        const left = Math.min(last.left, r.left);
        const right = Math.max(last.right, r.right);
        const top = Math.min(last.top, r.top);
        const bottom = Math.max(last.bottom, r.bottom);
        lines[lines.length - 1] = new DOMRect(left, top, right - left, bottom - top);
      } else {
        lines.push(r);
      }
    }
    const kx = pw / box.width;
    const ky = ph / box.height;
    out.set(
      index,
      lines.map((r) => {
        const x0 = (r.left - box.left) * kx;
        const x1 = (r.right - box.left) * kx;
        const yTop = ph - (r.top - box.top) * ky;
        const yBottom = ph - (r.bottom - box.top) * ky;
        return [x0, yBottom, x1, yTop] as PdfRect;
      }),
    );
  }
  return out;
}

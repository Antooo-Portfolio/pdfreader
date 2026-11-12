/** Sélection du texte au clavier dans la couche de texte (Maj+flèches, Ctrl+Maj+flèches,
 *  Maj+Début / Fin).
 *
 *  `Selection.modify` du navigateur se perd dans la couche de texte : chaque mot y est placé en
 *  position absolue, et la navigation par mot ou par ligne saute ou s'annule. On se déplace donc
 *  soi-même sur la liste des mots (attributs `data-w`, `data-l` pour la ligne, `data-x` pour
 *  l'abscisse), puis on pose la sélection native : copier, surligner et lecteurs d'écran
 *  fonctionnent comme avec la souris. */

export type Direction = "forward" | "backward";
export type Granularity = "character" | "word" | "line" | "lineboundary";

interface Pos {
  w: number;
  offset: number;
}

function wordsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".pdf-text-layer [data-w]"));
}

const textOf = (el: HTMLElement | undefined) => el?.firstChild as Text | null | undefined;
const lenOf = (el: HTMLElement | undefined) => textOf(el)?.length ?? 0;
const lineKey = (el: HTMLElement | undefined) => `${el?.closest("[data-page-index]")?.getAttribute("data-page-index")}:${el?.dataset.l}`;

/** Position (mot, décalage) d'un point de la sélection, s'il est dans un mot. */
function posOf(words: HTMLElement[], node: Node | null, offset: number): Pos | null {
  if (!node) return null;
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest<HTMLElement>("[data-w]");
  if (!el) return null;
  const w = words.indexOf(el);
  if (w < 0) return null;
  return { w, offset: node.nodeType === Node.TEXT_NODE ? Math.min(offset, lenOf(el)) : 0 };
}

function lineBounds(words: HTMLElement[], w: number): [number, number] {
  const key = lineKey(words[w]);
  let a = w;
  let b = w;
  while (a > 0 && lineKey(words[a - 1]) === key) a--;
  while (b < words.length - 1 && lineKey(words[b + 1]) === key) b++;
  return [a, b];
}

function move(words: HTMLElement[], p: Pos, dir: Direction, gran: Granularity): Pos {
  const last = words.length - 1;
  const len = lenOf(words[p.w]);
  if (gran === "character") {
    if (dir === "forward") return p.offset < len ? { w: p.w, offset: p.offset + 1 } : p.w < last ? { w: p.w + 1, offset: Math.min(1, lenOf(words[p.w + 1])) } : p;
    return p.offset > 0 ? { w: p.w, offset: p.offset - 1 } : p.w > 0 ? { w: p.w - 1, offset: Math.max(0, lenOf(words[p.w - 1]) - 1) } : p;
  }
  if (gran === "word") {
    if (dir === "forward") return p.offset < len ? { w: p.w, offset: len } : p.w < last ? { w: p.w + 1, offset: lenOf(words[p.w + 1]) } : p;
    return p.offset > 0 ? { w: p.w, offset: 0 } : p.w > 0 ? { w: p.w - 1, offset: 0 } : p;
  }
  const [a, b] = lineBounds(words, p.w);
  if (gran === "lineboundary") return dir === "forward" ? { w: b, offset: lenOf(words[b]) } : { w: a, offset: 0 };
  // Ligne suivante ou précédente : le mot le plus proche à la verticale du point actuel.
  const target = dir === "forward" ? b + 1 : a - 1;
  if (target < 0 || target > last) return dir === "forward" ? { w: last, offset: lenOf(words[last]) } : { w: 0, offset: 0 };
  const [ta, tb] = lineBounds(words, target);
  const x = Number(words[p.w]?.dataset.x ?? 0);
  let best = ta;
  for (let i = ta; i <= tb; i++) if (Math.abs(Number(words[i]?.dataset.x ?? 0) - x) < Math.abs(Number(words[best]?.dataset.x ?? 0) - x)) best = i;
  return { w: best, offset: dir === "forward" ? lenOf(words[best]) : 0 };
}

/** Étend la sélection ; sans sélection dans le document, elle commence au premier mot de la page
 *  `startPage` (index 0). Renvoie false s'il n'y a pas de texte. */
export function extendSelection(root: HTMLElement, startPage: number, dir: Direction, gran: Granularity): boolean {
  const words = wordsOf(root);
  const sel = window.getSelection();
  if (!sel || words.length === 0) return false;
  let anchor = sel.rangeCount ? posOf(words, sel.anchorNode, sel.anchorOffset) : null;
  let focus = sel.rangeCount ? posOf(words, sel.focusNode, sel.focusOffset) : null;
  if (!anchor || !focus) {
    const first = root.querySelector<HTMLElement>(`[data-page-index="${startPage}"] .pdf-text-layer [data-w]`) ?? words[0];
    const w = Math.max(0, words.indexOf(first as HTMLElement));
    anchor = focus = { w, offset: 0 };
  }
  const next = move(words, focus, dir, gran);
  const an = textOf(words[anchor.w]);
  const fn = textOf(words[next.w]);
  if (!an || !fn) return false;
  sel.setBaseAndExtent(an, anchor.offset, fn, next.offset);
  words[next.w]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

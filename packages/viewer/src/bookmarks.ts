/** Modifier l'arbre des signets : fonctions pures. Un signet est désigné par son chemin
 *  (« 1.0.2 » : 3e enfant du 1er enfant du 2e signet de premier niveau). */
import type { Bookmark, OutlineItem } from "./engine";

export type Path = number[];

export const pathOf = (id: string): Path => (id === "" ? [] : id.split(".").map(Number));
export const idOf = (p: Path) => p.join(".");

export function getAt(list: Bookmark[], path: Path): Bookmark | null {
  let cur: Bookmark | undefined;
  let level = list;
  for (const i of path) {
    cur = level[i];
    if (!cur) return null;
    level = cur.children;
  }
  return cur ?? null;
}

/** Copie de l'arbre où la liste qui contient `path` est remplacée par `f(liste)`. */
function withParentList(list: Bookmark[], path: Path, f: (siblings: Bookmark[]) => Bookmark[]): Bookmark[] {
  if (path.length <= 1) return f(list);
  const [head, ...rest] = path as [number, ...number[]];
  return list.map((b, i) => (i === head ? { ...b, children: withParentList(b.children, rest, f) } : b));
}

export function update(list: Bookmark[], path: Path, patch: Partial<Bookmark>): Bookmark[] {
  const i = path[path.length - 1] ?? 0;
  return withParentList(list, path, (s) => s.map((b, j) => (j === i ? { ...b, ...patch } : b)));
}

export function remove(list: Bookmark[], path: Path): Bookmark[] {
  const i = path[path.length - 1] ?? 0;
  return withParentList(list, path, (s) => s.filter((_, j) => j !== i));
}

/** Ajoute `b` juste après `path` (au même niveau), ou à la fin si `path` est vide. Renvoie le
 *  nouvel arbre et le chemin du signet ajouté. */
export function insertAfter(list: Bookmark[], path: Path | null, b: Bookmark): [Bookmark[], Path] {
  if (!path || path.length === 0) return [[...list, b], [list.length]];
  const i = path[path.length - 1] ?? 0;
  return [withParentList(list, path, (s) => [...s.slice(0, i + 1), b, ...s.slice(i + 1)]), [...path.slice(0, -1), i + 1]];
}

/** Monte (-1) ou descend (+1) parmi ses frères ; renvoie le nouveau chemin (inchangé au bord). */
export function move(list: Bookmark[], path: Path, dir: -1 | 1): [Bookmark[], Path] {
  const i = path[path.length - 1] ?? 0;
  const parent = path.length > 1 ? getAt(list, path.slice(0, -1))?.children : list;
  const j = i + dir;
  if (!parent || j < 0 || j >= parent.length) return [list, path];
  const next = withParentList(list, path, (s) => {
    const c = [...s];
    const [x] = c.splice(i, 1);
    if (x) c.splice(j, 0, x);
    return c;
  });
  return [next, [...path.slice(0, -1), j]];
}

/** Devient le dernier enfant du signet précédent (impossible pour le premier de son niveau). */
export function indent(list: Bookmark[], path: Path): [Bookmark[], Path] {
  const i = path[path.length - 1] ?? 0;
  if (i === 0) return [list, path];
  const b = getAt(list, path);
  const prevPath = [...path.slice(0, -1), i - 1];
  const prev = getAt(list, prevPath);
  if (!b || !prev) return [list, path];
  let next = remove(list, path);
  next = update(next, prevPath, { children: [...prev.children, b] });
  return [next, [...prevPath, prev.children.length]];
}

/** Remonte d'un niveau, juste après son parent. */
export function outdent(list: Bookmark[], path: Path): [Bookmark[], Path] {
  if (path.length < 2) return [list, path];
  const b = getAt(list, path);
  if (!b) return [list, path];
  const parentPath = path.slice(0, -1);
  return insertAfter(remove(list, path), parentPath, b);
}

export function count(list: Bookmark[]): number {
  return list.reduce((n, b) => n + 1 + count(b.children), 0);
}

/** Vers le format d'écriture du moteur. */
export function toItems(list: Bookmark[]): OutlineItem[] {
  return list.map((b) => ({
    title: b.title,
    page: b.action.kind === "goto" ? b.action.page : -1,
    top: b.action.kind === "goto" ? b.action.top : null,
    uri: b.action.kind === "uri" ? b.action.uri : null,
    children: toItems(b.children),
  }));
}

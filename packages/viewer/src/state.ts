import type { DocInfo } from "./engine";

export interface OpenDoc {
  info: DocInfo;
  dirty: boolean;
  /** Version par page : incrémentée après une annotation pour recharger ses tuiles. */
  pageVersions: Record<number, number>;
}

export type Action =
  | { type: "opened"; info: DocInfo }
  | { type: "closed"; id: number }
  | { type: "annotated"; id: number; page: number }
  | { type: "saved"; id: number; generation: number; path: string; fingerprint: string };

export function reducer(docs: OpenDoc[], a: Action): OpenDoc[] {
  switch (a.type) {
    case "opened":
      return [...docs, { info: a.info, dirty: false, pageVersions: {} }];
    case "closed":
      return docs.filter((d) => d.info.id !== a.id);
    case "annotated":
      return docs.map((d) =>
        d.info.id === a.id ? { ...d, dirty: true, pageVersions: { ...d.pageVersions, [a.page]: (d.pageVersions[a.page] ?? 0) + 1 } } : d,
      );
    case "saved":
      return docs.map((d) => {
        if (d.info.id !== a.id) return d;
        const name = a.path.split(/[\\/]/).pop() ?? d.info.name;
        return { ...d, dirty: false, pageVersions: {}, info: { ...d.info, generation: a.generation, path: a.path, name, fingerprint: a.fingerprint } };
      });
  }
}

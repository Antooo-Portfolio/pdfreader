/** Contrat entre l'interface et le moteur. La coquille Tauri l'implémente (apps/desktop) ;
 *  un faux moteur peut l'implémenter pour les tests, sans toucher aux écrans. */

export type OpenErrorKind = "password_required" | "wrong_password" | "not_found" | "corrupted" | "other";

export interface OpenError {
  kind: OpenErrorKind;
  detail?: string;
}

export function isOpenError(e: unknown): e is OpenError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export interface DocInfo {
  id: number;
  path: string;
  name: string;
  title?: string | null;
  pageCount: number;
  /** Taille de chaque page en points PDF : [largeur, hauteur]. */
  pages: [number, number][];
  encrypted: boolean;
  hasForm: boolean;
  isXfa: boolean;
  generation: number;
}

/** Mot de la couche de texte, en points PDF, origine en haut à gauche. */
export interface TextWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecentFile {
  id: string;
  path: string;
  name: string;
  folder: string;
  sizeBytes: number;
  pageCount: number | null;
  starred: boolean;
  lastOpenedAt: number;
  exists: boolean;
}

export interface SaveResult {
  path: string;
  bytes: number;
  generation: number;
}

/** Rectangle en points PDF : gauche, bas, droite, haut (origine en bas à gauche). */
export type PdfRect = [number, number, number, number];

export interface EngineClient {
  launchFiles(): Promise<string[]>;
  /** Rejette avec un OpenError typé. */
  open(path: string, password?: string): Promise<DocInfo>;
  textLayer(doc: number, page: number): Promise<TextWord[][]>;
  addHighlight(doc: number, page: number, rects: PdfRect[], color: [number, number, number]): Promise<number>;
  countHighlights(doc: number, page: number): Promise<number>;
  /** Rejette avec "file_changed" ou "file_locked" dans ces deux cas. */
  save(doc: number, path?: string): Promise<SaveResult>;
  close(doc: number): void;
  recents(): Promise<RecentFile[]>;
  removeRecent(id: string): Promise<void>;
  author(): Promise<string>;
  tileUrl(doc: number, generation: number, version: number, page: number, scale: number, x: number, y: number): string;
  thumbUrl(id: string, bust: number): string;
  pickFiles(): Promise<string[]>;
  pickSavePath(defaultPath: string): Promise<string | null>;
  /** Fichiers ouverts par un second lancement (double-clic) ou déposés sur la fenêtre. */
  onExternalFiles(cb: (paths: string[]) => void): Promise<() => void>;
  /** Fermeture de la fenêtre : `cb` renvoie true pour laisser fermer. */
  onCloseRequested(cb: () => Promise<boolean>): Promise<() => void>;
  closeWindow(): Promise<void>;
  setTitle(title: string): Promise<void>;
  e2eEnabled(): Promise<boolean>;
  e2eReport(report: unknown): Promise<void>;
}

/** 100 % = taille réelle : 1 point PDF = 96/72 pixels CSS. */
export const PT_TO_CSS = 96 / 72;
export const TILE = 512;

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
  permissions: Permissions;
  /** Clé du document dans les récents et l'état de vue. */
  fingerprint: string;
  /** Dernière vue mémorisée (page, zoom, mode, rotation, panneau), s'il y en a une. */
  viewState: ViewState | null;
  generation: number;
}

/** Droits accordés par l'auteur du document. */
export interface Permissions {
  print: boolean;
  printHighQuality: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}

export type ZoomMode = "fit-page" | "fit-width" | "custom";
export type Layout = "continuous" | "single" | "double" | "continuous-double";
export type Rotation = 0 | 90 | 180 | 270;
export type PanelId = "thumbnails" | "bookmarks";

export interface ViewState {
  page: number;
  zoomMode: ZoomMode;
  zoom: number | null;
  layout: Layout;
  cover: boolean;
  rotation: Rotation;
  panel: PanelId | null;
}

/** Aller à une page (index 0, ordonnée du haut en points si connue) ou ouvrir une adresse. */
export type LinkAction = { kind: "goto"; page: number; top: number | null } | { kind: "uri"; uri: string } | { kind: "none" };

/** Lien d'une page, en points depuis le haut à gauche. */
export interface PageLink {
  x: number;
  y: number;
  w: number;
  h: number;
  action: LinkAction;
}

export interface Bookmark {
  title: string;
  action: LinkAction;
  children: Bookmark[];
}

/** [x, y, largeur, hauteur] en points depuis le haut à gauche. */
export type Box = [number, number, number, number];

export interface SearchBatch {
  /** Un résultat = une ou plusieurs boîtes (coupé sur plusieurs lignes). */
  pages: { page: number; hits: Box[][] }[];
  pagesWithText: number;
}

export type Theme = "system" | "light" | "dark" | "contrast";

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
  fingerprint: string;
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
  links(doc: number, page: number): Promise<PageLink[]>;
  bookmarks(doc: number): Promise<Bookmark[]>;
  /** Cherche dans les pages from..from+count (lots courts : le rendu passe entre deux lots). */
  search(doc: number, from: number, count: number, query: string, matchCase: boolean, wholeWord: boolean): Promise<SearchBatch>;
  setViewState(fingerprint: string, state: ViewState): Promise<void>;
  preferences(): Promise<Record<string, unknown>>;
  setPreference(key: string, value: unknown): Promise<void>;
  /** Ouvre une adresse http(s) ou mailto dans le navigateur par défaut. */
  openUrl(url: string): Promise<void>;
  /** Thème de la barre de titre de la fenêtre (null : celui du système). */
  setWindowTheme(theme: "light" | "dark" | null): Promise<void>;
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

/** Largeur des vignettes (px CSS). */
export const THUMB_WIDTH = 120;

/** Échelle de la vignette d'une page : une seule tuile, partagée avec l'aperçu flou affiché
 *  pendant le rendu de la page (même URL, donc même image en cache). */
export function thumbScale(pw: number, ph: number, dpr: number): number {
  const s = Math.min((THUMB_WIDTH * dpr) / pw, (TILE - 2) / ph, (TILE - 2) / pw);
  return Math.round(s * 10000) / 10000;
}

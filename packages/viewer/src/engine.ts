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
  /** Nombre de pièces jointes. */
  attachmentCount: number;
  /** Fichier téléchargé (marque du Web) : ouvert en vue protégée si la préférence est active. */
  fromInternet: boolean;
  /** Les signets peuvent être modifiés (document non chiffré). */
  bookmarksEditable: boolean;
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
export type PanelId = "thumbnails" | "bookmarks" | "comments" | "attachments" | "search";

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

/** Signet à écrire : page (index 0, -1 : aucune), haut de la vue en points depuis le haut. */
export interface OutlineItem {
  title: string;
  page: number;
  top: number | null;
  uri: string | null;
  children: OutlineItem[];
}

/** [x, y, largeur, hauteur] en points depuis le haut à gauche. */
export type Box = [number, number, number, number];

export interface SearchBatch {
  /** Un résultat = une ou plusieurs boîtes (coupé sur plusieurs lignes). */
  pages: { page: number; hits: Box[][] }[];
  pagesWithText: number;
}

export type Theme = "system" | "light" | "dark" | "contrast";

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
  /** Sait imprimer en recto verso. */
  duplex: boolean;
}

export type PrintScale = "fit" | "actual" | "shrink" | "custom";
export type PrintOrientation = "auto" | "portrait" | "landscape";
export type PrintDuplex = "none" | "long" | "short";

export interface PrintOptions {
  printer: string;
  /** Pages à imprimer, dans l'ordre (index 0). */
  pages: number[];
  scale: PrintScale;
  /** Pourcentage, pour l'échelle « custom ». */
  customScale: number;
  orientation: PrintOrientation;
  duplex: PrintDuplex;
  copies: number;
  /** Imprimer les commentaires ; les champs et « Remplir et signer » sont toujours imprimés. */
  comments: boolean;
  /** Fichier de sortie (tests seulement ; ignoré en usage normal). */
  outputFile?: string | null;
  title?: string;
}

/** Copie de récupération laissée par une fermeture inattendue. */
export interface RecoveryItem {
  id: string;
  originalPath: string;
  name: string;
  createdAt: number;
}

export type AnnotKind =
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "note"
  | "ink"
  | "freetext"
  | "line"
  | "square"
  | "circle"
  | "polygon"
  | "polyline"
  | "stamp"
  | "arrow"
  | "cloud"
  | "text"
  | "mark"
  | "signature"
  | "textbox"
  | "callout"
  | "other";

export type Rgb = [number, number, number];

/** Commentaire d'une page. Coordonnées en points depuis le haut à gauche de la page. */
export interface Annot {
  /** /NM du commentaire, ou « #rang » s'il n'en a pas (valable jusqu'à la prochaine modification). */
  id: string;
  page: number;
  kind: AnnotKind;
  rect: Box;
  /** Zones d'un surlignage, souligné ou barré (une par ligne). */
  boxes: Box[];
  /** Tracés d'un dessin. */
  strokes: [number, number][][];
  color: Rgb | null;
  opacity: number;
  width: number;
  contents: string;
  author: string;
  /** Dates PDF brutes (« D:20261109183000+01'00' »). */
  modified: string | null;
  created: string | null;
  replyTo: string | null;
  locked: boolean;
  /** Taille du texte d'un tampon « texte ». */
  fontSize: number | null;
  /** Zone de texte ou légende : cadre [x, y, largeur, hauteur minimale] et point désigné. */
  textBox: Box | null;
  anchor: [number, number] | null;
  filled: boolean;
  /** Statut de révision, null si aucun. */
  status: ReviewStatus | null;
  /** Coché dans la liste des commentaires. */
  marked: boolean;
  /** Intérieur d'un rectangle ou d'une ellipse. */
  fill: Rgb | null;
}

export type ReviewStatus = "accepted" | "rejected" | "cancelled" | "completed";
export type ShapeKind = "square" | "circle" | "line" | "arrow" | "polygon" | "polyline" | "cloud";
export type StampPreset = "approved" | "notApproved" | "draft" | "final" | "confidential" | "forComment" | "forPublicRelease" | "notForPublicRelease" | "expired";

export type FieldKind = "text" | "checkbox" | "radio" | "combo" | "list" | "button" | "signature" | "unknown";

/** Champ de formulaire (un widget). Coordonnées en points depuis le haut à gauche. */
export interface Field {
  /** Rang de l'annotation sur la page : identifiant pour la saisie. */
  index: number;
  page: number;
  name: string;
  /** Nom lisible (infobulle du champ), sinon le nom technique. */
  label: string;
  kind: FieldKind;
  rect: Box;
  value: string;
  checked: boolean;
  exportValue: string;
  options: { label: string; selected: boolean }[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  password: boolean;
  editableCombo: boolean;
  multiSelect: boolean;
  comb: boolean;
  /** 0 : taille automatique. */
  fontSize: number;
}

/** Effets des scripts du formulaire après une saisie. */
export interface FormOutcome {
  /** Pages dont des champs ont été recalculés. */
  changedPages: number[];
  /** Saisie refusée (valeur rétablie) : « number », « range:min:max », « min:x », « max:x »,
   *  « message:texte » ou « invalid ». */
  rejected: string | null;
  alerts: string[];
  scriptErrors: number;
}

export interface SetFieldResult {
  fields: Field[];
  outcome: FormOutcome;
}

export type FieldInput = { kind: "text"; value: string } | { kind: "checked"; checked: boolean } | { kind: "choice"; index: number };

export type SignatureKind = "signature" | "initials";

export interface SavedSignature {
  kind: SignatureKind;
  method: "typed" | "drawn" | "image";
  /** Image PNG (data URL). */
  data: string;
  font: string | null;
  updatedAt: number;
}

export interface AnnotResult {
  /** Commentaire créé, le cas échéant. */
  id: string | null;
  /** Liste à jour des commentaires de la page. */
  annots: Annot[];
}

export interface AnnotPatch {
  color?: Rgb;
  opacity?: number;
  width?: number;
  contents?: string;
}

export type MarkupKind = "highlight" | "underline" | "strikeout";

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

/** Pièce jointe du document (nom déjà nettoyé : jamais de chemin). */
export interface Attachment {
  index: number;
  name: string;
  size: number;
}

/** Résultat de la recherche avancée : page (index 0), rectangles en points depuis le haut, extrait. */
export interface SnippetHit {
  page: number;
  rects: Box[];
  before: string;
  matched: string;
  after: string;
}

/** Propriétés du document (S15). Dates PDF brutes. */
export interface DocProperties {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  created: string;
  modified: string;
  version: string | null;
  pageCount: number;
  pageSize: [number, number] | null;
  fileSize: number;
  tagged: boolean;
  linearized: boolean;
  /** Révision du chiffrement, null si le document n'est pas protégé. */
  securityRevision: number | null;
  fonts: { name: string; embedded: boolean; subset: boolean }[];
  /** Pages parcourues pour lister les polices. */
  fontsPages: number;
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
  annotations(doc: number, page: number): Promise<AnnotResult>;
  /** Rectangles en points PDF (origine en bas à gauche), un par ligne. */
  addMarkup(doc: number, page: number, kind: MarkupKind, rects: PdfRect[], color: Rgb, opacity: number): Promise<AnnotResult>;
  /** Note dont le coin haut gauche est en (x, y), points depuis le haut. */
  addNote(doc: number, page: number, x: number, y: number, contents: string, color: Rgb): Promise<AnnotResult>;
  addInk(doc: number, page: number, strokes: [number, number][][], color: Rgb, opacity: number, width: number): Promise<AnnotResult>;
  /** Forme : points depuis le haut à gauche (deux coins pour un rectangle ou une ellipse). */
  addShape(doc: number, page: number, kind: ShapeKind, points: [number, number][], color: Rgb, opacity: number, width: number, fill: Rgb | null): Promise<AnnotResult>;
  /** Tampon prédéfini centré en (x, y) ; `label` déjà traduit, `subtitle` facultatif (nom, date). */
  addStamp(doc: number, page: number, x: number, y: number, preset: StampPreset, label: string, subtitle: string | null): Promise<AnnotResult>;
  addReply(doc: number, page: number, parent: string, contents: string): Promise<AnnotResult>;
  /** Statut ("" : aucun) et coche ; null : inchangé. */
  setStatus(doc: number, page: number, id: string, status: ReviewStatus | "" | null, marked: boolean | null): Promise<AnnotResult>;
  updateAnnot(doc: number, page: number, id: string, patch: AnnotPatch): Promise<AnnotResult>;
  fields(doc: number, page: number): Promise<Field[]>;
  /** Saisie dans un champ ; renvoie les champs à jour de la page. */
  /** Saisie ; avec `scripts`, les calculs et validations du formulaire s'exécutent (isolés). */
  setField(doc: number, page: number, index: number, input: FieldInput, scripts: boolean): Promise<SetFieldResult>;
  /** Texte posé sur la page (formulaire plat), coin haut gauche en (x, y). */
  addText(doc: number, page: number, x: number, y: number, text: string, size: number, color: Rgb): Promise<AnnotResult>;
  addMark(doc: number, page: number, x: number, y: number, size: number, cross: boolean, color: Rgb): Promise<AnnotResult>;
  /** Zone de texte encadrée [x, y, largeur, hauteur minimale] ; avec `anchor`, légende. */
  addTextBox(doc: number, page: number, rect: Box, text: string, size: number, color: Rgb, filled: boolean, anchor: [number, number] | null): Promise<AnnotResult>;
  /** Pose la signature mémorisée dans le rectangle [x, y, largeur, hauteur]. */
  addSignature(doc: number, page: number, rect: Box, kind: SignatureKind): Promise<AnnotResult>;
  signature(kind: SignatureKind): Promise<SavedSignature | null>;
  setSignature(kind: SignatureKind, method: SavedSignature["method"], data: string, font: string | null): Promise<void>;
  deleteSignature(kind: SignatureKind): Promise<void>;
  deleteAnnot(doc: number, page: number, id: string): Promise<AnnotResult>;
  countHighlights(doc: number, page: number): Promise<number>;
  links(doc: number, page: number): Promise<PageLink[]>;
  bookmarks(doc: number): Promise<Bookmark[]>;
  /** Remplace les signets ; écrits au prochain enregistrement. Rejette avec « encrypted ». */
  setBookmarks(doc: number, items: OutlineItem[]): Promise<void>;
  properties(doc: number): Promise<DocProperties>;
  attachments(doc: number): Promise<Attachment[]>;
  /** Enregistre une pièce jointe (emplacement choisi par l'utilisateur, ou `path`) ; null si annulé. */
  saveAttachment(doc: number, index: number, name: string, path?: string): Promise<number | null>;
  /** Copie une pièce jointe PDF pour l'ouvrir dans PDFReader ; renvoie son chemin. Rejette avec
   *  « not_pdf » pour tout autre fichier. */
  attachmentPdfPath(doc: number, index: number): Promise<string>;
  /** Recherche avec extraits, pages from..from+count ; `already` : résultats déjà trouvés. */
  searchSnippets(doc: number, from: number, count: number, query: string, matchCase: boolean, wholeWord: boolean, already: number): Promise<{ hits: SnippetHit[]; truncated: boolean }>;
  /** Cherche dans les pages from..from+count (lots courts : le rendu passe entre deux lots). */
  search(doc: number, from: number, count: number, query: string, matchCase: boolean, wholeWord: boolean): Promise<SearchBatch>;
  setViewState(fingerprint: string, state: ViewState): Promise<void>;
  preferences(): Promise<Record<string, unknown>>;
  setPreference(key: string, value: unknown): Promise<void>;
  /** Ouvre une adresse http(s) ou mailto dans le navigateur par défaut. */
  openUrl(url: string): Promise<void>;
  /** Plein écran de la fenêtre. */
  setFullscreen(on: boolean): Promise<void>;
  /** Exporte les préférences (fichier choisi par l'utilisateur, ou `path`) ; null si annulé. */
  exportPreferences(path?: string): Promise<number | null>;
  /** Importe des préférences exportées ; null si annulé. Rejette avec « invalid_file ». */
  importPreferences(path?: string): Promise<number | null>;
  /** Thème de la barre de titre de la fenêtre (null : celui du système). */
  setWindowTheme(theme: "light" | "dark" | null): Promise<void>;
  /** Rejette avec "file_changed" ou "file_locked" dans ces deux cas. */
  save(doc: number, path?: string): Promise<SaveResult>;
  close(doc: number): void;
  recents(): Promise<RecentFile[]>;
  removeRecent(id: string): Promise<void>;
  starRecent(id: string, starred: boolean): Promise<void>;
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
  /** Pause (ms) demandée par l'outil de capture pendant le scénario (0 : aucune). */
  e2ePause(): Promise<number>;
  /** Étape du scénario demandée par l'outil de test (« crash », « recover »), sinon "". */
  e2eStage(): Promise<string>;

  printers(): Promise<PrinterInfo[]>;
  /** Taille de la feuille par défaut de l'imprimante (points, en portrait), pour l'aperçu. */
  printerSheet(name: string): Promise<[number, number] | null>;
  /** Imprime ; renvoie le nombre de pages envoyées. Rejette avec « print_cancelled »,
   *  « print_forbidden » ou « print_busy » dans ces cas. */
  print(doc: number, options: PrintOptions): Promise<number>;
  cancelPrint(): Promise<void>;
  onPrintProgress(cb: (done: number, total: number) => void): Promise<() => void>;

  /** Le fichier a-t-il été modifié ou supprimé par un autre programme depuis l'ouverture ? */
  changedOnDisk(doc: number): Promise<boolean>;
  /** Relit le fichier depuis le disque (les modifications en mémoire sont abandonnées). */
  reload(doc: number): Promise<DocInfo>;

  recoverySnapshot(doc: number, path: string, fingerprint: string): Promise<void>;
  recoveryClear(path: string): Promise<void>;
  recoveryList(): Promise<RecoveryItem[]>;
  /** Rouvre la copie à la place du document d'origine (rejette avec un OpenError typé). */
  recoveryRestore(id: string, password?: string): Promise<DocInfo>;
  recoveryDiscard(id: string): Promise<void>;

  resetPreferences(): Promise<void>;
  /** Contrat de licence, mentions des composants tiers (texte) ou leur résumé (JSON). */
  legalDocument(name: "licence" | "notices" | "summary"): Promise<string>;
  appInfo(): Promise<{ name: string; version: string; pdfium: string; dataDir: string }>;
  /** Recherche une mise à jour (seulement avec l'accord de l'utilisateur). null : à jour. */
  updateCheck(): Promise<{ version: string; notes: string | null; date: string | null } | null>;
  /** Télécharge, vérifie, installe et redémarre. */
  updateInstall(): Promise<void>;
  onUpdateProgress(cb: (done: number, total: number | null) => void): Promise<() => void>;

  /** Ouvre une page des Paramètres de Windows. */
  openSettings(page: "defaultapps" | "printers"): Promise<void>;
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

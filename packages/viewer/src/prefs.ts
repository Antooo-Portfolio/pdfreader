import { t } from "@pdfreader/ui";
/** Préférences de l'application (S14) et petites fonctions pures de l'impression (S13). */
import type { Layout, PrintDuplex, PrintOrientation, PrintScale, Theme } from "./engine";

export type DefaultZoom = "fit-width" | "fit-page" | "actual";

export interface Prefs {
  theme: Theme;
  /** Langue de l'interface ; « system » : celle de Windows. */
  language: "system" | "fr" | "en";
  /** Taille de l'interface (taille de police racine), en pour cent. */
  uiScale: number;
  defaultZoom: DefaultZoom;
  defaultLayout: Layout;
  /** Raccourcis à une touche (V, U, N, D, E, T, S). Désactivables : ils gênent certaines aides
   *  techniques et la saisie au clavier vocal. */
  singleKeys: boolean;
  /** Copies de récupération des modifications non enregistrées. */
  recovery: boolean;
  recoveryMinutes: number;
  /** Rouvrir chaque document à la page, au zoom et au mode où on l'a laissé. */
  restoreView: boolean;
  /** Mises à jour : « ask » tant que l'utilisateur n'a pas répondu ; aucune connexion sans « auto ». */
  updates: "ask" | "auto" | "off";
  /** Dernière vérification automatique (ms). */
  updatesLastCheck: number;
  /** Fichiers venus d'Internet ouverts en vue protégée (modification désactivée). */
  protectedView: boolean;
  /** Outils retirés de la barre d'outils (toujours accessibles au clavier). */
  hiddenTools: string[];
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  language: "system",
  uiScale: 100,
  defaultZoom: "fit-width",
  defaultLayout: "continuous",
  singleKeys: true,
  recovery: true,
  recoveryMinutes: 2,
  restoreView: true,
  updates: "ask",
  updatesLastCheck: 0,
  protectedView: true,
  hiddenTools: [],
};

export const UI_SCALES = [87.5, 100, 112.5, 125, 150, 175, 200];
export const RECOVERY_MINUTES = [1, 2, 5, 10];

/** Préférences lues dans la base : seules les valeurs valides sont gardées. */
export function parsePrefs(raw: Record<string, unknown>): Prefs {
  const p = { ...DEFAULT_PREFS };
  const t = raw.theme;
  if (t === "system" || t === "light" || t === "dark" || t === "contrast") p.theme = t;
  if (raw.language === "system" || raw.language === "fr" || raw.language === "en") p.language = raw.language;
  if (typeof raw.uiScale === "number" && UI_SCALES.includes(raw.uiScale)) p.uiScale = raw.uiScale;
  if (raw.defaultZoom === "fit-width" || raw.defaultZoom === "fit-page" || raw.defaultZoom === "actual") p.defaultZoom = raw.defaultZoom;
  if (raw.defaultLayout === "continuous" || raw.defaultLayout === "single" || raw.defaultLayout === "double" || raw.defaultLayout === "continuous-double") p.defaultLayout = raw.defaultLayout;
  if (typeof raw.singleKeys === "boolean") p.singleKeys = raw.singleKeys;
  if (typeof raw.recovery === "boolean") p.recovery = raw.recovery;
  if (typeof raw.recoveryMinutes === "number" && RECOVERY_MINUTES.includes(raw.recoveryMinutes)) p.recoveryMinutes = raw.recoveryMinutes;
  if (typeof raw.restoreView === "boolean") p.restoreView = raw.restoreView;
  if (raw.updates === "ask" || raw.updates === "auto" || raw.updates === "off") p.updates = raw.updates;
  if (typeof raw.updatesLastCheck === "number") p.updatesLastCheck = raw.updatesLastCheck;
  if (typeof raw.protectedView === "boolean") p.protectedView = raw.protectedView;
  if (Array.isArray(raw.hiddenTools)) p.hiddenTools = raw.hiddenTools.filter((x): x is string => typeof x === "string" && x !== "select").slice(0, 32);
  return p;
}

/* ---------------------------------------------------------------- impression */

/** Réglages d'impression mémorisés d'une fois sur l'autre (sans les pages). */
export interface PrintSettings {
  printer: string;
  scale: PrintScale;
  customScale: number;
  orientation: PrintOrientation;
  duplex: PrintDuplex;
  copies: number;
  comments: boolean;
}

export const DEFAULT_PRINT: PrintSettings = { printer: "", scale: "fit", customScale: 100, orientation: "auto", duplex: "none", copies: 1, comments: true };

export function parsePrintSettings(raw: unknown): PrintSettings {
  const p = { ...DEFAULT_PRINT };
  if (!raw || typeof raw !== "object") return p;
  const r = raw as Record<string, unknown>;
  if (typeof r.printer === "string") p.printer = r.printer;
  if (r.scale === "fit" || r.scale === "actual" || r.scale === "shrink" || r.scale === "custom") p.scale = r.scale;
  if (typeof r.customScale === "number" && r.customScale >= 10 && r.customScale <= 400) p.customScale = r.customScale;
  if (r.orientation === "auto" || r.orientation === "portrait" || r.orientation === "landscape") p.orientation = r.orientation;
  if (r.duplex === "none" || r.duplex === "long" || r.duplex === "short") p.duplex = r.duplex;
  if (typeof r.comments === "boolean") p.comments = r.comments;
  return p;
}

/** Plage de pages tapée par l'utilisateur (« 1-3, 5, 8- », pages à partir de 1) vers une liste
 *  d'index (à partir de 0), dans l'ordre donné, sans doublon. Renvoie un message d'erreur si la
 *  saisie n'est pas comprise. */
export function parseRange(text: string, total: number): number[] | string {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return t("Indiquez au moins une page.");
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const m = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(part);
    if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) return t("« {part} » n'est pas une page ni une plage (exemple : 1-3, 5, 8-).", { part });
    const isRange = part.includes("-") || part.includes("–");
    const a = m[1] ? Number(m[1]) : 1;
    const b = isRange ? (m[2] ? Number(m[2]) : total) : a;
    if (a < 1 || b < 1 || a > total || b > total) return t(total > 1 ? "Ce document a {total} pages : « {part} » est en dehors." : "Ce document a {total} page : « {part} » est en dehors.", { total, part });
    const step = a <= b ? 1 : -1;
    for (let p = a; step > 0 ? p <= b : p >= b; p += step) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p - 1);
      }
    }
  }
  return out;
}

export type PageSubset = "all" | "odd" | "even";

/** Garde les pages impaires ou paires (numérotées à partir de 1) d'une liste d'index. */
export function subset(pages: number[], which: PageSubset): number[] {
  if (which === "all") return pages;
  return pages.filter((i) => ((i + 1) % 2 === 1) === (which === "odd"));
}

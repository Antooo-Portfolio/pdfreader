/** Traduction de l'interface (FR, EN).
 *
 *  Les clés sont les phrases françaises elles-mêmes (comme les identifiants de message de
 *  Lingui) : `t("Imprimer")` rend « Imprimer » ou « Print ». Une phrase sans traduction reste en
 *  français : rien ne casse, et le contrôle `npm run i18n:check` liste les manques.
 *  Variables : `t("Page {n} sur {total}", { n, total })`.
 *
 *  Les constantes définies au chargement d'un module (listes d'options, libellés) marquent leurs
 *  phrases avec `msg()` et sont traduites à l'affichage avec `t()`. */
import en from "./locales/en.json";

export type Language = "fr" | "en";

const catalogs: Record<Exclude<Language, "fr">, Record<string, string>> = { en };

let current: Language = "fr";

export function getLanguage(): Language {
  return current;
}

/** Change la langue (l'appelant fait ensuite un nouveau rendu de l'application). */
export function setLanguage(lang: Language) {
  current = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

/** Langue du système : français si Windows est en français, anglais sinon. */
export function systemLanguage(): Language {
  const l = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "fr";
  return l.startsWith("fr") ? "fr" : "en";
}

export function t(fr: string, vars?: Record<string, string | number>): string {
  const s = current === "fr" ? fr : (catalogs[current][fr] ?? fr);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Marque une phrase à traduire plus tard (constantes de module) : la rend telle quelle. */
export function msg(fr: string): string {
  return fr;
}

/** Nombre au format de la langue (séparateurs). */
export function formatNumber(n: number): string {
  return n.toLocaleString(current === "fr" ? "fr-FR" : "en-GB");
}

export function locale(): string {
  return current === "fr" ? "fr-FR" : "en-GB";
}

/** Noms des touches dans un raccourci affiché (« Ctrl+Maj+→ » → « Ctrl+Shift+→ »). */
const KEYS_EN: Record<string, string> = { Maj: "Shift", Échap: "Esc", Entrée: "Enter", Suppr: "Del", Début: "Home", Fin: "End", "Pg préc.": "PgUp", "Pg suiv.": "PgDn", Espace: "Space" };

/** Raccourci au format de l'attribut aria-keyshortcuts (« Ctrl+Maj+→ » → « Control+Shift+ArrowRight »). */
const KEYS_ARIA: Record<string, string> = {
  Ctrl: "Control",
  Maj: "Shift",
  Alt: "Alt",
  Échap: "Escape",
  Entrée: "Enter",
  Suppr: "Delete",
  Début: "Home",
  Fin: "End",
  "→": "ArrowRight",
  "←": "ArrowLeft",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "=": "Equal",
  "-": "Minus",
};

export function ariaShortcut(s: string): string {
  return s
    .split("+")
    .map((k) => KEYS_ARIA[k] ?? k)
    .join("+");
}

export function shortcutLabel(s: string): string {
  if (current === "fr") return s;
  return s
    .split("+")
    .map((k) => KEYS_EN[k] ?? k)
    .join("+");
}

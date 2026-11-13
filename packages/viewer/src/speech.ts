/** Lecture à voix haute par la synthèse vocale de Windows (Web Speech API de WebView2) : aucune
 *  donnée ne quitte l'ordinateur avec les voix installées localement. */
import { getLanguage } from "@pdfreader/ui";
import type { TextWord } from "./engine";

export const speechAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** Texte lisible d'une page, à partir de sa couche de texte. */
export function pageText(lines: TextWord[][]): string {
  return lines
    .map((l) => l.map((w) => w.t).join("").trim())
    .filter(Boolean)
    .join("\n");
}

/** Découpe en morceaux de taille raisonnable, aux fins de phrase si possible : les voix de
 *  Windows coupent parfois les textes trop longs. */
export function chunks(text: string, max = 240): string[] {
  const out: string[] = [];
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?;:…]+[.!?;:…]*\s*/g) ?? [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function voiceFor(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.slice(0, 2);
  return voices.find((v) => v.lang === lang && v.localService) ?? voices.find((v) => v.lang.startsWith(base) && v.localService) ?? voices.find((v) => v.lang.startsWith(base));
}

/** Lit `text` ; `done` est appelé à la fin (pas en cas d'arrêt). Renvoie une fonction d'arrêt. */
export function speak(text: string, done: () => void): () => void {
  const synth = window.speechSynthesis;
  const lang = getLanguage() === "en" ? "en-US" : "fr-FR";
  const voice = voiceFor(lang);
  const parts = chunks(text);
  let stopped = false;
  synth.cancel();
  if (parts.length === 0) {
    queueMicrotask(done);
    return () => undefined;
  }
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    if (i === parts.length - 1)
      u.onend = () => {
        if (!stopped) done();
      };
    synth.speak(u);
  });
  return () => {
    stopped = true;
    synth.cancel();
  };
}

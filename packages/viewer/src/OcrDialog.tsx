/** Phase 2, « Reconnaître le texte (OCR) » : les pages choisies sont lues par l'OCR intégré à
 *  Windows (hors ligne) et reçoivent une couche de texte invisible : la page garde son aspect mais
 *  devient cherchable, sélectionnable et copiable. Progression page par page, annulable ;
 *  l'ensemble s'annule en une fois (notification). */
import { t, Button, Checkbox, Dialog, locale, ProgressBar, RadioGroup, Select, TextField, useToast } from "@pdfreader/ui";
import { useEffect, useRef, useState } from "react";
import type { DocInfo, EngineClient, OcrLanguage, OcrResult } from "./engine";
import { parseRange } from "./prefs";

export function OcrDialog({
  engine,
  info,
  currentPage,
  onDone,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Page affichée (à partir de 1). */
  currentPage: number;
  /** Fin de série : document à jour, message à afficher (annulable), mots reconnus en tout. */
  onDone: (r: OcrResult, message: string, words: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [langs, setLangs] = useState<OcrLanguage[] | null>(null);
  const [lang, setLang] = useState("");
  const [which, setWhich] = useState<"all" | "current" | "range">(info.pageCount > 1 ? "all" : "current");
  const [range, setRange] = useState("");
  const [skipText, setSkipText] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    let live = true;
    void engine
      .ocr(info.id, { kind: "languages" })
      .then((r) => {
        if (!live) return;
        setLangs(r.languages);
        const mine = locale().slice(0, 2);
        setLang((r.languages.find((l) => l.tag.toLowerCase().startsWith(mine)) ?? r.languages[0])?.tag ?? "");
      })
      .catch(() => live && setLangs([]));
    return () => {
      live = false;
    };
  }, [engine, info.id]);

  const pages: number[] | string = which === "all" ? info.pages.map((_, i) => i) : which === "current" ? [currentPage - 1] : parseRange(range, info.pageCount);
  const rangeError = typeof pages === "string" && which === "range" && range.trim() ? pages : null;
  const busy = progress !== null;
  const unavailable = langs !== null && langs.length === 0;

  const run = async () => {
    if (typeof pages === "string" || !pages.length || !lang) return;
    cancel.current = false;
    setProgress({ done: 0, total: pages.length });
    let words = 0;
    let read = 0;
    let skipped = 0;
    let started = false;
    let failure: string | null = null;
    for (const [k, p] of pages.entries()) {
      if (cancel.current) break;
      try {
        const r = await engine.ocr(info.id, { kind: "page", page: p, lang, first: k === 0, skipText });
        started = true;
        if (r.skipped) skipped++;
        else {
          read++;
          words += r.words;
        }
      } catch (e) {
        failure = String(e);
        break;
      }
      setProgress({ done: k + 1, total: pages.length });
    }
    if (started) {
      try {
        const r = await engine.ocr(info.id, { kind: "finish" });
        const parts = [
          words === 0
            ? t("Aucun texte reconnu.")
            : read === 1
              ? t("{words} mots reconnus.", { words })
              : t("{words} mots reconnus sur {pages} pages.", { words, pages: read }),
          ...(skipped === 1 ? [t("Une page avait déjà du texte et est restée telle quelle.")] : skipped > 1 ? [t("{count} pages avaient déjà du texte et sont restées telles quelles.", { count: skipped })] : []),
          ...(cancel.current ? [t("Reconnaissance arrêtée.")] : []),
        ];
        onDone(r, parts.join(" "), words);
      } catch (e) {
        failure ??= String(e);
      }
    }
    if (failure) {
      toast({
        tone: "error",
        message: failure.includes("modify_forbidden")
          ? t("L'auteur de ce document interdit d'en modifier le contenu.")
          : failure.includes("ocr_unavailable") || failure.includes("ocr_language")
            ? t("L'OCR de Windows n'est pas disponible pour cette langue. Ajoutez la langue dans les paramètres de Windows (Heure et langue), puis réessayez.")
            : t("La reconnaissance du texte a échoué : {detail}", { detail: failure }),
      });
      setProgress(null);
      if (!started) return;
    }
    onClose();
  };

  return (
    <Dialog
      title={t("Reconnaître le texte (OCR)")}
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      footer={(close) => (
        <>
          {busy ? <Button onPress={() => (cancel.current = true)}>{t("Arrêter")}</Button> : <Button onPress={close}>{t("Annuler")}</Button>}
          <Button variant="primary" onPress={() => void run()} isPending={busy} isDisabled={unavailable || !lang || typeof pages === "string" || !pages.length}>
            {t("Reconnaître")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-base" data-ocr>
        {unavailable ? (
          <p className="text-sm text-danger">{t("Aucune langue de reconnaissance n'est installée dans Windows. Ajoutez une langue dans les paramètres de Windows (Heure et langue), puis rouvrez cette boîte.")}</p>
        ) : (
          <Select
            label={t("Langue du document")}
            options={(langs ?? []).map((l) => ({ id: l.tag, label: l.name }))}
            selectedKey={lang || null}
            onSelectionChange={(k) => setLang(String(k))}
            isDisabled={busy || !langs}
            className="w-72"
          />
        )}
        <div className="flex flex-col gap-1">
          <RadioGroup
            label={t("Pages")}
            value={which}
            onChange={(v) => setWhich(v as typeof which)}
            isDisabled={busy}
            options={[
              { id: "all", label: t("Toutes les pages ({count})", { count: info.pageCount }) },
              { id: "current", label: t("Page affichée ({page})", { page: currentPage }) },
              { id: "range", label: t("Pages :") },
            ]}
          />
          {which === "range" && (
            <TextField aria-label={t("Pages à reconnaître")} placeholder={t("par exemple 1-3, 5")} value={range} onChange={setRange} isDisabled={busy} errorMessage={rangeError ?? undefined} isInvalid={!!rangeError} className="ml-6 max-w-60" />
          )}
        </div>
        <Checkbox isSelected={skipText} onChange={setSkipText} isDisabled={busy}>
          {t("Laisser telles quelles les pages qui ont déjà du texte")}
        </Checkbox>
        <p className="text-sm text-muted">
          {t("La reconnaissance se fait sur cet ordinateur, rien n'est envoyé. La page garde son aspect ; son texte devient cherchable, sélectionnable et copiable.")}
        </p>
        {busy && progress && <ProgressBar label={t("Page {done} sur {total}", { done: progress.done, total: progress.total })} value={(progress.done / progress.total) * 100} />}
      </div>
    </Dialog>
  );
}

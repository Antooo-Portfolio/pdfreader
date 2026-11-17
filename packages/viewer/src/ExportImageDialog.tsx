/** Phase 2, « Exporter en image » : pages choisies en PNG ou JPEG, résolution, qualité, avec ou
 *  sans commentaires. Une page : un fichier choisi ; plusieurs : un dossier, « nom - page 001.png »…
 *  Progression page par page, annulable. */
import { t, Button, Checkbox, Dialog, ProgressBar, RadioGroup, Select, Slider, TextField, useToast } from "@pdfreader/ui";
import { useRef, useState } from "react";
import type { DocInfo, EngineClient, ImageFormat } from "./engine";
import { rangesLabel } from "./OrganizeView";
import { parseRange } from "./prefs";

const DPIS = [72, 150, 300, 600];

export function ExportImageDialog({
  engine,
  info,
  currentPage,
  chosen,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Page affichée (à partir de 1). */
  currentPage: number;
  /** Pages choisies dans « Organiser les pages » (index à partir de 0), s'il y en a. */
  chosen?: number[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [which, setWhich] = useState<"chosen" | "current" | "all" | "range">(chosen?.length ? "chosen" : "current");
  const [range, setRange] = useState("");
  const [format, setFormat] = useState<ImageFormat>("png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(85);
  const [annotations, setAnnotations] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancel = useRef(false);

  const pages: number[] | string =
    which === "chosen" ? (chosen ?? []) : which === "current" ? [currentPage - 1] : which === "all" ? info.pages.map((_, i) => i) : parseRange(range, info.pageCount);
  const error = typeof pages === "string" && which === "range" && range.trim() ? pages : null;
  const ext = format === "png" ? "png" : "jpg";
  const stem = info.name.replace(/\.pdf$/i, "");
  const folderOf = (p: string) => p.replace(/[^\\/]+$/, "");
  const busy = progress !== null;

  const run = async () => {
    if (typeof pages === "string" || !pages.length) return;
    let target: string | null;
    const single = pages.length === 1;
    if (single) {
      target = await engine.pickImagePath(folderOf(info.path) + t("{name} - page {page}", { name: stem, page: (pages[0] ?? 0) + 1 }) + "." + ext, format);
    } else {
      target = await engine.pickFolder();
    }
    if (!target) return;
    cancel.current = false;
    setProgress({ done: 0, total: pages.length });
    const width = String(info.pageCount).length < 3 ? 3 : String(info.pageCount).length;
    let last = "";
    let done = 0;
    try {
      for (const p of pages) {
        if (cancel.current) break;
        const path = single ? target : `${target.replace(/[\\/]$/, "")}\\${t("{name} - page {page}", { name: stem, page: String(p + 1).padStart(width, "0") })}.${ext}`;
        const r = await engine.exportImage(info.id, p, { format, dpi, quality, annotations }, path, !single);
        last = r.path;
        done++;
        setProgress({ done, total: pages.length });
      }
      const where = single ? (last.split(/[\\/]/).pop() ?? "") : target.split(/[\\/]/).filter(Boolean).pop() || target;
      toast({
        tone: cancel.current ? "info" : "success",
        message: cancel.current
          ? t("Export arrêté : {count} images enregistrées.", { count: done })
          : single
            ? t("Image enregistrée : « {name} ».", { name: where })
            : t("{count} images enregistrées dans « {folder} ».", { count: done, folder: where }),
      });
      onClose();
    } catch (e) {
      const m = String(e);
      toast({ tone: "error", message: m.includes("copy_forbidden") ? t("L'auteur de ce document interdit la copie de son contenu, et donc son export en image.") : t("L'export a échoué : {detail}", { detail: m }) });
      setProgress(null);
    }
  };

  const options = [
    ...(chosen?.length ? [{ id: "chosen", label: t("Pages choisies ({pages})", { pages: rangesLabel(chosen) }) }] : []),
    { id: "current", label: t("Page affichée ({page})", { page: currentPage }) },
    { id: "all", label: t("Toutes les pages ({count})", { count: info.pageCount }) },
    { id: "range", label: t("Pages :") },
  ];

  return (
    <Dialog
      title={t("Exporter en image")}
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      footer={(close) => (
        <>
          {busy ? (
            <Button onPress={() => (cancel.current = true)}>{t("Arrêter")}</Button>
          ) : (
            <Button onPress={close}>{t("Annuler")}</Button>
          )}
          <Button variant="primary" onPress={() => void run()} isPending={busy} isDisabled={typeof pages === "string" || !pages.length}>
            {typeof pages !== "string" && pages.length > 1 ? t("Choisir le dossier…") : t("Exporter…")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-base" data-export-image>
        <div className="flex flex-col gap-1">
          <RadioGroup label={t("Pages")} options={options} value={which} onChange={(v) => setWhich(v as typeof which)} isDisabled={busy} />
          {which === "range" && (
            <TextField aria-label={t("Pages à exporter")} placeholder={t("par exemple 1-3, 5")} value={range} onChange={setRange} isDisabled={busy} errorMessage={error ?? undefined} isInvalid={!!error} className="ml-6 max-w-60" autoFocus />
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <Select
            label={t("Format")}
            options={[
              { id: "png", label: t("PNG (sans perte)") },
              { id: "jpeg", label: t("JPEG (plus léger)") },
            ]}
            selectedKey={format}
            onSelectionChange={(k) => setFormat(k as ImageFormat)}
            isDisabled={busy}
            className="w-48"
          />
          <Select
            label={t("Résolution")}
            options={DPIS.map((d) => ({ id: String(d), label: d === 72 ? t("72 ppp (écran)") : d === 150 ? t("150 ppp (standard)") : d === 300 ? t("300 ppp (impression)") : t("600 ppp (très haute)") }))}
            selectedKey={String(dpi)}
            onSelectionChange={(k) => setDpi(Number(k))}
            isDisabled={busy}
            className="w-52"
          />
        </div>
        {format === "jpeg" && <Slider label={t("Qualité")} minValue={50} maxValue={100} step={5} value={quality} onChange={(v) => setQuality(v as number)} isDisabled={busy} className="max-w-72" unit=" %" />}
        <Checkbox isSelected={annotations} onChange={setAnnotations} isDisabled={busy}>
          {t("Inclure les commentaires et les champs remplis")}
        </Checkbox>
        {busy && progress && <ProgressBar label={t("Page {done} sur {total}", { done: progress.done, total: progress.total })} value={(progress.done / progress.total) * 100} />}
      </div>
    </Dialog>
  );
}

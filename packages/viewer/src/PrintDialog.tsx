/** S13 : imprimer. Imprimante, pages (toutes, courante, plage, paires ou impaires), copies,
 *  échelle, orientation, recto verso, commentaires, aperçu de la feuille ; impression page par page
 *  avec progression et annulation. */
import { Banner, Button, Checkbox, Dialog, IconButton, NumberField, ProgressBar, RadioGroup, Select, TextField } from "@pdfreader/ui";
import { ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type DocInfo, type EngineClient, type PrinterInfo, type PrintOptions, thumbScale } from "./engine";
import { type PageSubset, parseRange, type PrintSettings, subset } from "./prefs";

type Which = "all" | "current" | "range";

const PREVIEW_H = 260;

export function PrintDialog({
  engine,
  info,
  currentPage,
  settings,
  onSettings,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Page courante, à partir de 1. */
  currentPage: number;
  settings: PrintSettings;
  onSettings: (s: PrintSettings) => void;
  onClose: () => void;
}) {
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null);
  const [s, setS] = useState(settings);
  const [which, setWhich] = useState<Which>("all");
  const [range, setRange] = useState(`1-${info.pageCount}`);
  const [sub, setSub] = useState<PageSubset>("all");
  const [sheet, setSheet] = useState<[number, number]>([595, 842]);
  const [preview, setPreview] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forbidden = !info.permissions.print;

  useEffect(() => {
    let alive = true;
    engine
      .printers()
      .then((list) => {
        if (!alive) return;
        setPrinters(list);
        setS((cur) => (list.some((p) => p.name === cur.printer) ? cur : { ...cur, printer: list[0]?.name ?? "" }));
      })
      .catch(() => alive && setPrinters([]));
    return () => {
      alive = false;
    };
  }, [engine]);

  useEffect(() => {
    if (!s.printer) return;
    let alive = true;
    engine
      .printerSheet(s.printer)
      .then((size) => alive && size && setSheet(size))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [engine, s.printer]);

  const printer = printers?.find((p) => p.name === s.printer);
  const pages = useMemo((): number[] | string => {
    const base = which === "all" ? [...Array(info.pageCount).keys()] : which === "current" ? [currentPage - 1] : parseRange(range, info.pageCount);
    if (typeof base === "string") return base;
    const out = subset(base, sub);
    return out.length ? out : "Aucune page ne correspond (pages paires ou impaires).";
  }, [which, range, sub, info.pageCount, currentPage]);
  const list = typeof pages === "string" ? [] : pages;
  useEffect(() => setPreview(0), [pages]);

  const start = async () => {
    if (!printer || typeof pages === "string") return;
    setError(null);
    onSettings(s);
    const opts: PrintOptions = { ...s, duplex: printer.duplex ? s.duplex : "none", pages, title: info.name };
    setProgress({ done: 0, total: pages.length });
    const off = await engine.onPrintProgress((done, total) => setProgress({ done, total }));
    try {
      await engine.print(info.id, opts);
      onClose();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("print_cancelled")) setError("Impression annulée.");
      else if (msg.includes("print_forbidden")) setError("L'auteur de ce document en a interdit l'impression.");
      else if (msg.includes("print_busy")) setError("Une autre impression est en cours : attendez qu'elle se termine.");
      else setError(`L'impression a échoué (${msg}).`);
    } finally {
      off();
      setProgress(null);
    }
  };

  // Aperçu : la feuille (selon l'orientation) et la page placée selon l'échelle choisie.
  const pageIndex = list[Math.min(preview, Math.max(0, list.length - 1))] ?? 0;
  const [pw, ph] = info.pages[pageIndex] ?? [595, 842];
  const landscape = s.orientation === "landscape" || (s.orientation === "auto" && pw > ph);
  const [sw, sh] = landscape ? [sheet[1], sheet[0]] : sheet;
  const k = PREVIEW_H / Math.max(sw, sh);
  const fit = Math.min(sw / pw, sh / ph);
  const factor = s.scale === "fit" ? fit : s.scale === "actual" ? 1 : s.scale === "shrink" ? Math.min(1, fit) : s.customScale / 100;
  const dpr = window.devicePixelRatio || 1;
  const ts = thumbScale(pw, ph, dpr);
  const busy = progress !== null;

  return (
    <Dialog
      title="Imprimer"
      size="lg"
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => !o && !busy && onClose()}
      footer={(close) =>
        busy ? (
          <Button onPress={() => void engine.cancelPrint()}>Annuler l'impression</Button>
        ) : (
          <>
            <Button onPress={close}>Annuler</Button>
            <Button variant="primary" isDisabled={forbidden || !printer || typeof pages === "string" || s.copies < 1} onPress={() => void start()}>
              Imprimer
            </Button>
          </>
        )
      }
    >
      <div className="flex gap-6 max-md:flex-col">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {forbidden && <Banner tone="warning">L'auteur de ce document en a interdit l'impression.</Banner>}
          {!forbidden && !info.permissions.printHighQuality && <Banner tone="info">L'auteur n'autorise que l'impression en qualité réduite : les pages seront imprimées comme des images.</Banner>}
          {printers === null ? (
            <ProgressBar label="Recherche des imprimantes…" />
          ) : printers.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-base">Aucune imprimante n'est installée sur cet ordinateur.</p>
              <Button size="sm" icon={<Settings2 size={16} />} onPress={() => void engine.openSettings("printers")} className="self-start">
                Ouvrir les réglages des imprimantes
              </Button>
            </div>
          ) : (
            <Select
              label="Imprimante"
              options={printers.map((p) => ({ id: p.name, label: p.isDefault ? `${p.name} (par défaut)` : p.name }))}
              selectedKey={s.printer}
              onSelectionChange={(k) => setS({ ...s, printer: String(k) })}
            />
          )}
          <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
            <div className="flex flex-col gap-2">
              <RadioGroup
                label="Pages"
                value={which}
                onChange={(v) => setWhich(v as Which)}
                options={[
                  { id: "all", label: `Toutes (${info.pageCount})` },
                  { id: "current", label: `Page courante (${currentPage})` },
                  { id: "range", label: "Pages choisies" },
                ]}
              />
              {which === "range" && (
                <TextField
                  label="Pages à imprimer"
                  description="Exemple : 1-3, 5, 8-"
                  value={range}
                  onChange={setRange}
                  isInvalid={typeof pages === "string"}
                  errorMessage={typeof pages === "string" ? pages : undefined}
                  autoFocus
                />
              )}
              <Select
                label="Sous-ensemble"
                size="sm"
                options={[
                  { id: "all", label: "Toutes" },
                  { id: "odd", label: "Pages impaires seulement" },
                  { id: "even", label: "Pages paires seulement" },
                ]}
                selectedKey={sub}
                onSelectionChange={(k) => setSub(k as PageSubset)}
              />
              {which !== "range" && typeof pages === "string" && <p className="text-sm text-danger">{pages}</p>}
              <NumberField label="Copies" value={s.copies} minValue={1} maxValue={999} onChange={(v) => !Number.isNaN(v) && setS({ ...s, copies: v })} className="w-28" />
            </div>
            <div className="flex flex-col gap-2">
              <RadioGroup
                label="Taille"
                value={s.scale}
                onChange={(v) => setS({ ...s, scale: v as PrintSettings["scale"] })}
                options={[
                  { id: "fit", label: "Ajuster à la feuille" },
                  { id: "actual", label: "Taille réelle" },
                  { id: "shrink", label: "Réduire si la page dépasse" },
                  { id: "custom", label: "Échelle personnalisée" },
                ]}
              />
              {s.scale === "custom" && (
                <NumberField label="Échelle" suffix="%" value={s.customScale} minValue={10} maxValue={400} onChange={(v) => !Number.isNaN(v) && setS({ ...s, customScale: v })} className="w-28" />
              )}
              <Select
                label="Orientation"
                size="sm"
                options={[
                  { id: "auto", label: "Selon chaque page" },
                  { id: "portrait", label: "Portrait" },
                  { id: "landscape", label: "Paysage" },
                ]}
                selectedKey={s.orientation}
                onSelectionChange={(k) => setS({ ...s, orientation: k as PrintSettings["orientation"] })}
              />
              <Select
                label="Recto verso"
                size="sm"
                isDisabled={!printer?.duplex}
                options={[
                  { id: "none", label: printer && !printer.duplex ? "Non disponible" : "Recto seulement" },
                  { id: "long", label: "Retourner sur le bord long" },
                  { id: "short", label: "Retourner sur le bord court" },
                ]}
                selectedKey={printer?.duplex ? s.duplex : "none"}
                onSelectionChange={(k) => setS({ ...s, duplex: k as PrintSettings["duplex"] })}
              />
              <Checkbox isSelected={s.comments} onChange={(v) => setS({ ...s, comments: v })}>
                Imprimer les commentaires
              </Checkbox>
              <p className="text-xs text-muted">Les champs remplis et ce qui a été posé avec « Remplir et signer » sont toujours imprimés.</p>
            </div>
          </div>
          {progress && <ProgressBar label={`Impression : page ${progress.done} sur ${progress.total}`} value={(progress.done / Math.max(1, progress.total)) * 100} />}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <figure className="flex shrink-0 flex-col items-center gap-2">
          <div aria-hidden className="grid place-items-center rounded-md bg-canvas p-3" style={{ width: PREVIEW_H + 24, height: PREVIEW_H + 24 }}>
            <div className="pdf-page relative overflow-hidden" style={{ width: sw * k, height: sh * k }}>
              {list.length > 0 && (
                <img
                  alt=""
                  src={engine.tileUrl(info.id, info.generation, 0, pageIndex, ts, 0, 0)}
                  className="absolute max-w-none"
                  style={{ width: pw * factor * k, height: ph * factor * k, left: ((sw - pw * factor) / 2) * k, top: ((sh - ph * factor) / 2) * k }}
                />
              )}
            </div>
          </div>
          <figcaption className="flex items-center gap-1 text-sm text-muted">
            <IconButton label="Page précédente de l'aperçu" size="sm" icon={<ChevronLeft size={16} />} isDisabled={preview <= 0} onPress={() => setPreview((p) => p - 1)} />
            <span aria-live="polite" className="tabular-nums">
              {list.length ? `Aperçu : page ${pageIndex + 1} (${Math.min(preview, list.length - 1) + 1} sur ${list.length})` : "Aucune page"}
            </span>
            <IconButton label="Page suivante de l'aperçu" size="sm" icon={<ChevronRight size={16} />} isDisabled={preview >= list.length - 1} onPress={() => setPreview((p) => p + 1)} />
          </figcaption>
        </figure>
      </div>
    </Dialog>
  );
}

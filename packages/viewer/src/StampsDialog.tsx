/** Phase 2, « Filigrane, en-têtes et pieds de page » : filigrane transparent (diagonal ou
 *  horizontal), en-tête et pied de page à gauche, au centre et à droite, avec numéros de page,
 *  nombre de pages, date et nom du fichier ; pages choisies, premier numéro. Appliquer de nouveau
 *  remplace l'ancien jeu ; « Retirer » enlève tout. Annulable (Ctrl+Z dans la notification). */
import { t, Button, Checkbox, ColorSwatches, Dialog, locale, NumberField, RadioGroup, Slider, TextField, useToast } from "@pdfreader/ui";
import { useEffect, useRef, useState } from "react";
import { fromHex, toHex } from "./annot";
import type { DocInfo, EngineClient, Rgb, StampConfig, StampsResult } from "./engine";
import { rangesLabel } from "./OrganizeView";
import { parseRange } from "./prefs";

const MM = 72 / 25.4;
type Slot = "hl" | "hc" | "hr" | "fl" | "fc" | "fr";

/** Réglage proposé la première fois : numéros de page en bas au centre. */
function defaults(): StampConfig {
  return {
    watermark: null,
    header: { left: "", center: "", right: "" },
    footer: { left: "", center: t("Page {page} sur {pages}"), right: "" },
    size: 10,
    color: [0, 0, 0],
    margin: Math.round(10 * MM),
    pages: [],
    firstNumber: 1,
  };
}

export function StampsDialog({
  engine,
  info,
  chosen,
  onApplied,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Pages choisies dans « Organiser les pages » (index à partir de 0), s'il y en a. */
  chosen?: number[];
  /** Document modifié (nouvelle génération), avec le message à afficher (annulable). */
  onApplied: (r: StampsResult, message: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [cfg, setCfg] = useState<StampConfig>(defaults);
  const [hasCurrent, setHasCurrent] = useState(false);
  const [wmOn, setWmOn] = useState(false);
  const [wm, setWm] = useState({ text: t("CONFIDENTIEL"), size: 72, color: [229, 72, 77] as Rgb, opacity: 0.3, diagonal: true });
  const [which, setWhich] = useState<"all" | "chosen" | "range">(chosen?.length ? "chosen" : "all");
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const lastSlot = useRef<Slot>("fc");

  // Réglage déjà appliqué : la boîte reprend là où on l'avait laissée.
  useEffect(() => {
    let live = true;
    void engine
      .stamps(info.id, { kind: "current" })
      .then((r) => {
        if (!live || !r.current) return;
        const c = r.current;
        setHasCurrent(true);
        setCfg({ ...c, watermark: null });
        if (c.watermark) {
          setWmOn(true);
          setWm(c.watermark);
        }
        if (c.pages.length && c.pages.length < info.pageCount) {
          setWhich("range");
          setRange(rangesLabel(c.pages));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [engine, info.id, info.pageCount]);

  const pages: number[] | string = which === "all" ? [] : which === "chosen" ? (chosen ?? []) : parseRange(range, info.pageCount);
  const rangeError = typeof pages === "string" && which === "range" && range.trim() ? pages : null;
  const bands = [cfg.header.left, cfg.header.center, cfg.header.right, cfg.footer.left, cfg.footer.center, cfg.footer.right];
  const empty = !(wmOn && wm.text.trim()) && bands.every((b) => !b.trim());
  const invalid = typeof pages === "string" || (which !== "all" && !pages.length) || empty;

  const get = (s: Slot) => (s[0] === "h" ? cfg.header : cfg.footer)[s[1] === "l" ? "left" : s[1] === "c" ? "center" : "right"];
  const set = (s: Slot, v: string) =>
    setCfg((c) => {
      const band = s[0] === "h" ? "header" : "footer";
      const side = s[1] === "l" ? "left" : s[1] === "c" ? "center" : "right";
      return { ...c, [band]: { ...c[band], [side]: v } };
    });
  /** Ajoute un champ (numéro de page…) à la dernière zone utilisée. */
  const insert = (token: string) => {
    const s = lastSlot.current;
    const cur = get(s);
    set(s, cur && !cur.endsWith(" ") ? `${cur} ${token}` : cur + token);
  };

  const fail = (e: unknown) => {
    const m = String(e);
    toast({
      tone: "error",
      message: m.includes("modify_forbidden") ? t("L'auteur de ce document interdit d'en modifier le contenu.") : t("Le filigrane n'a pas pu être appliqué : {detail}", { detail: m }),
    });
  };
  const apply = async () => {
    if (invalid || typeof pages === "string") return;
    setBusy(true);
    try {
      const config: StampConfig = { ...cfg, pages, watermark: wmOn && wm.text.trim() ? wm : null };
      const r = await engine.stamps(info.id, { kind: "apply", config, date: new Date().toLocaleDateString(locale()) });
      onApplied(r, t("Filigrane et en-têtes appliqués à {count} pages.", { count: r.count }));
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const r = await engine.stamps(info.id, { kind: "remove" });
      onApplied(r, t("Filigrane, en-têtes et pieds de page retirés."));
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const slot = (s: Slot, label: string) => (
    <TextField
      label={label}
      value={get(s)}
      onChange={(v) => set(s, v)}
      onFocus={() => (lastSlot.current = s)}
      isDisabled={busy}
      className="min-w-0 [&_input]:w-full [&_input]:min-w-0"
      data-stamp-slot={s}
    />
  );
  const pageOptions = [
    { id: "all", label: t("Toutes les pages ({count})", { count: info.pageCount }) },
    ...(chosen?.length ? [{ id: "chosen", label: t("Pages choisies ({pages})", { pages: rangesLabel(chosen) }) }] : []),
    { id: "range", label: t("Pages :") },
  ];

  return (
    <Dialog
      title={t("Filigrane, en-têtes et pieds de page")}
      size="lg"
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      footer={(close) => (
        <>
          {hasCurrent && (
            <Button onPress={() => void remove()} isDisabled={busy} className="mr-auto">
              {t("Tout retirer")}
            </Button>
          )}
          <Button onPress={close} isDisabled={busy}>
            {t("Annuler")}
          </Button>
          <Button variant="primary" onPress={() => void apply()} isPending={busy} isDisabled={invalid}>
            {t("Appliquer")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-base" data-stamps>
        <fieldset className="flex flex-col gap-3">
          <Checkbox isSelected={wmOn} onChange={setWmOn} isDisabled={busy}>
            {t("Filigrane")}
          </Checkbox>
          {wmOn && (
            <div className="ml-6 flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <TextField label={t("Texte du filigrane")} value={wm.text} onChange={(v) => setWm({ ...wm, text: v })} isDisabled={busy} className="w-64" />
                <NumberField label={t("Taille")} value={wm.size} minValue={8} maxValue={400} onChange={(v) => Number.isFinite(v) && setWm({ ...wm, size: v })} isDisabled={busy} className="w-28" suffix="pt" />
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <ColorSwatches
                  aria-label={t("Couleur du filigrane")}
                  value={toHex(wm.color)}
                  onChange={(c) => {
                    const rgb = fromHex(c.toString("hex"));
                    if (rgb) setWm({ ...wm, color: rgb });
                  }}
                />
                <Slider
                  label={t("Opacité")}
                  unit=" %"
                  minValue={5}
                  maxValue={100}
                  step={5}
                  value={Math.round(wm.opacity * 100)}
                  onChange={(v) => setWm({ ...wm, opacity: (v as number) / 100 })}
                  isDisabled={busy}
                  className="w-48"
                />
              </div>
              <RadioGroup
                label={t("Orientation")}
                value={wm.diagonal ? "diagonal" : "horizontal"}
                onChange={(v) => setWm({ ...wm, diagonal: v === "diagonal" })}
                isDisabled={busy}
                options={[
                  { id: "diagonal", label: t("En diagonale") },
                  { id: "horizontal", label: t("À l'horizontale") },
                ]}
              />
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("En-tête")}</legend>
          <div className="grid grid-cols-3 gap-2">
            {slot("hl", t("À gauche"))}
            {slot("hc", t("Au centre"))}
            {slot("hr", t("À droite"))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("Pied de page")}</legend>
          <div className="grid grid-cols-3 gap-2">
            {slot("fl", t("À gauche"))}
            {slot("fc", t("Au centre"))}
            {slot("fr", t("À droite"))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{t("Insérer dans la dernière zone :")}</span>
          <Button size="sm" onPress={() => insert("{page}")} isDisabled={busy}>
            {t("Numéro de page")}
          </Button>
          <Button size="sm" onPress={() => insert("{pages}")} isDisabled={busy}>
            {t("Nombre de pages")}
          </Button>
          <Button size="sm" onPress={() => insert("{date}")} isDisabled={busy}>
            {t("Date")}
          </Button>
          <Button size="sm" onPress={() => insert(locale().startsWith("fr") ? "{fichier}" : "{file}")} isDisabled={busy}>
            {t("Nom du fichier")}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <NumberField label={t("Taille du texte")} value={cfg.size} minValue={4} maxValue={72} onChange={(v) => Number.isFinite(v) && setCfg({ ...cfg, size: v })} isDisabled={busy} className="w-32" suffix="pt" />
          <NumberField
            label={t("Marge")}
            value={Math.round(cfg.margin / MM)}
            minValue={0}
            maxValue={70}
            onChange={(v) => Number.isFinite(v) && setCfg({ ...cfg, margin: v * MM })}
            isDisabled={busy}
            className="w-32"
            suffix="mm"
          />
          <NumberField label={t("Premier numéro")} value={cfg.firstNumber} minValue={0} maxValue={99999} onChange={(v) => Number.isFinite(v) && setCfg({ ...cfg, firstNumber: v })} isDisabled={busy} className="w-32" />
          <ColorSwatches
            aria-label={t("Couleur du texte")}
            value={toHex(cfg.color)}
            onChange={(c) => {
              const rgb = fromHex(c.toString("hex"));
              if (rgb) setCfg({ ...cfg, color: rgb });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <RadioGroup label={t("Pages")} options={pageOptions} value={which} onChange={(v) => setWhich(v as typeof which)} isDisabled={busy} />
          {which === "range" && (
            <TextField aria-label={t("Pages concernées")} placeholder={t("par exemple 2-10")} value={range} onChange={setRange} isDisabled={busy} errorMessage={rangeError ?? undefined} isInvalid={!!rangeError} className="ml-6 max-w-60" />
          )}
        </div>
        <p className="text-sm text-muted">
          {t("Le texte est écrit dans les pages (il s'imprime et se recherche). Appliquer de nouveau remplace le filigrane et les en-têtes précédents.")}
        </p>
      </div>
    </Dialog>
  );
}

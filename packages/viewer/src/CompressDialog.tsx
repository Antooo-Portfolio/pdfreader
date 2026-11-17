/** Phase 2, « Compresser » : réduit la taille du fichier (images réduites et réencodées selon le
 *  niveau choisi, structure compacte), dans une copie ou à la place du fichier. */
import { t, Button, Dialog, RadioGroup, useToast } from "@pdfreader/ui";
import { useState } from "react";
import type { CompressOptions, DocInfo, EngineClient, SaveResult } from "./engine";

type Level = "screen" | "standard" | "print" | "lossless";

const LEVELS: Record<Level, CompressOptions> = {
  screen: { images: { dpi: 96, quality: 60 } },
  standard: { images: { dpi: 150, quality: 75 } },
  print: { images: { dpi: 300, quality: 85 } },
  lossless: { images: null },
};

/** Taille lisible : « 12,4 Mo », « 830 Ko ». */
export function sizeLabel(bytes: number): string {
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 1 : 0 });
  if (bytes >= 1024 * 1024) return t("{n} Mo", { n: fmt(bytes / (1024 * 1024)) });
  return t("{n} Ko", { n: fmt(Math.max(1, bytes / 1024)) });
}

export function CompressDialog({
  engine,
  info,
  onDone,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Fichier compressé enregistré et rouvert dans cet onglet. */
  onDone: (info: DocInfo, save: SaveResult) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [level, setLevel] = useState<Level>("standard");
  const [busy, setBusy] = useState(false);

  const run = async (copy: boolean) => {
    let path: string | null = null;
    if (copy) {
      path = await engine.pickSavePath(info.path.replace(/\.pdf$/i, "") + t(" (compressé).pdf"));
      if (!path) return;
    }
    setBusy(true);
    try {
      const r = await engine.compress(info.id, LEVELS[level], path);
      onDone(r.info, r.save);
      const gain = r.report.before > 0 ? Math.round((1 - r.report.after / r.report.before) * 100) : 0;
      toast({
        tone: "success",
        message: t("« {name} » : {before} → {after} (−{gain} %).", { name: r.info.name, before: sizeLabel(r.report.before), after: sizeLabel(r.report.after), gain }),
      });
      onClose();
    } catch (e) {
      const m = String(e);
      toast({
        tone: m.includes("no_gain") ? "info" : "error",
        message: m.includes("no_gain")
          ? t("Ce document est déjà compact : la compression n'apporterait rien. Le fichier n'a pas été modifié.")
          : m.includes("encrypted")
            ? t("Ce document est protégé par mot de passe : retirez d'abord la protection, compressez, puis protégez-le de nouveau.")
            : m.includes("file_changed")
              ? t("Le fichier a été modifié par un autre programme. Utilisez « Copie compressée… » pour ne rien perdre.")
              : m.includes("file_locked")
                ? t("Le fichier est ouvert dans un autre programme.")
                : t("La compression a échoué : {detail}", { detail: m }),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("Réduire la taille du fichier")}
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      footer={(close) => (
        <>
          <Button onPress={close} isDisabled={busy}>
            {t("Annuler")}
          </Button>
          <Button onPress={() => void run(false)} isDisabled={busy}>
            {t("Compresser et remplacer")}
          </Button>
          <Button variant="primary" onPress={() => void run(true)} isPending={busy}>
            {t("Copie compressée…")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-base" data-compress>
        <RadioGroup
          label={t("Niveau")}
          value={level}
          onChange={(v) => setLevel(v as Level)}
          isDisabled={busy}
          options={[
            { id: "screen", label: t("Écran : le plus léger, pour l'envoyer par e-mail (images à 96 ppp)") },
            { id: "standard", label: t("Standard : bon compromis (images à 150 ppp)") },
            { id: "print", label: t("Impression : qualité préservée (images à 300 ppp)") },
            { id: "lossless", label: t("Sans perte : images inchangées, seule la structure est optimisée") },
          ]}
        />
        <p className="text-sm text-muted">
          {t("Les images plus fines que nécessaire sont réduites et réencodées en JPEG ; le texte et les dessins restent nets. Les modifications en cours sont incluses.")}
        </p>
      </div>
    </Dialog>
  );
}

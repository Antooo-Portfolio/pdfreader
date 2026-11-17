/** Phase 2, « Protéger par mot de passe » : mot de passe d'ouverture et / ou mot de passe des
 *  droits (ce qui reste permis sans lui), chiffrement AES-256 ; retrait de la protection. Le
 *  document est enregistré sur place (ou dans une copie) puis rouvert. */
import { t, Banner, Button, Checkbox, Dialog, TextField, useToast } from "@pdfreader/ui";
import { useState } from "react";
import type { Allowed, DocInfo, EngineClient, Protection, SaveResult } from "./engine";

export function protectError(e: unknown): string {
  const m = String(e);
  if (m.includes("owner_required")) return t("Pour changer ou retirer la protection, ouvrez le document avec le mot de passe des droits.");
  if (m.includes("file_changed")) return t("Le fichier a été modifié par un autre programme. Utilisez « Copie protégée… » pour ne rien perdre.");
  if (m.includes("file_locked")) return t("Le fichier est ouvert dans un autre programme.");
  if (m.includes("same_passwords")) return t("Le mot de passe des droits doit être différent du mot de passe d'ouverture.");
  if (m.includes("password_length")) return t("Un mot de passe doit faire de 1 à 127 caractères.");
  return t("La protection a échoué : {detail}", { detail: m });
}

export function ProtectDialog({
  engine,
  info,
  onDone,
  onClose,
}: {
  engine: EngineClient;
  info: DocInfo;
  /** Document enregistré et rouvert (protégé ou non). */
  onDone: (info: DocInfo, save: SaveResult) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const p = info.permissions;
  const fullRights = p.print && p.printHighQuality && p.copy && p.modify && p.annotate && p.fillForms && p.assemble;
  const [openOn, setOpenOn] = useState(true);
  const [open1, setOpen1] = useState("");
  const [open2, setOpen2] = useState("");
  const [restrictOn, setRestrictOn] = useState(false);
  const [owner1, setOwner1] = useState("");
  const [owner2, setOwner2] = useState("");
  const [allowed, setAllowed] = useState<Allowed>({ print: true, printHighQuality: true, copy: false, annotate: true, fillForms: true, modify: false });
  const [busy, setBusy] = useState(false);
  const allow = (k: keyof Allowed) => (v: boolean) => setAllowed((a) => ({ ...a, [k]: v }));

  const problems: string[] = [];
  if (!openOn && !restrictOn) problems.push(t("Choisissez un mot de passe d'ouverture, des restrictions, ou les deux."));
  if (openOn && !open1) problems.push(t("Indiquez le mot de passe d'ouverture."));
  if (openOn && open1 && open1 !== open2) problems.push(t("Les deux saisies du mot de passe d'ouverture sont différentes."));
  if (restrictOn && !owner1) problems.push(t("Indiquez le mot de passe des droits."));
  if (restrictOn && owner1 && owner1 !== owner2) problems.push(t("Les deux saisies du mot de passe des droits sont différentes."));
  if (openOn && restrictOn && open1 && open1 === owner1) problems.push(t("Le mot de passe des droits doit être différent du mot de passe d'ouverture."));
  const weak = (openOn && open1.length > 0 && open1.length < 8) || (restrictOn && owner1.length > 0 && owner1.length < 8);

  const run = async (protection: Protection | null, copy: boolean) => {
    let path: string | null = null;
    if (copy) {
      path = await engine.pickSavePath(info.path.replace(/\.pdf$/i, "") + t(" (protégé).pdf"));
      if (!path) return;
    }
    setBusy(true);
    try {
      const r = await engine.protect(info.id, protection, path);
      onDone(r.info, r.save);
      toast({
        tone: "success",
        message: protection ? t("« {name} » est protégé par mot de passe.", { name: r.info.name }) : t("Protection retirée : « {name} » s'ouvre sans mot de passe.", { name: r.info.name }),
      });
      onClose();
    } catch (e) {
      toast({ tone: "error", message: protectError(e) });
    } finally {
      setBusy(false);
    }
  };
  const protection = (): Protection => ({ openPassword: openOn ? open1 : null, restrictions: restrictOn ? [owner1, allowed] : null });

  return (
    <Dialog
      title={t("Protéger par mot de passe")}
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
          <Button onPress={() => void run(protection(), true)} isDisabled={busy || problems.length > 0 || !fullRights}>
            {t("Copie protégée…")}
          </Button>
          <Button variant="primary" onPress={() => void run(protection(), false)} isPending={busy} isDisabled={problems.length > 0 || !fullRights}>
            {t("Protéger et enregistrer")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 text-base" data-protect>
        {info.encrypted && (
          <Banner
            tone="info"
            actions={
              <Button size="sm" onPress={() => void run(null, false)} isDisabled={busy || !fullRights}>
                {t("Retirer la protection")}
              </Button>
            }
          >
            {fullRights ? t("Ce document est déjà protégé. Vous pouvez retirer la protection ou la remplacer.") : t("Ce document est protégé. Ouvrez-le avec le mot de passe des droits pour changer ou retirer la protection.")}
          </Banner>
        )}
        <section className="flex flex-col gap-2">
          <Checkbox isSelected={openOn} onChange={setOpenOn} isDisabled={busy}>
            {t("Demander un mot de passe pour ouvrir le document")}
          </Checkbox>
          {openOn && (
            <div className="ml-6 flex flex-wrap gap-3">
              <TextField label={t("Mot de passe d'ouverture")} type="password" value={open1} onChange={setOpen1} isDisabled={busy} className="w-56" autoFocus />
              <TextField label={t("Confirmer")} type="password" value={open2} onChange={setOpen2} isDisabled={busy} className="w-56" />
            </div>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <Checkbox isSelected={restrictOn} onChange={setRestrictOn} isDisabled={busy}>
            {t("Limiter l'impression, la copie et la modification")}
          </Checkbox>
          {restrictOn && (
            <div className="ml-6 flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <TextField label={t("Mot de passe des droits")} type="password" value={owner1} onChange={setOwner1} isDisabled={busy} className="w-56" />
                <TextField label={t("Confirmer")} type="password" value={owner2} onChange={setOwner2} isDisabled={busy} className="w-56" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t("Permis sans le mot de passe des droits :")}</span>
                <Checkbox isSelected={allowed.print} onChange={allow("print")} isDisabled={busy}>
                  {t("Imprimer")}
                </Checkbox>
                <Checkbox isSelected={allowed.print && allowed.printHighQuality} onChange={allow("printHighQuality")} isDisabled={busy || !allowed.print} className="ml-6">
                  {t("en haute qualité")}
                </Checkbox>
                <Checkbox isSelected={allowed.copy} onChange={allow("copy")} isDisabled={busy}>
                  {t("Copier le texte et les images")}
                </Checkbox>
                <Checkbox isSelected={allowed.annotate} onChange={allow("annotate")} isDisabled={busy}>
                  {t("Commenter")}
                </Checkbox>
                <Checkbox isSelected={allowed.fillForms || allowed.annotate} onChange={allow("fillForms")} isDisabled={busy || allowed.annotate}>
                  {t("Remplir les formulaires et signer")}
                </Checkbox>
                <Checkbox isSelected={allowed.modify} onChange={allow("modify")} isDisabled={busy}>
                  {t("Modifier le document et organiser ses pages")}
                </Checkbox>
              </div>
              {!openOn && <p className="text-sm text-muted">{t("Sans mot de passe d'ouverture, tout le monde peut lire le document ; les restrictions sont appliquées par les lecteurs PDF qui les respectent.")}</p>}
            </div>
          )}
        </section>
        <p className="text-sm text-muted">
          {t("Chiffrement AES-256. Notez bien vos mots de passe : sans eux, personne — ni PDFReader, ni vous — ne pourra retrouver l'accès au document.")}
        </p>
        {problems.length > 0 && (openOn ? open1 || open2 : true) && <p className="text-sm text-danger" role="alert">{problems[0]}</p>}
        {problems.length === 0 && weak && <p className="text-sm text-warning">{t("Mot de passe court : 8 caractères ou plus sont plus sûrs.")}</p>}
      </div>
    </Dialog>
  );
}

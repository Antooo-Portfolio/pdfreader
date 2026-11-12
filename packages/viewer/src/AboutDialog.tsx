/** S35 : À propos (version, contrat de licence, composants tiers, confidentialité, mises à jour),
 *  demande d'accord pour les mises à jour et boîte « mise à jour disponible ». */
import { Banner, Button, Dialog, ProgressBar, SearchField, t } from "@pdfreader/ui";
import { useEffect, useMemo, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { EngineClient } from "./engine";

export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

interface Component {
  name: string;
  version: string;
  license: string;
  kind: string;
  url: string;
}

export function AboutDialog({ engine, onUpdateFound, onClose }: { engine: EngineClient; onUpdateFound: (u: UpdateInfo) => void; onClose: () => void }) {
  const [info, setInfo] = useState<{ name: string; version: string; pdfium: string } | null>(null);
  const [licence, setLicence] = useState<string | null>(null);
  const [components, setComponents] = useState<Component[] | null>(null);
  const [notices, setNotices] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [check, setCheck] = useState<"idle" | "checking" | "uptodate" | "error">("idle");
  const [checkError, setCheckError] = useState("");

  useEffect(() => {
    engine.appInfo().then(setInfo).catch(() => undefined);
    engine
      .legalDocument("licence")
      .then(setLicence)
      .catch(() => setLicence(""));
    engine
      .legalDocument("summary")
      .then((s) => setComponents(JSON.parse(s) as Component[]))
      .catch(() => setComponents([]));
  }, [engine]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (components ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.license.toLowerCase().includes(q));
  }, [components, query]);

  const checkNow = async () => {
    setCheck("checking");
    try {
      const u = await engine.updateCheck();
      if (u) {
        setCheck("idle");
        onUpdateFound(u);
      } else setCheck("uptodate");
    } catch (e) {
      setCheck("error");
      setCheckError(String(e));
    }
  };

  return (
    <Dialog title={t("À propos de PDFReader")} size="lg" isOpen onOpenChange={(o) => !o && onClose()} footer={(close) => <Button variant="primary" onPress={close}>{t("Fermer")}</Button>}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="text-xl font-semibold">PDFReader</p>
            <p className="text-sm text-muted">
              {info ? t("Version {version} · moteur PDFium {pdfium}", { version: info.version, pdfium: info.pdfium }) : "…"}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span aria-live="polite" className="text-sm text-muted">
              {check === "checking" ? t("Recherche…") : check === "uptodate" ? t("PDFReader est à jour.") : check === "error" ? t("Impossible de vérifier ({detail}).", { detail: checkError }) : ""}
            </span>
            <Button onPress={() => void checkNow()} isDisabled={check === "checking"}>
              {t("Rechercher des mises à jour")}
            </Button>
          </div>
        </div>
        <p className="text-sm">{t("Gratuit, sans publicité, sans compte. Vos documents restent sur cet ordinateur.")}</p>
        <Tabs className="flex min-h-0 flex-col gap-3">
          <TabList aria-label={t("Informations")} className="flex gap-1 border-b border-border">
            {(
              [
                ["privacy", t("Confidentialité")],
                ["licence", t("Contrat de licence")],
                ["thirdparty", t("Composants tiers")],
              ] as const
            ).map(([id, label]) => (
              <Tab
                key={id}
                id={id}
                className="focus-ring-inset -mb-px cursor-default border-b-2 border-transparent px-3 py-2 text-base text-muted data-hovered:text-fg data-selected:border-accent data-selected:text-fg"
              >
                {label}
              </Tab>
            ))}
          </TabList>
          <TabPanel id="privacy" className="flex flex-col gap-2 text-base outline-none">
            <p>{t("PDFReader fonctionne entièrement sur votre ordinateur.")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>{t("Vos documents, commentaires, signatures et réglages ne sont envoyés nulle part.")}</li>
              <li>{t("Aucune statistique d'utilisation, aucune publicité, aucun compte.")}</li>
              <li>
                {t(
                  "La seule connexion possible est la recherche de mises à jour, seulement si vous l'avez acceptée ou si vous la demandez. Elle ne transmet que la version de PDFReader et le type de système, avec l'adresse IP que voit tout serveur.",
                )}
              </li>
              <li>{t("Les liens d'un document ne s'ouvrent qu'après votre confirmation.")}</li>
            </ul>
          </TabPanel>
          <TabPanel id="licence" className="outline-none">
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface p-3 font-sans text-sm whitespace-pre-wrap">{licence ?? "…"}</pre>
          </TabPanel>
          <TabPanel id="thirdparty" className="flex flex-col gap-2 outline-none">
            <p className="text-sm text-muted">
              {t("PDFReader s'appuie sur {count} composants libres, chacun sous sa propre licence. Merci à leurs auteurs.", { count: components?.length ?? 0 })}
            </p>
            <SearchField label={t("Rechercher un composant")} size="sm" placeholder={t("Rechercher un composant")} value={query} onChange={setQuery} className="max-w-72" />
            <div className="max-h-64 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-left">
                  <tr>
                    <th className="px-2 py-1 font-semibold">{t("Composant")}</th>
                    <th className="px-2 py-1 font-semibold">{t("Version")}</th>
                    <th className="px-2 py-1 font-semibold">{t("Licence")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={`${c.kind}:${c.name}:${c.version}`} className="border-t border-border">
                      <td className="px-2 py-1">{c.name}</td>
                      <td className="px-2 py-1 tabular-nums text-muted">{c.version}</td>
                      <td className="px-2 py-1">{c.license}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {notices === null ? (
              <Button size="sm" className="self-start" onPress={() => void engine.legalDocument("notices").then(setNotices).catch(() => setNotices(""))}>
                {t("Afficher le texte complet des licences")}
              </Button>
            ) : (
              <pre aria-label={t("Texte complet des licences")} className="max-h-64 overflow-auto rounded-md border border-border bg-surface p-3 text-xs whitespace-pre-wrap">
                {notices}
              </pre>
            )}
          </TabPanel>
        </Tabs>
      </div>
    </Dialog>
  );
}

/** Premier lancement : la vérification des mises à jour n'a lieu qu'avec l'accord de l'utilisateur. */
export function UpdateConsentDialog({ onAnswer }: { onAnswer: (auto: boolean) => void }) {
  return (
    <Dialog
      title={t("Mises à jour")}
      size="sm"
      role="alertdialog"
      isDismissable={false}
      isOpen
      footer={() => (
        <>
          <Button onPress={() => onAnswer(false)}>{t("Non merci")}</Button>
          <Button variant="primary" onPress={() => onAnswer(true)}>
            {t("Oui, vérifier")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-2 text-base">
        <p>{t("Voulez-vous que PDFReader vérifie une fois par jour si une nouvelle version existe ?")}</p>
        <p className="text-sm text-muted">
          {t(
            "Les mises à jour corrigent notamment des failles de sécurité. Seuls le numéro de version et le type de système sont envoyés. Sans votre accord, PDFReader ne se connecte jamais à Internet ; vous pourrez changer d'avis dans les Préférences ou vérifier vous-même depuis « À propos ».",
          )}
        </p>
      </div>
    </Dialog>
  );
}

export function UpdateDialog({ engine, update, onClose }: { engine: EngineClient; update: UpdateInfo; onClose: () => void }) {
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = async () => {
    setError(null);
    setProgress({ done: 0, total: null });
    const off = await engine.onUpdateProgress((done, total) => setProgress({ done, total }));
    try {
      await engine.updateInstall(); // l'application redémarre à la fin
    } catch (e) {
      setError(t("La mise à jour a échoué ({detail}).", { detail: String(e) }));
      setProgress(null);
    } finally {
      off();
    }
  };
  const busy = progress !== null;
  return (
    <Dialog
      title={t("Mise à jour disponible")}
      size="sm"
      isOpen
      isDismissable={!busy}
      onOpenChange={(o) => !o && !busy && onClose()}
      footer={(close) => (
        <>
          <Button onPress={close} isDisabled={busy}>
            {t("Plus tard")}
          </Button>
          <Button variant="primary" onPress={() => void install()} isPending={busy}>
            {t("Installer et redémarrer")}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-base">
        <p>{t("La version {version} de PDFReader est disponible.", { version: update.version })}</p>
        {update.notes && <pre className="max-h-40 overflow-auto rounded-md bg-surface p-2 font-sans text-sm whitespace-pre-wrap">{update.notes}</pre>}
        <p className="text-sm text-muted">{t("Enregistrez vos documents avant : PDFReader se fermera pendant l'installation.")}</p>
        {progress && (
          <ProgressBar
            label={t("Téléchargement")}
            value={progress.total ? (progress.done / progress.total) * 100 : undefined}
          />
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}

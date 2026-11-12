/** S14 : préférences, par catégorie. Chaque réglage s'applique tout de suite et est mémorisé dans
 *  la base locale. */
import { Button, Dialog, Select, Switch, TextField } from "@pdfreader/ui";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { EngineClient, Layout, Theme } from "./engine";
import { type DefaultZoom, type Prefs, RECOVERY_MINUTES, UI_SCALES } from "./prefs";

type Category = "general" | "display" | "comments" | "documents" | "accessibility";

const CATEGORIES: [Category, string][] = [
  ["general", "Général"],
  ["display", "Affichage des pages"],
  ["comments", "Commentaires"],
  ["documents", "Documents"],
  ["accessibility", "Accessibilité"],
];

export function PreferencesDialog({
  engine,
  prefs,
  author,
  onChange,
  onAuthorChange,
  onReset,
  onClose,
}: {
  engine: EngineClient;
  prefs: Prefs;
  author: string;
  onChange: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  onAuthorChange: (name: string) => void;
  onReset: () => Promise<void>;
  onClose: () => void;
}) {
  const [cat, setCat] = useState<Category>("general");
  const [name, setName] = useState(author);
  const [confirmReset, setConfirmReset] = useState(false);
  const commitName = () => {
    const n = name.trim();
    if (n && n !== author) onAuthorChange(n);
    else setName(author);
  };

  return (
    <Dialog
      title="Préférences"
      size="lg"
      isOpen
      onOpenChange={(o) => {
        if (!o) {
          commitName();
          onClose();
        }
      }}
      footer={(close) => (
        <>
          {confirmReset ? (
            <span className="mr-auto flex items-center gap-2 text-sm">
              Tout remettre comme à l'installation ?
              <Button
                size="sm"
                variant="danger"
                onPress={async () => {
                  await onReset();
                  setConfirmReset(false);
                  close();
                }}
              >
                Rétablir
              </Button>
              <Button size="sm" onPress={() => setConfirmReset(false)}>
                Non
              </Button>
            </span>
          ) : (
            <Button variant="ghost" onPress={() => setConfirmReset(true)} className="mr-auto">
              Rétablir les réglages par défaut
            </Button>
          )}
          <Button
            variant="primary"
            onPress={() => {
              commitName();
              close();
            }}
          >
            Fermer
          </Button>
        </>
      )}
    >
      <Tabs orientation="vertical" selectedKey={cat} onSelectionChange={(k) => setCat(k as Category)} className="flex min-h-80 gap-6 max-sm:flex-col">
        <TabList aria-label="Catégories" className="flex w-48 shrink-0 flex-col gap-0.5 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto">
          {CATEGORIES.map(([id, label]) => (
            <Tab
              key={id}
              id={id}
              className="focus-ring-inset cursor-default rounded-md px-3 py-2 text-base text-muted data-hovered:bg-surface-hover data-hovered:text-fg data-selected:bg-surface-selected data-selected:font-medium data-selected:text-fg"
            >
              {label}
            </Tab>
          ))}
        </TabList>

        <TabPanel id="general" className="flex flex-1 flex-col gap-5 outline-none">
          <Select
            label="Thème"
            options={[
              { id: "system", label: "Comme Windows" },
              { id: "light", label: "Clair" },
              { id: "dark", label: "Sombre" },
              { id: "contrast", label: "Contraste élevé" },
            ]}
            selectedKey={prefs.theme}
            onSelectionChange={(k) => onChange("theme", k as Theme)}
            className="max-w-72"
          />
          <section className="flex flex-col gap-2">
            <h3 className="text-base font-semibold">Lecteur PDF par défaut</h3>
            <p className="text-sm text-muted">
              Windows ne laisse aucune application se choisir elle-même. Dans les Paramètres, cherchez « .pdf » et choisissez PDFReader.
            </p>
            <Button size="sm" icon={<ExternalLink size={16} />} onPress={() => void engine.openSettings("defaultapps")} className="self-start">
              Ouvrir les applications par défaut
            </Button>
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="text-base font-semibold">Langue</h3>
            <p className="text-sm text-muted">Français. L'anglais arrive dans une prochaine version.</p>
          </section>
        </TabPanel>

        <TabPanel id="display" className="flex flex-1 flex-col gap-5 outline-none">
          <Select
            label="Zoom à l'ouverture d'un document"
            options={[
              { id: "fit-width", label: "Pleine largeur" },
              { id: "fit-page", label: "Page entière" },
              { id: "actual", label: "Taille réelle (100 %)" },
            ]}
            selectedKey={prefs.defaultZoom}
            onSelectionChange={(k) => onChange("defaultZoom", k as DefaultZoom)}
            className="max-w-72"
          />
          <Select
            label="Mode d'affichage à l'ouverture"
            options={[
              { id: "continuous", label: "Défilement continu" },
              { id: "single", label: "Une page à la fois" },
              { id: "double", label: "Deux pages à la fois" },
              { id: "continuous-double", label: "Deux pages en continu" },
            ]}
            selectedKey={prefs.defaultLayout}
            onSelectionChange={(k) => onChange("defaultLayout", k as Layout)}
            className="max-w-72"
          />
          <Switch isSelected={prefs.restoreView} onChange={(v) => onChange("restoreView", v)}>
            Rouvrir chaque document là où je l'ai laissé (page, zoom, mode)
          </Switch>
        </TabPanel>

        <TabPanel id="comments" className="flex flex-1 flex-col gap-5 outline-none">
          <TextField
            label="Nom d'auteur"
            description="Il signe vos commentaires et apparaît dans les autres lecteurs PDF."
            value={name}
            onChange={setName}
            onBlur={commitName}
            maxLength={100}
            className="max-w-80"
          />
        </TabPanel>

        <TabPanel id="documents" className="flex flex-1 flex-col gap-5 outline-none">
          <Switch isSelected={prefs.recovery} onChange={(v) => onChange("recovery", v)}>
            Garder une copie de récupération des modifications non enregistrées
          </Switch>
          <Select
            label="Fréquence des copies"
            isDisabled={!prefs.recovery}
            options={RECOVERY_MINUTES.map((m) => ({ id: String(m), label: m === 1 ? "Toutes les minutes" : `Toutes les ${m} minutes` }))}
            selectedKey={String(prefs.recoveryMinutes)}
            onSelectionChange={(k) => onChange("recoveryMinutes", Number(k))}
            className="max-w-72"
          />
          <p className="text-sm text-muted">
            Si PDFReader se ferme sans prévenir (panne, coupure de courant), il propose au démarrage suivant de récupérer ces documents. Les copies restent sur cet ordinateur et sont
            effacées dès que vous enregistrez ou fermez le document.
          </p>
        </TabPanel>

        <TabPanel id="accessibility" className="flex flex-1 flex-col gap-5 outline-none">
          <Select
            label="Taille de l'interface"
            options={UI_SCALES.map((v) => ({ id: String(v), label: `${String(v).replace(".", ",")} %` }))}
            selectedKey={String(prefs.uiScale)}
            onSelectionChange={(k) => onChange("uiScale", Number(k))}
            className="max-w-72"
          />
          <Switch isSelected={prefs.singleKeys} onChange={(v) => onChange("singleKeys", v)}>
            Raccourcis à une touche (V, U, N, D, E, T, S pour changer d'outil)
          </Switch>
          <p className="text-sm text-muted">
            Désactivez-les si vous utilisez la commande vocale ou un logiciel qui envoie des touches seules : les raccourcis avec Ctrl restent actifs.
          </p>
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}

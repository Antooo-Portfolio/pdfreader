/** S15 : propriétés du document (lecture seule) — description, avancé, sécurité, polices. */
import { Button, Dialog, locale, Spinner, t } from "@pdfreader/ui";
import { useEffect, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { parsePdfDate } from "./annot";
import type { DocInfo, DocProperties, EngineClient } from "./engine";

const TAB = "focus-ring-inset -mb-px cursor-default border-b-2 border-transparent px-3 py-2 text-base text-muted data-hovered:text-fg data-selected:border-accent data-selected:text-fg";

/** Formats de papier reconnus (points, portrait), tolérance de 3 points. */
const PAPERS: [string, number, number][] = [
  ["A3", 842, 1191],
  ["A4", 595, 842],
  ["A5", 420, 595],
  ["Letter", 612, 792],
  ["Legal", 612, 1008],
  ["Tabloid", 792, 1224],
];

export function paperName(w: number, h: number): string | null {
  const [a, b] = w <= h ? [w, h] : [h, w];
  const p = PAPERS.find(([, pw, ph]) => Math.abs(a - pw) <= 3 && Math.abs(b - ph) <= 3);
  return p ? p[0] : null;
}

export function formatSize(bytes: number): string {
  const n = (v: number, d = 1) => v.toLocaleString(locale(), { maximumFractionDigits: d });
  if (bytes < 1024) return t("{n} octets", { n: n(bytes, 0) });
  if (bytes < 1024 * 1024) return t("{n} Ko", { n: n(bytes / 1024) });
  if (bytes < 1024 * 1024 * 1024) return t("{n} Mo", { n: n(bytes / 1024 / 1024) });
  return t("{n} Go", { n: n(bytes / 1024 / 1024 / 1024, 2) });
}

function pageSize(size: [number, number] | null): string {
  if (!size) return "";
  const cm = (pt: number) => ((pt / 72) * 2.54).toLocaleString(locale(), { maximumFractionDigits: 1 });
  const paper = paperName(size[0], size[1]);
  const dims = t("{w} × {h} cm", { w: cm(size[0]), h: cm(size[1]) });
  return paper ? `${dims} (${paper})` : dims;
}

function security(rev: number | null): string {
  if (rev === null) return t("Aucune");
  if (rev === 2) return t("Mot de passe (RC4 40 bits, faible)");
  if (rev === 3) return t("Mot de passe (RC4 128 bits)");
  if (rev === 4) return t("Mot de passe (128 bits)");
  return t("Mot de passe (AES 256 bits)");
}

function longDate(raw: string): string {
  const d = parsePdfDate(raw);
  return d ? d.toLocaleString(locale(), { dateStyle: "long", timeStyle: "short" }) : raw;
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-4 gap-y-1.5 text-base">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words select-text">{v || <span className="text-muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PropertiesDialog({ engine, info, onClose }: { engine: EngineClient; info: DocInfo; onClose: () => void }) {
  const [props, setProps] = useState<DocProperties | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine
      .properties(info.id)
      .then(setProps)
      .catch((e) => setError(String(e)));
  }, [engine, info.id, info.generation]);

  const folder = info.path.slice(0, Math.max(0, info.path.length - info.name.length)).replace(/[\\/]$/, "");
  const yes = (b: boolean) => (b ? t("Oui") : t("Non"));
  const p = info.permissions;
  const allowed = (b: boolean) => (b ? t("Autorisé") : t("Interdit"));

  return (
    <Dialog
      title={t("Propriétés du document")}
      size="lg"
      isOpen
      onOpenChange={(o) => !o && onClose()}
      footer={(close) => (
        <Button variant="primary" onPress={close}>
          {t("Fermer")}
        </Button>
      )}
    >
      {!props ? (
        <div className="flex items-center gap-2 py-6 text-muted" role="status">
          {error ? t("Les propriétés n'ont pas pu être lues ({detail}).", { detail: error }) : <Spinner label={t("Lecture des propriétés…")} />}
        </div>
      ) : (
        <Tabs className="flex min-h-0 flex-col gap-3" data-properties>
          <TabList aria-label={t("Propriétés")} className="flex gap-1 border-b border-border">
            <Tab id="description" className={TAB}>
              {t("Description")}
            </Tab>
            <Tab id="advanced" className={TAB}>
              {t("Avancé")}
            </Tab>
            <Tab id="security" className={TAB}>
              {t("Sécurité")}
            </Tab>
            <Tab id="fonts" className={TAB}>
              {t("Polices")}
            </Tab>
          </TabList>
          <TabPanel id="description" className="outline-none">
            <Rows
              rows={[
                [t("Fichier"), info.name],
                [t("Dossier"), folder],
                [t("Titre"), props.title],
                [t("Auteur"), props.author],
                [t("Sujet"), props.subject],
                [t("Mots-clés"), props.keywords],
                [t("Créé le"), props.created ? longDate(props.created) : ""],
                [t("Modifié le"), props.modified ? longDate(props.modified) : ""],
                [t("Application"), props.creator],
                [t("Producteur PDF"), props.producer],
              ]}
            />
          </TabPanel>
          <TabPanel id="advanced" className="outline-none">
            <Rows
              rows={[
                [t("Version PDF"), props.version ?? ""],
                [t("Nombre de pages"), props.pageCount.toLocaleString(locale())],
                [t("Format de page"), pageSize(props.pageSize)],
                [t("Taille du fichier"), props.fileSize ? formatSize(props.fileSize) : ""],
                [t("PDF balisé"), yes(props.tagged)],
                [t("Affichage web rapide"), yes(props.linearized)],
              ]}
            />
          </TabPanel>
          <TabPanel id="security" className="outline-none">
            <Rows
              rows={[
                [t("Protection"), security(props.securityRevision)],
                [t("Impression"), p.print ? (p.printHighQuality ? t("Autorisée") : t("Autorisée en basse qualité")) : t("Interdite")],
                [t("Copie du texte"), allowed(p.copy)],
                [t("Commentaires"), allowed(p.annotate)],
                [t("Remplissage des formulaires"), allowed(p.fillForms)],
                [t("Modification du document"), allowed(p.modify)],
                [t("Assemblage des pages"), allowed(p.assemble)],
              ]}
            />
          </TabPanel>
          <TabPanel id="fonts" className="flex flex-col gap-2 outline-none">
            {props.fontsPages < props.pageCount && (
              <p className="text-sm text-muted">{t("Polices des {count} premières pages.", { count: props.fontsPages })}</p>
            )}
            {props.fonts.length === 0 ? (
              <p className="text-base text-muted">{t("Aucune police (document numérisé ou sans texte).")}</p>
            ) : (
              <ul className="max-h-72 overflow-auto rounded-md border border-border" aria-label={t("Polices")}>
                {props.fonts.map((f) => (
                  <li key={`${f.name}-${f.embedded}`} className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                    <span className="min-w-0 truncate text-base">{f.name}</span>
                    <span className="shrink-0 text-sm text-muted">{f.embedded ? (f.subset ? t("Incorporée (sous-ensemble)") : t("Incorporée")) : t("Non incorporée")}</span>
                  </li>
                ))}
              </ul>
            )}
          </TabPanel>
        </Tabs>
      )}
    </Dialog>
  );
}

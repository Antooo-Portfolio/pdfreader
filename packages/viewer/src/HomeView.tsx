import { Button, EmptyState, GridList, GridListItem, IconButton, Kbd, Spinner } from "@pdfreader/ui";
import { FileText, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { EngineClient, RecentFile } from "./engine";

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Aujourd'hui, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Hier, ${time}`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** S01 Accueil (M1 : fichiers récents seulement). */
export function HomeView({ engine, isActive, refreshKey, onOpenPath, onPick }: { engine: EngineClient; isActive: boolean; refreshKey: number; onOpenPath: (path: string) => void; onPick: () => void }) {
  const [recents, setRecents] = useState<RecentFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    engine
      .recents()
      .then((r) => {
        setRecents(r);
        setError(null);
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    if (isActive) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, refreshKey]);

  return (
    <main hidden={!isActive} aria-labelledby="home-title" className="min-h-0 flex-1 overflow-auto bg-surface">
      <div className="mx-auto flex max-w-(--layout-home-max) flex-col gap-6 px-8 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 id="home-title" className="text-xl">
            Fichiers récents
          </h1>
          <Button variant="primary" icon={<FolderOpen size={16} />} onPress={onPick}>
            Ouvrir un fichier
          </Button>
        </header>

        {error && <p className="text-danger">La liste des fichiers récents n'a pas pu être chargée : {error}</p>}

        {recents === null && !error && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner label="" /> Chargement…
          </p>
        )}

        {recents?.length === 0 && (
          <div className="rounded-lg border border-dashed border-border-strong bg-bg">
            <EmptyState icon={<FileText size={32} />} title="Aucun fichier récent" action={<Button variant="primary" icon={<FolderOpen size={16} />} onPress={onPick}>Ouvrir un PDF</Button>}>
              Ouvrez un PDF ou faites-le glisser sur cette fenêtre. Raccourci : <Kbd>Ctrl+O</Kbd>
            </EmptyState>
          </div>
        )}

        {recents && recents.length > 0 && (
          <GridList
            aria-label="Fichiers récents"
            items={recents}
            onAction={(key) => {
              const f = recents.find((r) => r.id === key);
              if (f?.exists) onOpenPath(f.path);
            }}
            className="flex flex-col gap-px rounded-lg border border-border bg-bg p-1"
          >
            {(f) => (
              <GridListItem id={f.id} textValue={f.name} className="flex h-16 items-center gap-3 px-3">
                <div className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-[2px] bg-page shadow-raised">
                  {f.exists ? (
                    <img src={engine.thumbUrl(f.id, f.lastOpenedAt)} alt="" className="h-full w-full object-cover object-top" />
                  ) : (
                    <FileText size={18} aria-hidden className="text-muted" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-base ${f.exists ? "" : "text-muted"}`}>{f.name}</div>
                  <div className="truncate text-xs text-muted">
                    {f.exists ? f.folder : "Fichier introuvable (déplacé ou supprimé)"} · {when(f.lastOpenedAt)}
                    {f.pageCount ? ` · ${f.pageCount} p.` : ""}
                  </div>
                </div>
                <IconButton
                  label={`Retirer « ${f.name} » des récents`}
                  size="sm"
                  icon={<X size={14} />}
                  onPress={() => engine.removeRecent(f.id).then(load)}
                />
              </GridListItem>
            )}
          </GridList>
        )}
      </div>
    </main>
  );
}

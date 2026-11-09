import { Button, EmptyState, GridList, GridListItem, IconButton, Kbd, SearchField, Spinner, ToolButton, ToolGroup } from "@pdfreader/ui";
import { clsx } from "clsx";
import { FileText, FolderOpen, LayoutGrid, List, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Tab, TabList, Tabs } from "react-aria-components";
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

type View = "list" | "grid";
type Filter = "recent" | "starred";

/** S01 Accueil : fichiers récents et favoris, recherche, liste ou vignettes. */
export function HomeView({ engine, isActive, refreshKey, onOpenPath, onPick }: { engine: EngineClient; isActive: boolean; refreshKey: number; onOpenPath: (path: string) => void; onPick: () => void }) {
  const [recents, setRecents] = useState<RecentFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("recent");
  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");

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

  useEffect(() => {
    engine
      .preferences()
      .then((p) => {
        if (p.homeView === "grid" || p.homeView === "list") setView(p.homeView);
      })
      .catch(() => undefined);
  }, [engine]);

  const chooseView = (v: View) => {
    setView(v);
    void engine.setPreference("homeView", v).catch(() => undefined);
  };

  const toggleStar = (f: RecentFile) => {
    setRecents((list) => list?.map((r) => (r.id === f.id ? { ...r, starred: !f.starred } : r)) ?? null);
    engine.starRecent(f.id, !f.starred).catch(() => load());
  };

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("fr");
    return (recents ?? []).filter((r) => (filter === "recent" || r.starred) && (!q || r.name.toLocaleLowerCase("fr").includes(q) || r.folder.toLocaleLowerCase("fr").includes(q)));
  }, [recents, filter, query]);
  const starredCount = recents?.filter((r) => r.starred).length ?? 0;

  const open = (key: React.Key) => {
    const f = recents?.find((r) => r.id === key);
    if (f?.exists) onOpenPath(f.path);
  };

  return (
    <main hidden={!isActive} aria-labelledby="home-title" className="min-h-0 flex-1 overflow-auto bg-surface">
      <div className="mx-auto flex max-w-(--layout-home-max) flex-col gap-5 px-8 py-8 max-sm:px-4">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 id="home-title" className="text-xl">
            Accueil
          </h1>
          <Button variant="primary" icon={<FolderOpen size={16} />} onPress={onPick}>
            Ouvrir un fichier
          </Button>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <Tabs selectedKey={filter} onSelectionChange={(k) => setFilter(k as Filter)}>
            <TabList aria-label="Fichiers" className="flex gap-1 border-b border-border">
              {(
                [
                  ["recent", "Récents"],
                  ["starred", `Favoris${starredCount ? ` (${starredCount})` : ""}`],
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
          </Tabs>
          <div className="flex items-center gap-2">
            <SearchField label="Rechercher un fichier" size="sm" placeholder="Rechercher un fichier" value={query} onChange={setQuery} className="w-60" />
            <ToolGroup
              aria-label="Présentation"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([view])}
              onSelectionChange={(keys) => {
                const k = [...keys][0];
                if (k === "list" || k === "grid") chooseView(k);
              }}
            >
              <ToolButton id="list" label="Liste" icon={<List size={18} />} />
              <ToolButton id="grid" label="Vignettes" icon={<LayoutGrid size={18} />} />
            </ToolGroup>
          </div>
        </div>

        {error && <p className="text-danger">La liste des fichiers n'a pas pu être chargée : {error}</p>}

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

        {recents && recents.length > 0 && shown.length === 0 && (
          <div className="rounded-lg border border-dashed border-border-strong bg-bg">
            {query.trim() ? (
              <EmptyState icon={<FileText size={32} />} title="Aucun fichier ne correspond" action={<Button onPress={() => setQuery("")}>Effacer la recherche</Button>}>
                Aucun nom ni dossier ne contient « {query.trim()} ».
              </EmptyState>
            ) : (
              <EmptyState icon={<Star size={32} />} title="Aucun favori">
                Cliquez sur l'étoile d'un fichier pour le retrouver ici.
              </EmptyState>
            )}
          </div>
        )}

        {shown.length > 0 && view === "list" && (
          <GridList aria-label={filter === "recent" ? "Fichiers récents" : "Favoris"} items={shown} onAction={open} className="flex flex-col gap-px rounded-lg border border-border bg-bg p-1">
            {(f) => (
              <GridListItem id={f.id} textValue={f.name} className="flex h-16 items-center gap-3 px-3">
                <div className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-[2px] bg-page shadow-raised">
                  {f.exists ? <img src={engine.thumbUrl(f.id, f.lastOpenedAt)} alt="" className="h-full w-full object-cover object-top" /> : <FileText size={18} aria-hidden className="text-muted" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={clsx("truncate text-base", !f.exists && "text-muted")}>{f.name}</div>
                  <div className="truncate text-xs text-muted">
                    {f.exists ? f.folder : "Fichier introuvable (déplacé ou supprimé)"} · {when(f.lastOpenedAt)}
                    {f.pageCount ? ` · ${f.pageCount} p.` : ""}
                  </div>
                </div>
                <StarButton f={f} onToggle={toggleStar} />
                <IconButton label={`Retirer « ${f.name} » des récents`} size="sm" icon={<X size={14} />} onPress={() => engine.removeRecent(f.id).then(load)} />
              </GridListItem>
            )}
          </GridList>
        )}

        {shown.length > 0 && view === "grid" && (
          <GridList
            aria-label={filter === "recent" ? "Fichiers récents" : "Favoris"}
            items={shown}
            onAction={open}
            layout="grid"
            className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3"
          >
            {(f) => (
              <GridListItem id={f.id} textValue={f.name} className="group flex flex-col gap-2 p-2">
                <div className="relative grid aspect-[3/4] w-full place-items-center overflow-hidden rounded-[2px] bg-page shadow-raised">
                  {f.exists ? <img src={engine.thumbUrl(f.id, f.lastOpenedAt)} alt="" className="h-full w-full object-cover object-top" /> : <FileText size={28} aria-hidden className="text-muted" />}
                  <div className="absolute top-1 right-1 rounded-pill bg-bg/90">
                    <StarButton f={f} onToggle={toggleStar} />
                  </div>
                </div>
                <div className="min-w-0">
                  <div className={clsx("truncate text-sm", !f.exists && "text-muted")} title={f.name}>
                    {f.name}
                  </div>
                  <div className="truncate text-xs text-muted">{f.exists ? when(f.lastOpenedAt) : "Introuvable"}</div>
                </div>
              </GridListItem>
            )}
          </GridList>
        )}
      </div>
    </main>
  );
}

function StarButton({ f, onToggle }: { f: RecentFile; onToggle: (f: RecentFile) => void }) {
  return (
    <IconButton
      label={f.starred ? `Retirer « ${f.name} » des favoris` : `Ajouter « ${f.name} » aux favoris`}
      size="sm"
      icon={<Star size={15} className={f.starred ? "fill-current text-warning" : undefined} />}
      onPress={() => onToggle(f)}
    />
  );
}

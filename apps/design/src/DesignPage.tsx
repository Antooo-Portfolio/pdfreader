import {
  annotationColors,
  Banner,
  Button,
  Checkbox,
  ColorSwatches,
  CommentCard,
  type CommentData,
  Dialog,
  DialogTrigger,
  DocumentTabs,
  EmptyState,
  FindBar,
  GridList,
  GridListItem,
  IconButton,
  Kbd,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PageNavigator,
  PageThumbnail,
  PanelHeader,
  Popover,
  ProgressBar,
  RadioGroup,
  SearchField,
  Select,
  SignaturePad,
  Slider,
  Spinner,
  Switch,
  TextField,
  ToastProvider,
  ToolButton,
  Toolbar,
  ToolbarSeparator,
  ToolGroup,
  Tree,
  ZoomControl,
  useToast,
} from "@pdfreader/ui";
import {
  Bookmark,
  Eraser,
  FileText,
  FolderOpen,
  Hand,
  Highlighter,
  Home,
  LayoutGrid,
  Menu as MenuIcon,
  MessageSquare,
  MousePointer2,
  Paperclip,
  PenLine,
  Printer,
  RotateCw,
  Save,
  Search,
  Settings,
  Signature,
  Star,
  StickyNote,
  Trash2,
  Type,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type Theme = "system" | "light" | "dark" | "contrast";

const roles = [
  "bg", "surface", "surface-raised", "surface-hover", "surface-selected", "canvas", "page",
  "border", "border-strong", "border-input", "text", "text-muted", "accent", "accent-hover",
  "accent-text", "on-accent", "focus", "danger", "on-danger", "success", "warning",
  "info-bg", "warning-bg", "danger-bg", "success-bg", "search-hit", "search-hit-current",
];

const typeScale: [string, string, string][] = [
  ["display", "text-display", "28 / 36 · 700"],
  ["xl", "text-xl", "22 / 28 · 600"],
  ["lg", "text-lg", "18 / 24 · 600"],
  ["md", "text-md", "16 / 24 · 400"],
  ["base", "text-base", "14 / 20 · 400 (base de l'interface)"],
  ["sm", "text-sm", "13 / 18 · 400"],
  ["xs", "text-xs", "12 / 16 · 500"],
];

const bookmarks = [
  { id: "1", label: "Résumé", page: 1 },
  {
    id: "2",
    label: "Conditions générales",
    page: 3,
    children: [
      { id: "2.1", label: "Objet du contrat", page: 3 },
      { id: "2.2", label: "Durée et résiliation", page: 5, children: [{ id: "2.2.1", label: "Préavis", page: 6 }] },
    ],
  },
  { id: "3", label: "Annexes", page: 12 },
];

const comments: CommentData[] = [
  {
    author: "Camille D.",
    when: "il y a 2 h",
    whenFull: "9 novembre 2026, 16:42",
    text: "Vérifier la date d'effet : elle ne correspond pas au devis.",
    color: annotationColors[0].value,
    kind: "Surlignage",
    page: 3,
    replies: [{ author: "Nour B.", when: "il y a 1 h", text: "Corrigé dans la v2." }],
  },
  {
    author: "Nour B.",
    when: "hier",
    whenFull: "8 novembre 2026, 10:05",
    text: "Clause à reformuler, trop vague.",
    color: annotationColors[2].value,
    kind: "Note",
    page: 5,
    resolved: true,
  },
];

const recents = [
  { id: "a", name: "Contrat de location 2026.pdf", where: "Documents", when: "Aujourd'hui, 16:40", starred: true },
  { id: "b", name: "Facture-0042.pdf", where: "Téléchargements", when: "Hier", starred: false },
  { id: "c", name: "Mémoire de fin d'études — version finale.pdf", where: "Bureau", when: "3 nov.", starred: false },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 id={id} className="text-xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs uppercase tracking-wide text-muted">{label}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function FakeLines({ n = 14 }: { n?: number }) {
  return (
    <div className="flex h-full flex-col justify-start gap-[3.5%] p-[10%]" aria-hidden>
      <div className="h-[3%] w-1/2 rounded-sm bg-black/70" />
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="h-[1.6%] rounded-sm bg-black/25" style={{ width: `${70 + ((i * 37) % 30)}%` }} />
      ))}
    </div>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <>
      <Button onPress={() => toast({ tone: "success", message: "Document enregistré" })}>Notification de succès</Button>
      <Button onPress={() => toast({ tone: "info", message: "Annotation supprimée", action: { label: "Annuler", onAction: () => {} } })}>
        Avec action « Annuler »
      </Button>
      <Button onPress={() => toast({ tone: "error", message: "Impossible d'enregistrer : le fichier est ouvert ailleurs" })}>Erreur</Button>
    </>
  );
}

/** Assemblage S03 : vérifie que les primitives tiennent ensemble dans la vraie disposition. */
function ReaderShell() {
  const [tool, setTool] = useState<Set<string | number>>(new Set(["select"]));
  const [page, setPage] = useState(3);
  const [zoom, setZoom] = useState(100);
  const [findOpen, setFindOpen] = useState(true);
  const [tab, setTab] = useState<string | number>("doc1");
  const highlighting = tool.has("highlight");
  return (
    <div className="flex h-[640px] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-raised">
      <div className="flex items-end gap-2 bg-surface px-2">
        <DocumentTabs
          selectedKey={tab}
          onSelectionChange={setTab}
          onClose={() => {}}
          tabs={[
            { id: "home", title: "Accueil", icon: <Home size={14} aria-hidden /> },
            { id: "doc1", title: "Contrat de location 2026.pdf", modified: true },
            { id: "doc2", title: "Facture-0042.pdf" },
          ]}
        />
      </div>
      <Toolbar aria-label="Barre d'outils principale" className="h-(--layout-toolbar) shrink-0 border-b border-border px-2">
        <MenuTrigger>
          <IconButton label="Menu" icon={<MenuIcon size={18} />} />
          <Menu>
            <MenuItem id="open" icon={<FolderOpen size={16} />} shortcut="Ctrl+O">Ouvrir…</MenuItem>
            <MenuItem id="save" icon={<Save size={16} />} shortcut="Ctrl+S">Enregistrer</MenuItem>
            <MenuItem id="saveas" shortcut="Ctrl+Maj+S">Enregistrer sous…</MenuItem>
            <MenuItem id="print" icon={<Printer size={16} />} shortcut="Ctrl+P">Imprimer…</MenuItem>
            <MenuSeparator />
            <MenuItem id="props" shortcut="Ctrl+D">Propriétés du document</MenuItem>
            <MenuItem id="prefs" icon={<Settings size={16} />} shortcut="Ctrl+K">Préférences</MenuItem>
          </Menu>
        </MenuTrigger>
        <IconButton label="Enregistrer" shortcut="Ctrl+S" icon={<Save size={18} />} />
        <IconButton label="Imprimer" shortcut="Ctrl+P" icon={<Printer size={18} />} />
        <ToolbarSeparator />
        <ToolGroup aria-label="Outils" selectionMode="single" disallowEmptySelection selectedKeys={tool} onSelectionChange={setTool}>
          <ToolButton id="select" label="Sélection" shortcut="V" icon={<MousePointer2 size={18} />} />
          <ToolButton id="hand" label="Main" shortcut="H" icon={<Hand size={18} />} />
          <ToolButton id="highlight" label="Surligner" shortcut="U" icon={<Highlighter size={18} />} />
          <ToolButton id="note" label="Note" shortcut="S" icon={<StickyNote size={18} />} />
          <ToolButton id="text" label="Zone de texte" shortcut="X" icon={<Type size={18} />} />
          <ToolButton id="draw" label="Dessin" shortcut="D" icon={<PenLine size={18} />} />
          <ToolButton id="erase" label="Gomme" icon={<Eraser size={18} />} />
          <ToolButton id="sign" label="Remplir et signer" icon={<Signature size={18} />} />
        </ToolGroup>
        <div className="ml-auto flex items-center gap-1">
          <PageNavigator page={page} total={14} onChange={setPage} />
          <ToolbarSeparator />
          <ZoomControl value={zoom} onChange={setZoom} />
          <IconButton label="Faire pivoter la vue" shortcut="Ctrl+Maj+=" icon={<RotateCw size={18} />} />
          <ToolbarSeparator />
          <IconButton label="Rechercher" shortcut="Ctrl+F" icon={<Search size={18} />} onPress={() => setFindOpen((o) => !o)} />
        </div>
      </Toolbar>
      {highlighting && (
        <Toolbar aria-label="Propriétés de Surligner" className="h-(--layout-propbar) shrink-0 gap-3 border-b border-border bg-surface px-3">
          <span className="text-sm text-muted">Couleur</span>
          <ColorSwatches aria-label="Couleur du surlignage" defaultValue={annotationColors[0].value} />
          <div className="w-40">
            <Slider label="Opacité" defaultValue={60} unit=" %" />
          </div>
        </Toolbar>
      )}
      <Banner tone="info" actions={<Button size="sm" variant="secondary">Mettre les champs en évidence</Button>} onDismiss={() => {}}>
        Ce document contient des champs de formulaire à remplir.
      </Banner>
      <div className="flex min-h-0 flex-1">
        <Toolbar aria-label="Panneaux" orientation="vertical" className="w-(--layout-panel-rail) shrink-0 border-r border-border bg-surface py-2">
          <ToolButton label="Vignettes" icon={<LayoutGrid size={18} />} isSelected />
          <ToolButton label="Signets" icon={<Bookmark size={18} />} />
          <ToolButton label="Pièces jointes" icon={<Paperclip size={18} />} />
        </Toolbar>
        <aside aria-label="Vignettes" className="flex w-44 shrink-0 flex-col border-r border-border bg-surface">
          <PanelHeader title="Pages" />
          <div className="overflow-auto px-2">
            {[2, 3, 4].map((p) => (
              <PageThumbnail key={p} page={p} current={p === page}>
                <FakeLines n={8} />
              </PageThumbnail>
            ))}
          </div>
        </aside>
        <main aria-label={`Document, page ${page} sur 14`} className="relative min-w-0 flex-1 overflow-auto bg-canvas">
          {findOpen && (
            <div className="sticky top-2 z-(--z-toolbar) flex justify-end px-3">
              <DemoFindBar onClose={() => setFindOpen(false)} />
            </div>
          )}
          <div className="mx-auto my-4 w-[440px]">
            <div className="pdf-page relative aspect-[1/1.414]">
              <FakeLines />
              <div aria-hidden className="absolute left-[10%] top-[30%] h-[2.4%] w-[46%] bg-annot-yellow mix-blend-multiply" />
              <div aria-hidden className="absolute left-[30%] top-[46%] h-[2.4%] w-[18%] bg-search-hit-current mix-blend-multiply" />
              <div aria-hidden className="absolute left-[60%] top-[62%] h-[2.4%] w-[14%] bg-search-hit mix-blend-multiply" />
              <div aria-hidden className="absolute right-[6%] top-[38%] grid size-6 place-items-center rounded-sm bg-annot-blue shadow-raised">
                <StickyNote size={14} className="text-black" />
              </div>
            </div>
          </div>
        </main>
        <aside aria-label="Commentaires" className="flex w-(--layout-commentpanel) shrink-0 flex-col border-l border-border bg-surface">
          <PanelHeader title="Commentaires (2)" actions={<IconButton label="Filtrer les commentaires" size="sm" icon={<MessageSquare size={16} />} />} />
          <div className="flex flex-col gap-2 overflow-auto p-3">
            <CommentCard c={comments[0]!} selected />
            <CommentCard c={comments[1]!} />
          </div>
        </aside>
      </div>
    </div>
  );
}

export function DesignPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const [uiZoom, setUiZoom] = useState("100");
  const [name, setName] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.fontSize = `${uiZoom}%`;
  }, [uiZoom]);

  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg text-fg">
        <header className="sticky top-0 z-(--z-toolbar) flex flex-wrap items-center gap-4 border-b border-border bg-bg/95 px-6 py-3 backdrop-blur">
          <div className="mr-auto">
            <h1 className="text-lg">PDFReader · système de design</h1>
            <p className="text-sm text-muted">Outil de développement (non livré) · jetons, primitives et assemblage du lecteur desktop. Rien d'Adobe.</p>
          </div>
          <Select
            label="Thème"
            size="sm"
            className="w-48"
            selectedKey={theme}
            onSelectionChange={(k) => setTheme(k as Theme)}
            options={[
              { id: "system", label: "Système" },
              { id: "light", label: "Clair" },
              { id: "dark", label: "Sombre" },
              { id: "contrast", label: "Contraste élevé" },
            ]}
          />
          <Select
            label="Zoom de l'interface"
            size="sm"
            className="w-40"
            selectedKey={uiZoom}
            onSelectionChange={(k) => setUiZoom(String(k))}
            options={[
              { id: "87.5", label: "87,5 %" },
              { id: "100", label: "100 %" },
              { id: "112.5", label: "112,5 %" },
              { id: "125", label: "125 %" },
              { id: "150", label: "150 %" },
            ]}
          />
        </header>

        <div className="mx-auto flex max-w-[1240px] flex-col gap-10 px-6 py-8">
          <Section id="assemblage" title="Assemblage : vue document (S03)">
            <ReaderShell />
          </Section>

          <Section id="couleurs" title="Rôles de couleur">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {roles.map((r) => (
                <div key={r} className="overflow-hidden rounded-md border border-border">
                  <div className="h-12" style={{ background: `var(--${r})` }} />
                  <div className="px-2 py-1.5 font-mono text-xs">{r}</div>
                </div>
              ))}
            </div>
            <Row label="Annotations (données du document, identiques dans tous les thèmes)">
              {annotationColors.map((c) => (
                <span key={c.id} className="flex items-center gap-1.5 text-sm">
                  <span className="size-5 rounded-pill shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" style={{ background: c.value }} />
                  {c.name}
                </span>
              ))}
            </Row>
          </Section>

          <Section id="typo" title="Typographie (Inter, OFL)">
            <div className="flex flex-col gap-2">
              {typeScale.map(([k, cls, spec]) => (
                <div key={k} className="flex items-baseline gap-4">
                  <span className="w-16 font-mono text-xs text-muted">{k}</span>
                  <span className={cls}>Lire, annoter, signer</span>
                  <span className="text-xs text-muted">{spec}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section id="boutons" title="Boutons">
            <Row label="Variantes">
              <Button variant="primary">Ouvrir un fichier</Button>
              <Button variant="secondary">Annuler</Button>
              <Button variant="ghost">Plus tard</Button>
              <Button variant="danger" icon={<Trash2 size={16} />}>Supprimer</Button>
            </Row>
            <Row label="Tailles">
              <Button variant="primary" size="sm">Petit</Button>
              <Button variant="primary" size="md">Moyen</Button>
              <Button variant="primary" size="lg">Grand</Button>
            </Row>
            <Row label="États">
              <Button variant="primary" isDisabled>Désactivé</Button>
              <Button variant="primary" isPending>Enregistrement</Button>
              <Button variant="secondary" isPending>Chargement</Button>
            </Row>
            <Row label="Boutons icône et outils (bascule)">
              <IconButton label="Imprimer" shortcut="Ctrl+P" icon={<Printer size={18} />} />
              <IconButton label="Rechercher" shortcut="Ctrl+F" icon={<Search size={18} />} variant="secondary" />
              <IconButton label="Préférences" icon={<Settings size={16} />} size="sm" />
              <ToolButton label="Surligner" shortcut="U" icon={<Highlighter size={18} />} defaultSelected />
              <ToolButton label="Note" shortcut="S" icon={<StickyNote size={18} />} />
            </Row>
          </Section>

          <Section id="champs" title="Champs">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6">
              <TextField label="Nom de l'auteur des commentaires" description="Affiché sur chaque annotation que vous créez." value={name} onChange={setName} placeholder="Votre nom" />
              <TextField label="Mot de passe du document" type="password" isInvalid errorMessage="Mot de passe incorrect. Réessayez." defaultValue="motdepasse" />
              <SearchField label="Rechercher dans les fichiers récents" placeholder="Rechercher" />
              <Select
                label="Mise à l'échelle"
                defaultSelectedKey="fit"
                options={[
                  { id: "fit", label: "Ajuster à la feuille" },
                  { id: "actual", label: "Taille réelle" },
                  { id: "shrink", label: "Réduire si trop grand" },
                  { id: "multi", label: "Plusieurs pages par feuille" },
                ]}
              />
              <Slider label="Taille des vignettes" defaultValue={50} unit=" %" />
              <TextField label="Désactivé" isDisabled defaultValue="Lecture seule" />
            </div>
          </Section>

          <Section id="selection" title="Cases, boutons radio, interrupteurs">
            <div className="flex flex-wrap gap-12">
              <div className="flex flex-col gap-1">
                <Checkbox defaultSelected>Imprimer les commentaires</Checkbox>
                <Checkbox>Recto verso</Checkbox>
                <Checkbox isIndeterminate>Toutes les pages</Checkbox>
                <Checkbox isDisabled>Désactivé</Checkbox>
              </div>
              <RadioGroup
                label="Pages à imprimer"
                defaultValue="all"
                options={[
                  { id: "all", label: "Toutes" },
                  { id: "current", label: "Page actuelle" },
                  { id: "range", label: "Plage personnalisée" },
                ]}
              />
              <div className="flex flex-col gap-1">
                <Switch defaultSelected>Raccourcis à une touche</Switch>
                <Switch>Restaurer la dernière vue</Switch>
                <Switch isDisabled>Désactivé</Switch>
              </div>
            </div>
          </Section>

          <Section id="superpositions" title="Menus, fenêtres, infobulles">
            <Row label="Déclencheurs">
              <MenuTrigger>
                <Button icon={<MenuIcon size={16} />}>Menu</Button>
                <Menu>
                  <MenuItem id="open" icon={<FolderOpen size={16} />} shortcut="Ctrl+O">Ouvrir…</MenuItem>
                  <MenuItem id="save" icon={<Save size={16} />} shortcut="Ctrl+S">Enregistrer</MenuItem>
                  <MenuItem id="print" icon={<Printer size={16} />} shortcut="Ctrl+P" isDisabled>Imprimer… (désactivé)</MenuItem>
                  <MenuSeparator />
                  <MenuItem id="delete" icon={<Trash2 size={16} />} destructive>Supprimer l'annotation</MenuItem>
                </Menu>
              </MenuTrigger>
              <DialogTrigger>
                <Button variant="primary" icon={<Signature size={16} />}>Créer une signature</Button>
                <Dialog
                  title="Créer votre signature"
                  footer={(close) => (
                    <>
                      <Button onPress={close}>Annuler</Button>
                      <Button variant="primary" onPress={close}>Utiliser cette signature</Button>
                    </>
                  )}
                >
                  <div className="flex flex-col gap-4">
                    <SignaturePad />
                    <Checkbox defaultSelected>Mémoriser sur cet appareil</Checkbox>
                  </div>
                </Dialog>
              </DialogTrigger>
              <DialogTrigger>
                <Button>Mot de passe (S04)</Button>
                <Dialog
                  title="Document protégé"
                  size="sm"
                  footer={(close) => (
                    <>
                      <Button onPress={close}>Annuler</Button>
                      <Button variant="primary" onPress={close}>Ouvrir</Button>
                    </>
                  )}
                >
                  <div className="flex flex-col gap-3">
                    <p className="text-base">« Contrat de location 2026.pdf » est protégé par un mot de passe.</p>
                    <TextField label="Mot de passe" type="password" autoFocus />
                  </div>
                </Dialog>
              </DialogTrigger>
              <DialogTrigger>
                <Button variant="danger">Fermer sans enregistrer</Button>
                <Dialog
                  title="Enregistrer les modifications ?"
                  size="sm"
                  role="alertdialog"
                  isDismissable={false}
                  footer={(close) => (
                    <>
                      <Button variant="danger" onPress={close}>Ne pas enregistrer</Button>
                      <Button onPress={close}>Annuler</Button>
                      <Button variant="primary" onPress={close}>Enregistrer</Button>
                    </>
                  )}
                >
                  <p className="text-base">Vos annotations de « Contrat de location 2026.pdf » seront perdues si vous fermez sans enregistrer.</p>
                </Dialog>
              </DialogTrigger>
              <DialogTrigger>
                <Button>Couleur (popover)</Button>
                <Popover className="p-3">
                  <div className="flex flex-col gap-2 outline-none" role="dialog" aria-label="Couleur de l'annotation">
                    <span className="text-sm font-medium">Couleur</span>
                    <ColorSwatches aria-label="Couleur de l'annotation" defaultValue={annotationColors[1].value} />
                  </div>
                </Popover>
              </DialogTrigger>
            </Row>
            <Row label="Raccourcis">
              <Kbd>Ctrl+F</Kbd>
              <Kbd>Ctrl+Maj+S</Kbd>
              <Kbd>Échap</Kbd>
            </Row>
          </Section>

          <Section id="retours" title="Bandeaux, notifications, progression, états vides">
            <div className="flex flex-col overflow-hidden rounded-md border border-border">
              <Banner tone="info" onDismiss={() => {}}>Ce document semble être un scan : la recherche de texte n'est pas disponible.</Banner>
              <Banner tone="warning" actions={<Button size="sm">En savoir plus</Button>}>Ce formulaire contient des calculs qui ne sont pas exécutés.</Banner>
              <Banner tone="danger">Ce fichier est endommagé : certaines pages ne peuvent pas être affichées.</Banner>
              <Banner tone="success">Signé par Camille Durand. La signature est valide.</Banner>
            </div>
            <Row label="Notifications">
              <ToastDemo />
            </Row>
            <div className="grid max-w-xl gap-4">
              <ProgressBar label="Préparation de l'impression" value={42} />
              <ProgressBar label="Chargement des pages" />
              <span className="flex items-center gap-2 text-sm text-muted">
                <Spinner /> Rendu de la page 3…
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              <div className="rounded-md border border-border bg-surface">
                <EmptyState icon={<FileText size={32} />} title="Aucun fichier récent" action={<Button variant="primary" icon={<FolderOpen size={16} />}>Ouvrir un PDF</Button>}>
                  Ouvrez un PDF ou déposez-le ici. Raccourci : <Kbd>Ctrl+O</Kbd>
                </EmptyState>
              </div>
              <div className="rounded-md border border-border bg-surface">
                <EmptyState icon={<MessageSquare size={32} />} title="Aucun commentaire">
                  Sélectionnez du texte puis choisissez Surligner ou Note pour commenter.
                </EmptyState>
              </div>
            </div>
          </Section>

          <Section id="collections" title="Signets, fichiers récents">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-md border border-border bg-surface">
                <PanelHeader title="Signets" />
                <div className="p-2">
                  <Tree aria-label="Signets" nodes={bookmarks} defaultExpandedKeys={["2"]} selectionMode="single" defaultSelectedKeys={["2.1"]} />
                </div>
              </div>
              <div className="rounded-md border border-border bg-bg">
                <PanelHeader title="Récents" />
                <GridList aria-label="Fichiers récents" selectionMode="single" className="flex flex-col p-1">
                  {recents.map((f) => (
                    <GridListItem key={f.id} id={f.id} textValue={f.name} className="flex h-12 items-center gap-3 px-3">
                      <FileText size={20} aria-hidden className="shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base">{f.name}</div>
                        <div className="text-xs text-muted">
                          {f.where} · {f.when}
                        </div>
                      </div>
                      {f.starred && <Star size={16} aria-label="Favori" className="fill-current text-warning" />}
                    </GridListItem>
                  ))}
                </GridList>
              </div>
            </div>
          </Section>

          <Section id="lecteur" title="Composants du lecteur">
            <Row label="Recherche (S05)">
              <DemoFindBar />
            </Row>
            <Row label="Commentaire (S08)">
              <div className="w-80">
                <CommentCard c={comments[0]!} />
              </div>
            </Row>
          </Section>
        </div>
      </div>
    </ToastProvider>
  );
}

/** Barre de recherche avec des résultats factices, pour la page de design. */
function DemoFindBar({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState("contrat");
  const [index, setIndex] = useState(3);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const total = query.trim() === "" || query.toLowerCase() === "introuvable" ? 0 : 27;
  return (
    <FindBar
      query={query}
      onQueryChange={setQuery}
      index={total ? index : 0}
      total={total}
      matchCase={matchCase}
      onMatchCaseChange={setMatchCase}
      wholeWord={wholeWord}
      onWholeWordChange={setWholeWord}
      onNext={() => setIndex((i) => (i < total ? i + 1 : 1))}
      onPrevious={() => setIndex((i) => (i > 1 ? i - 1 : total))}
      onClose={onClose}
    />
  );
}

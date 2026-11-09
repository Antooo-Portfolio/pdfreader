import { Button, Dialog, DocumentTabs, IconButton, Menu, MenuItem, MenuSection, MenuTrigger, Spinner, TextField, useToast } from "@pdfreader/ui";
import { Home, Palette } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { DEFAULT_STYLES, type Tool, type ToolStyle, type ToolStyles } from "./annot";
import { type DocActions, DocumentView } from "./DocumentView";
import { runE2E } from "./e2e";
import { type DocInfo, type EngineClient, isOpenError, type Theme } from "./engine";
import { HomeView } from "./HomeView";
import { reducer } from "./state";


const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "Comme Windows" },
  { id: "light", label: "Clair" },
  { id: "dark", label: "Sombre" },
  { id: "contrast", label: "Contraste élevé" },
];

/** Applique le thème : jetons CSS (attribut data-theme) et barre de titre de la fenêtre. */
function applyTheme(engine: EngineClient, theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  void engine.setWindowTheme(theme === "system" ? null : dark ? "dark" : "light").catch(() => undefined);
}

export interface AppActions {
  openPath(path: string, password?: string): Promise<DocInfo | null>;
  highlightSelection(): Promise<number>;
  /** Actions du document actif (commentaires). */
  doc(): DocActions | null;
  setAuthor(name: string): Promise<void>;
  save(id: number): Promise<boolean>;
  closeDoc(id: number): Promise<void>;
  activeId(): number | null;
}

export function App({ engine }: { engine: EngineClient }) {
  const toast = useToast();
  const [docs, dispatch] = useReducer(reducer, []);
  const [active, setActive] = useState<string>("home");
  const [tool, setTool] = useState<Tool>("select");
  const [styles, setStyles] = useState<ToolStyles>(DEFAULT_STYLES);
  const [author, setAuthor] = useState("");
  const docActions = useRef(new Map<number, DocActions>());
  const [opening, setOpening] = useState<string | null>(null);
  const [password, setPassword] = useState<{ path: string; wrong: boolean; value: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ ids: number[]; quit: boolean } | null>(null);
  const [homeRefresh, setHomeRefresh] = useState(0);
  const [theme, setTheme] = useState<Theme>("system");
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const activeDoc = docs.find((d) => String(d.info.id) === active) ?? null;

  useEffect(() => {
    engine.setTitle(activeDoc ? `${activeDoc.dirty ? "• " : ""}${activeDoc.info.name} — PDFReader` : "PDFReader");
  }, [engine, activeDoc]);

  // ------------------------------------------------------------ thème
  useEffect(() => {
    engine
      .preferences()
      .then((p) => {
        const t = p.theme;
        if (t === "light" || t === "dark" || t === "contrast" || t === "system") setTheme(t);
        // Styles des outils mémorisés : on ne garde que les entrées valides.
        const saved = p.toolStyles as Partial<Record<keyof ToolStyles, Partial<ToolStyle>>> | undefined;
        if (saved && typeof saved === "object") {
          setStyles((cur) => {
            const next = { ...cur };
            for (const k of Object.keys(cur) as (keyof ToolStyles)[]) {
              const v = saved[k];
              if (!v) continue;
              const color = Array.isArray(v.color) && v.color.length === 3 && v.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255) ? v.color : cur[k].color;
              const opacity = typeof v.opacity === "number" && v.opacity >= 0.1 && v.opacity <= 1 ? v.opacity : cur[k].opacity;
              const width = typeof v.width === "number" && v.width >= 0.25 && v.width <= 48 ? v.width : cur[k].width;
              next[k] = { color, opacity, width };
            }
            return next;
          });
        }
      })
      .catch(() => undefined);
  }, [engine]);
  useEffect(() => applyTheme(engine, theme), [engine, theme]);
  useEffect(() => {
    engine
      .author()
      .then(setAuthor)
      .catch(() => undefined);
  }, [engine]);
  const changeStyle = useCallback(
    (kind: keyof ToolStyles, patch: Partial<ToolStyle>) => {
      setStyles((cur) => {
        const next = { ...cur, [kind]: { ...cur[kind], ...patch } };
        void engine.setPreference("toolStyles", next).catch(() => undefined);
        return next;
      });
    },
    [engine],
  );
  const changeAuthor = useCallback(
    async (name: string) => {
      setAuthor(name);
      await engine.setPreference("author", name).catch(() => undefined);
    },
    [engine],
  );
  const chooseTheme = (t: Theme) => {
    setTheme(t);
    void engine.setPreference("theme", t).catch(() => undefined);
  };

  // ------------------------------------------------------------ ouverture
  const openPath = useCallback(
    async (path: string, pw?: string): Promise<DocInfo | null> => {
      const already = docsRef.current.find((d) => d.info.path.toLowerCase() === path.toLowerCase());
      if (already) {
        setActive(String(already.info.id));
        return already.info;
      }
      setOpening(path.split(/[\\/]/).pop() ?? path);
      try {
        const info = await engine.open(path, pw);
        dispatch({ type: "opened", info });
        setActive(String(info.id));
        setPassword(null);
        setHomeRefresh((n) => n + 1);
        return info;
      } catch (e) {
        if (isOpenError(e) && (e.kind === "password_required" || e.kind === "wrong_password")) {
          setPassword({ path, wrong: e.kind === "wrong_password", value: "" });
        } else if (isOpenError(e) && e.kind === "not_found") {
          toast({ tone: "error", message: "Ce fichier est introuvable : il a peut-être été déplacé ou supprimé." });
        } else if (isOpenError(e) && e.kind === "corrupted") {
          toast({ tone: "error", message: "Ce fichier est endommagé ou n'est pas un PDF valide." });
        } else {
          toast({ tone: "error", message: `Impossible d'ouvrir ce fichier (${isOpenError(e) ? (e.detail ?? e.kind) : String(e)}).` });
        }
        return null;
      } finally {
        setOpening(null);
      }
    },
    [engine, toast],
  );

  const pick = useCallback(async () => {
    for (const p of await engine.pickFiles()) await openPath(p);
  }, [engine, openPath]);

  // ------------------------------------------------------------ commentaires
  const highlightSelection = useCallback(async (): Promise<number> => {
    const a = docActions.current.get(Number(activeRef.current));
    if (!a) return 0;
    const n = await a.markupSelection("highlight");
    if (n === 0) toast({ tone: "info", message: "Sélectionnez d'abord du texte à surligner." });
    return engine.countHighlights(Number(activeRef.current), 0);
  }, [engine, toast]);

  const onAnnotated = useCallback((page: number) => {
    const id = Number(activeRef.current);
    if (id) dispatch({ type: "annotated", id, page });
  }, []);
  // Une fonction d'enregistrement stable par document.
  const registrars = useRef(new Map<number, (a: DocActions | null) => void>());
  const registerFor = (id: number) => {
    let f = registrars.current.get(id);
    if (!f) {
      f = (a) => {
        if (a) docActions.current.set(id, a);
        else docActions.current.delete(id);
      };
      registrars.current.set(id, f);
    }
    return f;
  };

  // ------------------------------------------------------------ enregistrement
  const save = useCallback(
    async (id: number, asPath?: string): Promise<boolean> => {
      const d = docsRef.current.find((x) => x.info.id === id);
      if (!d) return false;
      try {
        const r = await engine.save(id, asPath);
        dispatch({ type: "saved", id, generation: r.generation, path: r.path, fingerprint: r.fingerprint });
        toast({ tone: "success", message: `« ${r.path.split(/[\\/]/).pop()} » enregistré` });
        setHomeRefresh((n) => n + 1);
        return true;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("file_changed")) {
          toast({ tone: "error", message: "Le fichier a été modifié par un autre programme. Utilisez « Enregistrer sous » pour ne rien perdre.", action: { label: "Enregistrer sous", onAction: () => void saveAs(id) } });
        } else if (msg.includes("file_locked")) {
          toast({ tone: "error", message: "Le fichier est ouvert dans un autre programme.", action: { label: "Enregistrer sous", onAction: () => void saveAs(id) } });
        } else {
          toast({ tone: "error", message: `L'enregistrement a échoué : ${msg}` });
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, toast],
  );

  const saveAs = useCallback(
    async (id: number) => {
      const d = docsRef.current.find((x) => x.info.id === id);
      if (!d) return false;
      const target = await engine.pickSavePath(d.info.path);
      return target ? save(id, target) : false;
    },
    [engine, save],
  );

  // ------------------------------------------------------------ fermeture
  const reallyClose = useCallback(
    (id: number) => {
      engine.close(id);
      docActions.current.delete(id);
      dispatch({ type: "closed", id });
      setActive((a) => (a === String(id) ? "home" : a));
    },
    [engine],
  );

  const closeDoc = useCallback(
    async (id: number) => {
      const d = docsRef.current.find((x) => x.info.id === id);
      if (d?.dirty) setConfirmClose({ ids: [id], quit: false });
      else reallyClose(id);
    },
    [reallyClose],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    engine
      .onCloseRequested(async () => {
        const dirty = docsRef.current.filter((d) => d.dirty).map((d) => d.info.id);
        if (dirty.length === 0) return true;
        setConfirmClose({ ids: dirty, quit: true });
        return false;
      })
      .then((u) => (off = u));
    return () => off?.();
  }, [engine]);

  // ------------------------------------------------------------ fichiers reçus de l'extérieur
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      off = await engine.onExternalFiles((paths) => paths.forEach((p) => void openPath(p)));
      const launch = await engine.launchFiles();
      const e2e = await engine.e2eEnabled();
      let first: DocInfo | null = null;
      for (const p of launch) {
        const info = await openPath(p);
        first ??= info;
      }
      if (e2e && !cancelled) {
        const actions: AppActions = {
          openPath,
          highlightSelection,
          doc: () => docActions.current.get(Number(activeRef.current)) ?? null,
          setAuthor: changeAuthor,
          save,
          closeDoc: async (id) => reallyClose(id),
          activeId: () => Number(activeRef.current) || null,
        };
        const report = await runE2E(engine, actions, first, launch[0] ?? null);
        await engine.e2eReport(report);
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
    // Une seule fois au démarrage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ raccourcis
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const id = Number(activeRef.current);
      if (e.ctrlKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pick();
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (id) void saveAs(id);
      } else if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (id) void save(id);
      } else if (e.ctrlKey && (e.key.toLowerCase() === "w" || e.key === "F4")) {
        e.preventDefault();
        if (id) void closeDoc(id);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const order = ["home", ...docsRef.current.map((d) => String(d.info.id))];
        const i = order.indexOf(activeRef.current);
        setActive(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length] ?? "home");
      } else if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Raccourcis à une touche (désactivables dans les Préférences en M2).
        const k = e.key.toLowerCase();
        const byKey: Record<string, Tool> = { v: "select", u: "highlight", n: "note", d: "ink", e: "eraser", t: "text", s: "sign" };
        if (byKey[k]) setTool(byKey[k]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, save, saveAs, closeDoc]);

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="flex items-end gap-2 bg-surface px-2">
        <DocumentTabs
          selectedKey={active}
          onSelectionChange={(k) => setActive(String(k))}
          onClose={(id) => void closeDoc(Number(id))}
          tabs={[
            { id: "home", title: "Accueil", icon: <Home size={14} aria-hidden /> },
            ...docs.map((d) => ({ id: String(d.info.id), title: d.info.name, modified: d.dirty })),
          ]}
        />
        {opening && (
          <span className="mb-2 flex shrink-0 items-center gap-2 text-sm text-muted" role="status">
            <Spinner label="" /> Ouverture de {opening}…
          </span>
        )}
        <div className="mb-1 ml-auto shrink-0">
          <MenuTrigger>
            <IconButton label="Apparence" icon={<Palette size={18} />} />
            <Menu aria-label="Apparence">
              <MenuSection
                title="Thème"
                selectionMode="single"
                selectedKeys={[theme]}
                onSelectionChange={(keys) => {
                  const k = [...(keys as Set<string>)][0] as Theme | undefined;
                  if (k) chooseTheme(k);
                }}
              >
                {THEMES.map((t) => (
                  <MenuItem key={t.id} id={t.id}>
                    {t.label}
                  </MenuItem>
                ))}
              </MenuSection>
            </Menu>
          </MenuTrigger>
        </div>
      </div>

      <HomeView engine={engine} isActive={active === "home"} refreshKey={homeRefresh} onOpenPath={(p) => void openPath(p)} onPick={() => void pick()} />

      {docs.map((d) => (
        <DocumentView
          key={d.info.id}
          engine={engine}
          doc={d}
          isActive={active === String(d.info.id)}
          tool={tool}
          onToolChange={setTool}
          styles={styles}
          onStyleChange={changeStyle}
          author={author}
          onAuthorChange={(n) => void changeAuthor(n)}
          onAnnotated={onAnnotated}
          onSave={() => void save(d.info.id)}
          onOpen={() => void pick()}
          register={registerFor(d.info.id)}
        />
      ))}

      {password && (
        <Dialog
          title="Document protégé"
          size="sm"
          isOpen
          onOpenChange={(open) => !open && setPassword(null)}
          footer={(close) => (
            <>
              <Button onPress={close}>Annuler</Button>
              <Button variant="primary" onPress={() => void openPath(password.path, password.value)}>
                Ouvrir
              </Button>
            </>
          )}
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void openPath(password.path, password.value);
            }}
          >
            <p className="text-base">« {password.path.split(/[\\/]/).pop()} » est protégé par un mot de passe.</p>
            <TextField
              label="Mot de passe"
              type="password"
              autoFocus
              value={password.value}
              onChange={(value) => setPassword({ ...password, value })}
              isInvalid={password.wrong}
              errorMessage="Mot de passe incorrect. Réessayez."
            />
          </form>
        </Dialog>
      )}

      {confirmClose && (
        <Dialog
          title="Enregistrer les modifications ?"
          size="sm"
          role="alertdialog"
          isDismissable={false}
          isOpen
          footer={() => (
            <>
              <Button
                variant="danger"
                onPress={() => {
                  const { ids, quit } = confirmClose;
                  setConfirmClose(null);
                  if (quit) void engine.closeWindow();
                  else ids.forEach(reallyClose);
                }}
              >
                Ne pas enregistrer
              </Button>
              <Button onPress={() => setConfirmClose(null)}>Annuler</Button>
              <Button
                variant="primary"
                onPress={async () => {
                  const { ids, quit } = confirmClose;
                  setConfirmClose(null);
                  let ok = true;
                  for (const id of ids) ok = (await save(id)) && ok;
                  if (!ok) return;
                  if (quit) void engine.closeWindow();
                  else ids.forEach(reallyClose);
                }}
              >
                Enregistrer
              </Button>
            </>
          )}
        >
          <p className="text-base">
            {confirmClose.ids.length === 1
              ? `Les modifications de « ${docs.find((d) => d.info.id === confirmClose.ids[0])?.info.name} » seront perdues si vous ne les enregistrez pas.`
              : `${confirmClose.ids.length} documents ont des modifications non enregistrées.`}
          </p>
        </Dialog>
      )}
    </div>
  );
}

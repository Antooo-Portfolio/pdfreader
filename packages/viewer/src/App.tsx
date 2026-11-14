import { t, Button, Dialog, DocumentTabs, IconButton, isModalOpen, Menu, MenuItem, MenuSection, MenuTrigger, Spinner, useToast, TextField, msg, getLanguage, type Language, setLanguage, systemLanguage } from "@pdfreader/ui";
import { Home, Info, Palette, Settings } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AboutDialog, UpdateConsentDialog, UpdateDialog, type UpdateInfo } from "./AboutDialog";
import { DEFAULT_STYLES, type Tool, type ToolStyle, type ToolStyles } from "./annot";
import { type DocActions, DocumentView, type Immersive } from "./DocumentView";
import { runE2E, runStage } from "./e2e";
import { type DocInfo, type EngineClient, isOpenError, type RecoveryItem, type Theme } from "./engine";
import { HomeView } from "./HomeView";
import { DEFAULT_PREFS, DEFAULT_PRINT, parsePrefs, parsePrintSettings, type Prefs, type PrintSettings } from "./prefs";
import { PreferencesDialog } from "./PreferencesDialog";
import { PrintDialog } from "./PrintDialog";
import { PropertiesDialog } from "./PropertiesDialog";
import { RecoveryDialog } from "./RecoveryDialog";
import { reducer } from "./state";


const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: msg("Comme Windows") },
  { id: "light", label: msg("Clair") },
  { id: "dark", label: msg("Sombre") },
  { id: "contrast", label: msg("Contraste élevé") },
];

/** Taille de l'interface : la taille de police racine (tout est en rem). */
function applyScale(percent: number) {
  document.documentElement.style.fontSize = `${percent}%`;
}

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
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  prefs(): Prefs;
  openPrint(): void;
  openPreferences(): void;
  /** Copie de récupération immédiate des documents modifiés. */
  snapshotNow(): Promise<number>;
  /** Vérifie tout de suite si un fichier ouvert a été modifié ailleurs. */
  checkExternal(): Promise<void>;
  reload(id: number): Promise<boolean>;
  save(id: number, asPath?: string): Promise<boolean>;
  closeDoc(id: number): Promise<void>;
  activeId(): number | null;
  setImmersive(mode: Immersive): void;
  immersive(): Immersive;
  /** Boîte Propriétés du document actif : ouverte ou fermée. */
  setPropertiesOpen(open: boolean): void;
  /** Recharge les préférences enregistrées (après un import). */
  reloadPreferences(): Promise<void>;
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
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const theme = prefs.theme;
  // Langue de l'interface, appliquée avant le rendu des enfants (t() la lit à chaque rendu).
  // Les tests de bout en bout cherchent des textes français : ils forcent le français.
  const [e2eMode, setE2eMode] = useState(false);
  const lang: Language = e2eMode ? "fr" : prefs.language === "system" ? systemLanguage() : prefs.language;
  if (getLanguage() !== lang) setLanguage(lang);
  const [printSettings, setPrintSettings] = useState<PrintSettings>(DEFAULT_PRINT);
  const [printFor, setPrintFor] = useState<number | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryItem[] | null>(null);
  const [external, setExternal] = useState<Set<number>>(() => new Set());
  const [aboutOpen, setAboutOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [immersive, setImmersiveState] = useState<Immersive>(null);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  const [propertiesFor, setPropertiesFor] = useState<number | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const activeDoc = docs.find((d) => String(d.info.id) === active) ?? null;

  useEffect(() => {
    engine.setTitle(activeDoc ? `${activeDoc.dirty ? "• " : ""}${activeDoc.info.name} — PDFReader` : "PDFReader");
  }, [engine, activeDoc]);

  // ------------------------------------------------------------ thème
  const loadPreferences = useCallback(
    () =>
      engine.preferences().then((p) => {
        setPrefs(parsePrefs(p));
        setPrefsLoaded(true);
        setPrintSettings(parsePrintSettings(p.print));
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
      }),
    [engine],
  );
  useEffect(() => {
    loadPreferences().catch(() => undefined);
  }, [loadPreferences]);
  const importPreferences = useCallback(async () => {
    try {
      const n = await engine.importPreferences();
      if (n === null) return;
      await loadPreferences();
      setAuthor(await engine.author().catch(() => ""));
      toast({ tone: "success", message: t("{count} réglages importés.", { count: n }) });
    } catch (e) {
      toast({ tone: "error", message: String(e).includes("invalid_file") ? t("Ce fichier ne contient pas de préférences PDFReader.") : t("L'import a échoué : {detail}", { detail: String(e) }) });
    }
  }, [engine, loadPreferences, toast]);
  const exportPreferences = useCallback(async () => {
    try {
      const n = await engine.exportPreferences();
      if (n !== null) toast({ tone: "success", message: t("Préférences exportées ({count} réglages).", { count: n }) });
    } catch (e) {
      toast({ tone: "error", message: t("L'export a échoué : {detail}", { detail: String(e) }) });
    }
  }, [engine, toast]);
  useEffect(() => applyTheme(engine, theme), [engine, theme]);
  useEffect(() => applyScale(prefs.uiScale), [prefs.uiScale]);
  const setPref = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      setPrefs((cur) => ({ ...cur, [key]: value }));
      void engine.setPreference(key, value).catch(() => undefined);
    },
    [engine],
  );
  const resetPrefs = useCallback(async () => {
    await engine.resetPreferences().catch(() => undefined);
    setPrefs(DEFAULT_PREFS);
    setStyles(DEFAULT_STYLES);
    setPrintSettings(DEFAULT_PRINT);
    setAuthor(await engine.author().catch(() => ""));
    toast({ tone: "success", message: t("Réglages par défaut rétablis.") });
  }, [engine, toast]);
  const changePrintSettings = useCallback(
    (ps: PrintSettings) => {
      setPrintSettings(ps);
      void engine.setPreference("print", ps).catch(() => undefined);
    },
    [engine],
  );
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
  const chooseTheme = (t: Theme) => setPref("theme", t);

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
          toast({ tone: "error", message: t("Ce fichier est introuvable : il a peut-être été déplacé ou supprimé.") });
        } else if (isOpenError(e) && e.kind === "corrupted") {
          toast({ tone: "error", message: t("Ce fichier est endommagé ou n'est pas un PDF valide.") });
        } else {
          toast({ tone: "error", message: t("Impossible d'ouvrir ce fichier ({detail}).", { detail: isOpenError(e) ? (e.detail ?? e.kind) : String(e) }) });
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
    if (n === 0) toast({ tone: "info", message: t("Sélectionnez d'abord du texte à surligner.") });
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
        // Enregistré : les copies de récupération (sous l'ancien et le nouveau chemin) ne servent plus.
        await engine.recoveryClear(d.info.path).catch(() => undefined);
        if (r.path !== d.info.path) await engine.recoveryClear(r.path).catch(() => undefined);
        snapshotEdits.current.delete(id);
        toast({ tone: "success", message: t("« {name} » enregistré", { name: r.path.split(/[\\/]/).pop() ?? "" }) });
        setHomeRefresh((n) => n + 1);
        return true;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("file_changed")) {
          toast({ tone: "error", message: t("Le fichier a été modifié par un autre programme. Utilisez « Enregistrer sous » pour ne rien perdre."), action: { label: t("Enregistrer sous"), onAction: () => void saveAs(id) } });
        } else if (msg.includes("file_locked")) {
          toast({ tone: "error", message: t("Le fichier est ouvert dans un autre programme."), action: { label: t("Enregistrer sous"), onAction: () => void saveAs(id) } });
        } else {
          toast({ tone: "error", message: t("L'enregistrement a échoué : {detail}", { detail: msg }) });
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
      // Fermeture voulue (y compris « Ne pas enregistrer ») : plus rien à récupérer.
      const d = docsRef.current.find((x) => x.info.id === id);
      if (d) void engine.recoveryClear(d.info.path).catch(() => undefined);
      snapshotEdits.current.delete(id);
      setExternal((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
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

  // ------------------------------------------------------------ copies de récupération
  /** Nombre de modifications au moment de la dernière copie, par document. */
  const snapshotEdits = useRef(new Map<number, number>());
  const snapshotNow = useCallback(async (): Promise<number> => {
    let n = 0;
    for (const d of docsRef.current) {
      if (!d.dirty || snapshotEdits.current.get(d.info.id) === d.edits) continue;
      try {
        await engine.recoverySnapshot(d.info.id, d.info.path, d.info.fingerprint);
        snapshotEdits.current.set(d.info.id, d.edits);
        n++;
      } catch {
        // Disque plein ou document fermé entre-temps : on réessaiera au prochain tour.
      }
    }
    return n;
  }, [engine]);
  useEffect(() => {
    if (!prefs.recovery) return;
    const timer = window.setInterval(() => void snapshotNow(), prefs.recoveryMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [prefs.recovery, prefs.recoveryMinutes, snapshotNow]);

  // ------------------------------------------------------------ fichier modifié ailleurs
  const checkExternal = useCallback(async () => {
    for (const d of docsRef.current) {
      const changed = await engine.changedOnDisk(d.info.id).catch(() => false);
      setExternal((s) => {
        if (changed === s.has(d.info.id)) return s;
        const n = new Set(s);
        if (changed) n.add(d.info.id);
        else n.delete(d.info.id);
        return n;
      });
    }
  }, [engine]);
  useEffect(() => {
    const onFocus = () => void checkExternal();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkExternal();
    }, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [checkExternal]);
  const reload = useCallback(
    async (id: number): Promise<boolean> => {
      try {
        const info = await engine.reload(id);
        dispatch({ type: "reloaded", info });
        snapshotEdits.current.delete(id);
        void engine.recoveryClear(info.path).catch(() => undefined);
        setExternal((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return true;
      } catch (e) {
        toast({ tone: "error", message: t("Le fichier n'a pas pu être relu : il a peut-être été supprimé ou déplacé ({detail}).", { detail: String(e) }) });
        return false;
      }
    },
    [engine, toast],
  );

  // ------------------------------------------------------------ mises à jour (sur consentement)
  // Vérification automatique : seulement si l'utilisateur l'a acceptée, au plus une fois par jour,
  // jamais pendant les tests de bout en bout.
  useEffect(() => {
    if (!prefsLoaded || e2eMode || prefs.updates !== "auto") return;
    if (Date.now() - prefs.updatesLastCheck < 24 * 3600_000) return;
    setPref("updatesLastCheck", Date.now());
    engine
      .updateCheck()
      .then((u) => u && setUpdate(u))
      .catch(() => undefined); // hors ligne : on réessaiera demain
  }, [prefsLoaded, e2eMode, prefs.updates, prefs.updatesLastCheck, engine, setPref]);

  const setImmersive = useCallback(
    (mode: Immersive) => {
      setImmersiveState((cur) => {
        if ((cur === "fullscreen") !== (mode === "fullscreen")) void engine.setFullscreen(mode === "fullscreen").catch(() => undefined);
        return mode;
      });
    },
    [engine],
  );
  // Changer d'onglet ou fermer le document quitte ces modes.
  useEffect(() => {
    if (immersiveRef.current && !docs.some((d) => String(d.info.id) === active)) setImmersive(null);
  }, [active, docs, setImmersive]);
  const lastActive = useRef(active);
  useEffect(() => {
    if (lastActive.current !== active && immersiveRef.current) setImmersive(null);
    lastActive.current = active;
  }, [active, setImmersive]);

  const openPrint = useCallback(() => {
    const id = Number(activeRef.current);
    if (id) setPrintFor(id);
  }, []);

  // ------------------------------------------------------------ fichiers reçus de l'extérieur
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      off = await engine.onExternalFiles((paths) => paths.forEach((p) => void openPath(p)));
      const launch = await engine.launchFiles();
      const e2e = await engine.e2eEnabled();
      if (e2e) setE2eMode(true);
      // Copies laissées par une fermeture inattendue.
      const left = await engine.recoveryList().catch(() => [] as RecoveryItem[]);
      if (left.length && !cancelled) setRecovery(left);
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
          setPref,
          prefs: () => prefsRef.current,
          openPrint,
          openPreferences: () => setPrefsOpen(true),
          snapshotNow,
          checkExternal,
          reload,
          save,
          closeDoc: async (id) => reallyClose(id),
          activeId: () => Number(activeRef.current) || null,
          setImmersive,
          immersive: () => immersiveRef.current,
          setPropertiesOpen: (open) => setPropertiesFor(open ? Number(activeRef.current) || null : null),
          reloadPreferences: () => loadPreferences(),
        };
        const stage = await engine.e2eStage();
        const report = stage ? await runStage(stage, engine, actions, first) : await runE2E(engine, actions, first, launch[0] ?? null);
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
      // Boîte modale ouverte : elle seule réagit au clavier.
      if (isModalOpen()) return;
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const id = Number(activeRef.current);
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        // Remplace l'impression du navigateur intégré.
        e.preventDefault();
        openPrint();
      } else if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPrefsOpen(true);
      } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
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
      } else if (!typing && !e.ctrlKey && !e.altKey && !e.metaKey && prefsRef.current.singleKeys) {
        // Raccourcis à une touche (désactivables dans les Préférences, catégorie Accessibilité).
        const k = e.key.toLowerCase();
        const byKey: Record<string, Tool> = { v: "select", u: "highlight", n: "note", d: "ink", e: "eraser", t: "text", s: "sign" };
        if (byKey[k]) setTool(byKey[k]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, save, saveAs, closeDoc, openPrint]);

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <div className="flex items-end gap-2 bg-surface px-2" hidden={!!immersive}>
        <DocumentTabs
          selectedKey={active}
          onSelectionChange={(k) => setActive(String(k))}
          onClose={(id) => void closeDoc(Number(id))}
          tabs={[
            { id: "home", title: t("Accueil"), icon: <Home size={14} aria-hidden /> },
            ...docs.map((d) => ({ id: String(d.info.id), title: d.info.name, modified: d.dirty })),
          ]}
        />
        {opening && (
          <span className="mb-2 flex shrink-0 items-center gap-2 text-sm text-muted" role="status">
            <Spinner label="" /> {t("Ouverture de {name}…", { name: opening })}
          </span>
        )}
        <div className="mb-1 ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton label={t("À propos de PDFReader")} icon={<Info size={18} />} onPress={() => setAboutOpen(true)} />
          <IconButton label={t("Préférences")} shortcut="Ctrl+K" icon={<Settings size={18} />} onPress={() => setPrefsOpen(true)} />
          <MenuTrigger>
            <IconButton label={t("Apparence")} icon={<Palette size={18} />} />
            <Menu aria-label={t("Apparence")}>
              <MenuSection
                title={t("Thème")}
                selectionMode="single"
                selectedKeys={[theme]}
                onSelectionChange={(keys) => {
                  const k = [...(keys as Set<string>)][0] as Theme | undefined;
                  if (k) chooseTheme(k);
                }}
              >
                {THEMES.map((th) => (
                  <MenuItem key={th.id} id={th.id}>
                    {t(th.label)}
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
          onPrint={() => setPrintFor(d.info.id)}
          register={registerFor(d.info.id)}
          defaults={{ zoom: prefs.defaultZoom, layout: prefs.defaultLayout, restoreView: prefs.restoreView }}
          externalChange={external.has(d.info.id)}
          onReload={() => void reload(d.info.id)}
          onSaveAs={() => void saveAs(d.info.id)}
          immersive={active === String(d.info.id) ? immersive : null}
          onImmersive={setImmersive}
          onProperties={() => setPropertiesFor(d.info.id)}
          protectedView={prefs.protectedView}
          onOpenPath={(p) => void openPath(p)}
          hiddenTools={prefs.hiddenTools}
          onHiddenToolsChange={(tools) => setPref("hiddenTools", tools)}
          formScripts={prefs.formScripts}
        />
      ))}

      {printFor !== null &&
        (() => {
          const d = docs.find((x) => x.info.id === printFor);
          if (!d) return null;
          return (
            <PrintDialog
              engine={engine}
              info={d.info}
              currentPage={docActions.current.get(d.info.id)?.currentPage() ?? 1}
              settings={printSettings}
              onSettings={changePrintSettings}
              onClose={() => setPrintFor(null)}
            />
          );
        })()}
      {propertiesFor !== null &&
        (() => {
          const d = docs.find((x) => x.info.id === propertiesFor);
          return d ? <PropertiesDialog engine={engine} info={d.info} onClose={() => setPropertiesFor(null)} /> : null;
        })()}
      {prefsOpen && (
        <PreferencesDialog
          engine={engine}
          prefs={prefs}
          author={author}
          onChange={setPref}
          onAuthorChange={(n) => void changeAuthor(n)}
          onReset={resetPrefs}
          onExport={() => void exportPreferences()}
          onImport={() => void importPreferences()}
          onClose={() => setPrefsOpen(false)}
        />
      )}
      {aboutOpen && (
        <AboutDialog
          engine={engine}
          onUpdateFound={(u) => {
            setAboutOpen(false);
            setUpdate(u);
          }}
          onClose={() => setAboutOpen(false)}
        />
      )}
      {update && !aboutOpen && <UpdateDialog engine={engine} update={update} onClose={() => setUpdate(null)} />}
      {prefsLoaded && !e2eMode && prefs.updates === "ask" && !recovery?.length && !prefsOpen && !aboutOpen && (
        <UpdateConsentDialog onAnswer={(auto) => setPref("updates", auto ? "auto" : "off")} />
      )}
      {recovery && recovery.length > 0 && (
        <RecoveryDialog
          engine={engine}
          items={recovery}
          onRestored={(info) => {
            dispatch({ type: "opened", info, dirty: true });
            setActive(String(info.id));
          }}
          onDone={() => setRecovery(null)}
        />
      )}
      {password && (
        <Dialog
          title={t("Document protégé")}
          size="sm"
          isOpen
          onOpenChange={(open) => !open && setPassword(null)}
          footer={(close) => (
            <>
              <Button onPress={close}>{t("Annuler")}</Button>
              <Button variant="primary" onPress={() => void openPath(password.path, password.value)}>
                {t("Ouvrir")}
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
            <p className="text-base">{t("« {name} » est protégé par un mot de passe.", { name: password.path.split(/[\\/]/).pop() ?? "" })}</p>
            <TextField
              label={t("Mot de passe")}
              type="password"
              autoFocus
              value={password.value}
              onChange={(value) => setPassword({ ...password, value })}
              isInvalid={password.wrong}
              errorMessage={t("Mot de passe incorrect. Réessayez.")}
            />
          </form>
        </Dialog>
      )}

      {confirmClose && (
        <Dialog
          title={t("Enregistrer les modifications ?")}
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
                {t("Ne pas enregistrer")}
              </Button>
              <Button onPress={() => setConfirmClose(null)}>{t("Annuler")}</Button>
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
                {t("Enregistrer")}
              </Button>
            </>
          )}
        >
          <p className="text-base">
            {confirmClose.ids.length === 1
              ? t("Les modifications de « {name} » seront perdues si vous ne les enregistrez pas.", { name: docs.find((d) => d.info.id === confirmClose.ids[0])?.info.name ?? "" })
              : t("{count} documents ont des modifications non enregistrées.", { count: confirmClose.ids.length })}
          </p>
        </Dialog>
      )}
    </div>
  );
}

import { Button, Dialog, DocumentTabs, Spinner, TextField, useToast } from "@pdfreader/ui";
import { Home } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { DocumentView } from "./DocumentView";
import { runE2E } from "./e2e";
import { type DocInfo, type EngineClient, isOpenError } from "./engine";
import { HomeView } from "./HomeView";
import { selectionToPageRects } from "./selection";
import { reducer } from "./state";

const HIGHLIGHT_YELLOW: [number, number, number] = [255, 225, 77];

export interface AppActions {
  openPath(path: string, password?: string): Promise<DocInfo | null>;
  highlightSelection(): Promise<number>;
  save(id: number): Promise<boolean>;
  closeDoc(id: number): Promise<void>;
  activeId(): number | null;
}

export function App({ engine }: { engine: EngineClient }) {
  const toast = useToast();
  const [docs, dispatch] = useReducer(reducer, []);
  const [active, setActive] = useState<string>("home");
  const [tool, setTool] = useState<"select" | "highlight">("select");
  const [opening, setOpening] = useState<string | null>(null);
  const [password, setPassword] = useState<{ path: string; wrong: boolean; value: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ ids: number[]; quit: boolean } | null>(null);
  const [homeRefresh, setHomeRefresh] = useState(0);
  const pagesEls = useRef(new Map<number, HTMLDivElement>());
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const activeDoc = docs.find((d) => String(d.info.id) === active) ?? null;

  useEffect(() => {
    engine.setTitle(activeDoc ? `${activeDoc.dirty ? "• " : ""}${activeDoc.info.name} — PDFReader` : "PDFReader");
  }, [engine, activeDoc]);

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

  // ------------------------------------------------------------ surlignage
  const highlightSelection = useCallback(async (): Promise<number> => {
    const id = Number(activeRef.current);
    const root = pagesEls.current.get(id);
    if (!root) return 0;
    const byPage = selectionToPageRects(root);
    if (byPage.size === 0) {
      if (tool === "select") toast({ tone: "info", message: "Sélectionnez d'abord du texte à surligner." });
      return 0;
    }
    let total = 0;
    try {
      for (const [page, rects] of byPage) {
        total = await engine.addHighlight(id, page, rects, HIGHLIGHT_YELLOW);
        dispatch({ type: "annotated", id, page });
      }
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      toast({ tone: "error", message: `Le surlignage a échoué : ${String(e)}` });
    }
    return total;
  }, [engine, toast, tool]);

  // ------------------------------------------------------------ enregistrement
  const save = useCallback(
    async (id: number, asPath?: string): Promise<boolean> => {
      const d = docsRef.current.find((x) => x.info.id === id);
      if (!d) return false;
      try {
        const r = await engine.save(id, asPath);
        dispatch({ type: "saved", id, generation: r.generation, path: r.path });
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
      pagesEls.current.delete(id);
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
        const actions: AppActions = { openPath, highlightSelection, save, closeDoc: async (id) => reallyClose(id), activeId: () => Number(activeRef.current) || null };
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
        if (e.key === "v" || e.key === "V") setTool("select");
        if (e.key === "u" || e.key === "U") setTool("highlight");
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
          onZoom={(zoom) => dispatch({ type: "zoom", id: d.info.id, zoom })}
          onHighlightSelection={() => void highlightSelection()}
          onSave={() => void save(d.info.id)}
          onOpen={() => void pick()}
          pagesRef={(el) => {
            if (el) pagesEls.current.set(d.info.id, el);
          }}
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

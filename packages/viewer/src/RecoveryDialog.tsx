/** Récupération au démarrage : copies laissées par une fermeture inattendue. */
import { Button, Dialog, TextField } from "@pdfreader/ui";
import { FileWarning } from "lucide-react";
import { useState } from "react";
import { type DocInfo, type EngineClient, isOpenError, type RecoveryItem } from "./engine";

export function RecoveryDialog({
  engine,
  items,
  onRestored,
  onDone,
}: {
  engine: EngineClient;
  items: RecoveryItem[];
  onRestored: (info: DocInfo) => void;
  onDone: () => void;
}) {
  const [left, setLeft] = useState(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState<{ id: string; value: string; wrong: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = (id: string) => {
    const next = left.filter((i) => i.id !== id);
    setLeft(next);
    if (next.length === 0) onDone();
  };

  const restore = async (it: RecoveryItem, password?: string) => {
    setBusy(it.id);
    setError(null);
    try {
      const info = await engine.recoveryRestore(it.id, password);
      setNeedPassword(null);
      onRestored(info);
      finish(it.id);
    } catch (e) {
      if (isOpenError(e) && (e.kind === "password_required" || e.kind === "wrong_password")) {
        setNeedPassword({ id: it.id, value: "", wrong: e.kind === "wrong_password" });
      } else {
        setError(`« ${it.name} » n'a pas pu être récupéré (${isOpenError(e) ? (e.detail ?? e.kind) : String(e)}).`);
      }
    } finally {
      setBusy(null);
    }
  };

  const discard = async (it: RecoveryItem) => {
    await engine.recoveryDiscard(it.id).catch(() => undefined);
    finish(it.id);
  };

  return (
    <Dialog
      title="Récupérer vos documents"
      size="md"
      role="alertdialog"
      isDismissable={false}
      isOpen
      footer={() => (
        <>
          <Button
            onPress={async () => {
              for (const it of left) await engine.recoveryDiscard(it.id).catch(() => undefined);
              onDone();
            }}
          >
            Tout ignorer
          </Button>
          <Button
            variant="primary"
            isDisabled={busy !== null}
            onPress={async () => {
              for (const it of left) await restore(it);
            }}
          >
            Tout récupérer
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="text-base">PDFReader s'est fermé sans que ces documents soient enregistrés. Vos dernières modifications ont été gardées :</p>
        <ul className="flex flex-col gap-2" aria-label="Documents à récupérer">
          {left.map((it) => (
            <li key={it.id} className="flex flex-col gap-2 rounded-md border border-border p-2.5" data-recovery={it.name}>
              <div className="flex items-center gap-3">
                <FileWarning size={20} aria-hidden className="shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-medium">{it.name}</div>
                  <div className="truncate text-xs text-muted">
                    {it.originalPath} · copie du {new Date(it.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                </div>
                <Button size="sm" onPress={() => void discard(it)} isDisabled={busy === it.id}>
                  Ignorer
                </Button>
                <Button size="sm" variant="primary" onPress={() => void restore(it)} isPending={busy === it.id}>
                  Récupérer
                </Button>
              </div>
              {needPassword?.id === it.id && (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void restore(it, needPassword.value);
                  }}
                >
                  <TextField
                    label="Mot de passe du document"
                    type="password"
                    autoFocus
                    value={needPassword.value}
                    onChange={(value) => setNeedPassword({ ...needPassword, value })}
                    isInvalid={needPassword.wrong}
                    errorMessage="Mot de passe incorrect."
                    className="flex-1"
                  />
                  <Button size="sm" type="submit" variant="primary">
                    Ouvrir
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">Un document récupéré s'ouvre avec ses modifications : enregistrez-le (Ctrl+S) pour les garder dans le fichier d'origine.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

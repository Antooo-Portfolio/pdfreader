import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button as RACButton } from "react-aria-components";

type Tone = "info" | "warning" | "danger" | "success";

const toneClass: Record<Tone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "bg-info-bg border-l-accent", icon: "text-accent-text", Icon: Info },
  warning: { box: "bg-warning-bg border-l-warning", icon: "text-warning", Icon: AlertTriangle },
  danger: { box: "bg-danger-bg border-l-danger", icon: "text-danger", Icon: XCircle },
  success: { box: "bg-success-bg border-l-success", icon: "text-success", Icon: CheckCircle2 },
};

/** Bandeau de document (S03, S11). Fermable ; les actions sont de vrais boutons. */
export function Banner({ tone = "info", children, actions, onDismiss }: { tone?: Tone; children: ReactNode; actions?: ReactNode; onDismiss?: () => void }) {
  const t = toneClass[tone];
  return (
    <div
      role="status"
      className={clsx("flex min-h-10 items-center gap-3 border-b border-l-[3px] border-b-border px-3 py-1.5 text-base text-fg forced-colors:border", t.box)}
    >
      <t.Icon size={18} aria-hidden className={clsx("shrink-0", t.icon)} />
      <div className="flex-1">{children}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
      {onDismiss && (
        <RACButton
          onPress={onDismiss}
          aria-label="Masquer ce bandeau"
          className="focus-ring grid size-(--control-sm) place-items-center rounded-md text-muted data-hovered:bg-surface-hover"
        >
          <X size={16} aria-hidden />
        </RACButton>
      )}
    </div>
  );
}

/** État vide : icône, titre, phrase, une action. */
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="text-muted" aria-hidden>
        {icon}
      </div>
      <p className="text-lg text-fg">{title}</p>
      {children && <p className="max-w-80 text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* ---------------------------- Toasts ---------------------------- */

interface ToastItem {
  id: number;
  tone: "info" | "success" | "error";
  message: string;
  action?: { label: string; onAction: () => void };
}

const ToastContext = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});

export const useToast = () => useContext(ToastContext);

/** Région de notifications : polite (assertive pour les erreurs), 6 s minimum, pause au survol / focus. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    setItems((list) => [...list, { ...t, id: nextId.current++ }]);
  }, []);
  const remove = useCallback((id: number) => setItems((list) => list.filter((i) => i.id !== id)), []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 left-1/2 z-(--z-toast) flex -translate-x-1/2 flex-col items-center gap-2"
      >
        <div aria-live="polite" className="contents">
          {items.filter((i) => i.tone !== "error").map((i) => <Toast key={i.id} item={i} onClose={() => remove(i.id)} />)}
        </div>
        <div aria-live="assertive" className="contents">
          {items.filter((i) => i.tone === "error").map((i) => <Toast key={i.id} item={i} onClose={() => remove(i.id)} />)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(onClose, item.action ? 10000 : 6000);
    return () => clearTimeout(t);
  }, [paused, onClose, item.action]);
  const Icon = item.tone === "error" ? XCircle : item.tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex min-h-11 items-center gap-3 rounded-lg bg-fg py-2 pl-3 pr-2 text-base text-bg shadow-pop forced-colors:border forced-colors:border-[CanvasText]"
    >
      <Icon size={18} aria-hidden />
      <span>{item.message}</span>
      {item.action && (
        <RACButton
          onPress={() => {
            item.action?.onAction();
            onClose();
          }}
          className="focus-ring rounded-md px-2 py-1 font-semibold underline-offset-2 data-hovered:underline"
        >
          {item.action.label}
        </RACButton>
      )}
      <RACButton onPress={onClose} aria-label="Fermer la notification" className="focus-ring grid size-7 place-items-center rounded-md opacity-80 data-hovered:opacity-100">
        <X size={16} aria-hidden />
      </RACButton>
    </div>
  );
}

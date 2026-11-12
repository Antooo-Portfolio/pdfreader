import { t } from "../i18n";
import { clsx } from "clsx";
import type { ReactNode } from "react";

/** Raccourci clavier affiché. « Ctrl+F » est rendu « Ctrl F » avec chaque touche encadrée. */
export function Kbd({ children, inverted }: { children: ReactNode; inverted?: boolean }) {
  const keys = typeof children === "string" ? children.split("+") : [children];
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden={inverted ? true : undefined}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className={clsx(
            "rounded-sm border px-1 font-mono text-[0.6875rem] leading-4",
            inverted ? "border-bg/40 text-bg" : "border-border-strong text-muted",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

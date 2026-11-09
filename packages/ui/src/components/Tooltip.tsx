import type { ReactNode } from "react";
import { Tooltip as RACTooltip, type TooltipProps as RACTooltipProps } from "react-aria-components";
import { Kbd } from "./Kbd";

export interface TooltipProps extends Omit<RACTooltipProps, "children" | "className"> {
  children: ReactNode;
  shortcut?: string;
}

/** Infobulle : complément, jamais seule source d'information. Inversée (fond fg, texte bg). */
export function Tooltip({ children, shortcut, offset = 6, ...props }: TooltipProps) {
  return (
    <RACTooltip
      {...props}
      offset={offset}
      className="z-(--z-tooltip) flex items-center gap-2 rounded-sm bg-fg px-2 py-1 text-xs text-bg shadow-pop forced-colors:border forced-colors:border-[CanvasText]"
    >
      {children}
      {shortcut ? <Kbd inverted>{shortcut}</Kbd> : null}
    </RACTooltip>
  );
}

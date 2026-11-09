import { clsx } from "clsx";
import type { ReactNode } from "react";
import {
  Button as RACButton,
  type ButtonProps as RACButtonProps,
  ToggleButton as RACToggleButton,
  type ToggleButtonProps as RACToggleButtonProps,
  ToggleButtonGroup as RACToggleButtonGroup,
  type ToggleButtonGroupProps,
  TooltipTrigger,
} from "react-aria-components";
import { Spinner } from "./Progress";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md" | "lg";

const sizeClass: Record<ControlSize, string> = {
  sm: "h-(--control-sm) px-3 text-sm gap-1.5",
  md: "h-(--control-md) px-3.5 text-base gap-2",
  lg: "h-(--control-lg) px-5 text-md gap-2",
};

const squareClass: Record<ControlSize, string> = {
  sm: "size-(--control-sm)",
  md: "size-(--control-md)",
  lg: "size-(--control-lg)",
};

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent data-hovered:bg-accent-hover data-pressed:bg-accent-hover",
  secondary:
    "bg-bg text-fg border border-border-strong data-hovered:bg-surface-hover data-pressed:bg-surface-hover",
  ghost: "bg-transparent text-fg data-hovered:bg-surface-hover data-pressed:bg-surface-hover",
  danger:
    "bg-danger text-on-danger data-hovered:bg-danger-hover data-pressed:bg-danger-hover",
};

const base =
  "focus-ring transition-control inline-flex items-center justify-center rounded-md font-medium select-none whitespace-nowrap cursor-default data-disabled:opacity-45 data-disabled:cursor-not-allowed forced-colors:border forced-colors:border-[ButtonBorder]";

export interface ButtonProps extends Omit<RACButtonProps, "className" | "children"> {
  variant?: ButtonVariant;
  size?: ControlSize;
  className?: string;
  children?: ReactNode;
  /** Icône avant le libellé. */
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", className, icon, children, isPending, ...props }: ButtonProps) {
  return (
    <RACButton
      {...props}
      isPending={isPending}
      className={clsx(base, sizeClass[size], variantClass[variant], className)}
    >
      {isPending ? <Spinner size={16} label="" /> : icon}
      <span>{children}</span>
    </RACButton>
  );
}

export interface IconButtonProps extends Omit<RACButtonProps, "className" | "children" | "aria-label"> {
  /** Libellé obligatoire : lu par les lecteurs d'écran et affiché en infobulle. */
  label: string;
  /** Raccourci affiché dans l'infobulle, ex. « Ctrl+P ». */
  shortcut?: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary";
  size?: ControlSize;
  className?: string;
  /** Désactive l'infobulle (ex. bouton déjà accompagné d'un libellé visible). */
  noTooltip?: boolean;
}

export function IconButton({ label, shortcut, icon, variant = "ghost", size = "md", className, noTooltip, ...props }: IconButtonProps) {
  const button = (
    <RACButton
      {...props}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      className={clsx(base, squareClass[size], variantClass[variant], "p-0", className)}
    >
      {icon}
    </RACButton>
  );
  if (noTooltip) return button;
  return (
    <TooltipTrigger delay={600}>
      {button}
      <Tooltip shortcut={shortcut}>{label}</Tooltip>
    </TooltipTrigger>
  );
}

export interface ToolButtonProps extends Omit<RACToggleButtonProps, "className" | "children" | "aria-label"> {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  size?: ControlSize;
  className?: string;
}

/** Bouton d'outil (bascule). Sélectionné : fond + soulignement, lisible sans la couleur. */
export function ToolButton({ label, shortcut, icon, size = "md", className, ...props }: ToolButtonProps) {
  return (
    <TooltipTrigger delay={600}>
      <RACToggleButton
        {...props}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        className={clsx(
          base,
          squareClass[size],
          "relative p-0 text-fg data-hovered:bg-surface-hover",
          "data-selected:bg-surface-selected data-selected:text-accent-text",
          "after:absolute after:inset-x-2 after:bottom-0.5 after:h-0.5 after:rounded-pill after:bg-transparent data-selected:after:bg-accent",
          className,
        )}
      >
        {icon}
      </RACToggleButton>
      <Tooltip shortcut={shortcut}>{label}</Tooltip>
    </TooltipTrigger>
  );
}

export function ToolGroup({ className, ...props }: Omit<ToggleButtonGroupProps, "className"> & { className?: string }) {
  return <RACToggleButtonGroup {...props} className={clsx("flex items-center gap-0.5", className)} />;
}

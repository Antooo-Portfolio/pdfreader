import { clsx } from "clsx";
import { Check, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button as RACButton,
  Dialog as RACDialog,
  DialogTrigger,
  Header,
  Heading,
  Keyboard,
  Menu as RACMenu,
  MenuItem as RACMenuItem,
  type MenuItemProps as RACMenuItemProps,
  type MenuProps as RACMenuProps,
  MenuSection as RACMenuSection,
  type MenuSectionProps as RACMenuSectionProps,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover as RACPopover,
  type PopoverProps as RACPopoverProps,
  Separator,
  SubmenuTrigger,
  Text,
} from "react-aria-components";

export { DialogTrigger, MenuTrigger, SubmenuTrigger };

const surfacePop = "rounded-lg border border-border bg-surface-raised shadow-pop forced-colors:border-[CanvasText]";

export function Popover({ className, children, ...props }: Omit<RACPopoverProps, "className"> & { className?: string }) {
  return (
    <RACPopover offset={6} {...props} className={clsx(surfacePop, "z-(--z-popover) outline-none", className)}>
      {children}
    </RACPopover>
  );
}

export function Menu<T extends object>({ className, ...props }: Omit<RACMenuProps<T>, "className"> & { className?: string }) {
  return (
    <Popover className="min-w-52 p-1">
      <RACMenu {...props} className={clsx("max-h-[70vh] overflow-auto outline-none", className)} />
    </Popover>
  );
}

export interface MenuItemProps extends Omit<RACMenuItemProps, "className" | "children"> {
  children: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
  hasSubmenu?: boolean;
}

export function MenuItem({ children, icon, shortcut, destructive, hasSubmenu, ...props }: MenuItemProps) {
  const textValue = props.textValue ?? (typeof children === "string" ? children : undefined);
  return (
    <RACMenuItem
      {...props}
      textValue={textValue}
      className={clsx(
        "focus-ring-inset group flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-base outline-none",
        "data-focused:bg-surface-hover data-disabled:opacity-45",
        destructive ? "text-danger" : "text-fg",
      )}
    >
      {({ isSelected, selectionMode }) => (
        <>
          <span className="grid w-4 place-items-center text-muted" aria-hidden>
            {selectionMode !== "none" ? (isSelected ? <Check size={16} className="text-accent-text" /> : null) : icon}
          </span>
          <Text slot="label" className="flex-1 truncate">
            {children}
          </Text>
          {shortcut && (
            <Keyboard className="font-mono text-xs text-muted">{shortcut.replaceAll("+", " ")}</Keyboard>
          )}
          {hasSubmenu && <ChevronRight size={16} aria-hidden className="text-muted" />}
        </>
      )}
    </RACMenuItem>
  );
}

/** Groupe d'éléments de menu, avec titre facultatif. Avec `selectionMode`, ses éléments deviennent
 *  des choix (cases ou boutons radio pour les lecteurs d'écran). */
export function MenuSection<T extends object>({ title, className, children, ...props }: Omit<RACMenuSectionProps<T>, "className" | "children"> & { title?: string; className?: string; children: ReactNode }) {
  return (
    <RACMenuSection {...props} className={clsx("flex flex-col", className)}>
      {title && <Header className="px-2 pt-1.5 pb-1 text-xs font-semibold text-muted">{title}</Header>}
      {children}
    </RACMenuSection>
  );
}

export function MenuSeparator() {
  return <Separator className="mx-1 my-1 h-px bg-border" />;
}

export interface DialogProps {
  title: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  footer?: (close: () => void) => ReactNode;
  size?: "sm" | "md" | "lg";
  role?: "dialog" | "alertdialog";
  /** Une AlertDialog destructive ne se ferme pas avec Échap ni en cliquant à côté. */
  isDismissable?: boolean;
  /** Mode contrôlé (ouverture par programme, sans DialogTrigger). */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const widths = { sm: "w-[min(var(--layout-dialog-sm),calc(100vw-2rem))]", md: "w-[min(var(--layout-dialog-md),calc(100vw-2rem))]", lg: "w-[min(var(--layout-dialog-lg),calc(100vw-2rem))]" };

/** Boîte de dialogue modale. À placer dans un <DialogTrigger> après le bouton déclencheur. */
export function Dialog({ title, children, footer, size = "md", role = "dialog", isDismissable = true, isOpen, onOpenChange }: DialogProps) {
  return (
    <ModalOverlay
      {...(isOpen !== undefined ? { isOpen, onOpenChange } : {})}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className="fixed inset-0 z-(--z-dialog) grid place-items-center bg-black/40 p-4 data-entering:animate-[fade-in_var(--motion-base)_var(--motion-ease)] data-exiting:animate-[fade-in_var(--motion-fast)_reverse]"
    >
      <Modal className={clsx(surfacePop, widths[size], "max-h-[calc(100vh-2rem)] overflow-hidden")}>
        <RACDialog role={role} className="flex max-h-[calc(100vh-2rem)] flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
                <Heading slot="title" className="text-xl">
                  {title}
                </Heading>
                {isDismissable && (
                  <RACButton
                    onPress={close}
                    aria-label="Fermer"
                    className="focus-ring grid size-(--control-sm) place-items-center rounded-md text-muted data-hovered:bg-surface-hover"
                  >
                    <X size={18} aria-hidden />
                  </RACButton>
                )}
              </header>
              <div className="overflow-auto px-5 py-4">{typeof children === "function" ? children(close) : children}</div>
              {footer && (
                <footer className="flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">{footer(close)}</footer>
              )}
            </>
          )}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}

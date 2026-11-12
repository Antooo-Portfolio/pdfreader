import { t, msg } from "../i18n";
import { clsx } from "clsx";
import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button as RACButton,
  ColorSwatch,
  ColorSwatchPicker as RACColorSwatchPicker,
  ColorSwatchPickerItem,
  type ColorSwatchPickerProps,
  GridList as RACGridList,
  GridListItem as RACGridListItem,
  type GridListItemProps,
  type GridListProps,
  Tab,
  TabList,
  Tabs,
  type TabsProps,
  Toolbar as RACToolbar,
  type ToolbarProps,
  Tree as RACTree,
  TreeItem as RACTreeItem,
  TreeItemContent,
  type TreeProps,
} from "react-aria-components";

/* ---------------------------- Toolbar ---------------------------- */

export function Toolbar({ className, ...props }: Omit<ToolbarProps, "className"> & { className?: string }) {
  return (
    <RACToolbar
      {...props}
      className={clsx(
        "flex gap-0.5",
        props.orientation === "vertical" ? "flex-col items-center" : "items-center",
        className,
      )}
    />
  );
}

export function ToolbarSeparator({ vertical = true }: { vertical?: boolean }) {
  return <div role="separator" aria-orientation={vertical ? "vertical" : "horizontal"} className={vertical ? "mx-1 h-5 w-px bg-border" : "my-1 h-px w-5 bg-border"} />;
}

/* ---------------------------- Onglets de documents ---------------------------- */

export interface DocTab {
  id: string;
  title: string;
  modified?: boolean;
  icon?: ReactNode;
}

/** Barre d'onglets (S03). Le bouton fermer est réservé à la souris : Ctrl+W au clavier. */
export function DocumentTabs({ tabs, onClose, ...props }: Omit<TabsProps, "children" | "className"> & { tabs: DocTab[]; onClose?: (id: string) => void }) {
  return (
    <Tabs {...props} className="min-w-0 flex-1">
      <TabList aria-label={t("Documents ouverts")} className="flex h-(--layout-tabbar) items-end gap-px overflow-x-auto">
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            id={tab.id}
            className={clsx(
              "focus-ring-inset group relative flex h-9 min-w-30 max-w-60 cursor-default items-center gap-2 rounded-t-md px-3 text-sm text-muted transition-control",
              "data-hovered:bg-surface-hover data-selected:bg-bg data-selected:text-fg data-selected:shadow-[inset_0_2px_0_var(--accent)]",
              "forced-colors:data-selected:shadow-none forced-colors:data-selected:border-t-2 forced-colors:data-selected:border-[Highlight]",
            )}
          >
            {tab.icon}
            <span className="truncate">{tab.title}</span>
            {tab.modified && (
              <>
                <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-fg" />
                <span className="sr-only">{t(", modifié")}</span>
              </>
            )}
            {onClose && tab.id !== "home" && (
              <span
                aria-hidden
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="ml-auto grid size-5 place-items-center rounded-sm opacity-0 hover:bg-surface-hover group-hover:opacity-100 group-data-selected:opacity-100"
              >
                <X size={14} />
              </span>
            )}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/* ---------------------------- Arbre (signets) ---------------------------- */

export interface TreeNode {
  id: string;
  label: string;
  page?: number;
  children?: TreeNode[];
}

function TreeRows({ nodes }: { nodes: TreeNode[] }) {
  return (
    <>
      {nodes.map((n) => (
        <RACTreeItem
          key={n.id}
          id={n.id}
          textValue={n.label}
          className="focus-ring-inset group cursor-default rounded-sm outline-none data-hovered:bg-surface-hover data-selected:bg-surface-selected"
        >
          <TreeItemContent>
            {({ hasChildItems, level }) => (
              <div className="flex h-7 items-center gap-1 pr-2 text-base" style={{ paddingLeft: `${(level - 1) * 16 + 4}px` }}>
                {hasChildItems ? (
                  <RACButton slot="chevron" className="grid size-5 place-items-center rounded-sm text-muted">
                    <ChevronRight size={14} aria-hidden className="transition-transform duration-(--motion-fast) group-data-expanded:rotate-90" />
                  </RACButton>
                ) : (
                  <span className="w-5" />
                )}
                <span className="flex-1 truncate group-data-selected:text-accent-text">{n.label}</span>
                {n.page !== undefined && <span className="text-xs tabular-nums text-muted">{n.page}</span>}
              </div>
            )}
          </TreeItemContent>
          {n.children && <TreeRows nodes={n.children} />}
        </RACTreeItem>
      ))}
    </>
  );
}

export function Tree({ nodes, ...props }: Omit<TreeProps<TreeNode>, "children" | "className"> & { nodes: TreeNode[] }) {
  return (
    <RACTree {...props} className="flex flex-col gap-px outline-none">
      <TreeRows nodes={nodes} />
    </RACTree>
  );
}

/* ---------------------------- Listes / grilles ---------------------------- */

export function GridList<T extends object>({ className, ...props }: Omit<GridListProps<T>, "className"> & { className?: string }) {
  return <RACGridList {...props} className={clsx("outline-none", className)} />;
}

export function GridListItem({ className, ...props }: Omit<GridListItemProps, "className"> & { className?: string }) {
  return (
    <RACGridListItem
      {...props}
      className={clsx(
        "focus-ring-inset cursor-default rounded-md outline-none transition-control data-hovered:bg-surface-hover data-selected:bg-surface-selected",
        className,
      )}
    />
  );
}

/* ---------------------------- Couleurs d'annotation ---------------------------- */

export const annotationColors = [
  { id: "yellow", name: msg("Jaune"), value: "#ffe14d" },
  { id: "green", name: msg("Vert"), value: "#8de39a" },
  { id: "blue", name: msg("Bleu"), value: "#8cc8ff" },
  { id: "pink", name: msg("Rose"), value: "#ff9ecd" },
  { id: "orange", name: msg("Orange"), value: "#ffb468" },
  { id: "red", name: msg("Rouge"), value: "#e5484d" },
  { id: "purple", name: msg("Violet"), value: "#b28cff" },
  { id: "black", name: msg("Noir"), value: "#16181c" },
] as const;

/** Pastilles nommées : jamais la couleur seule. Valeurs = tokens annot-* (données du document). */
export function ColorSwatches(props: Omit<ColorSwatchPickerProps, "className" | "children">) {
  return (
    <RACColorSwatchPicker {...props} className="flex gap-1">
      {annotationColors.map((c) => (
        <ColorSwatchPickerItem
          key={c.id}
          color={c.value}
          className="focus-ring rounded-pill p-0.5 outline-none data-selected:shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--text)]"
        >
          <ColorSwatch colorName={t(c.name)} className="size-5 rounded-pill shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" />
        </ColorSwatchPickerItem>
      ))}
    </RACColorSwatchPicker>
  );
}

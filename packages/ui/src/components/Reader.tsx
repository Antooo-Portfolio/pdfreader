import { clsx } from "clsx";
import { CaseSensitive, ChevronDown, ChevronUp, MessageSquare, Minus, Plus, Undo2, WholeWord, X } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Group, Heading, Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { Button, IconButton, ToolButton } from "./Button";
import { NumberField, SearchField } from "./Fields";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "./Overlays";

/* ---------------------------- Zoom ---------------------------- */

export function ZoomControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const steps = [25, 50, 75, 100, 125, 150, 200, 300, 400];
  const next = (dir: 1 | -1) => {
    const list = dir === 1 ? steps : [...steps].reverse();
    onChange(list.find((s) => (dir === 1 ? s > value : s < value)) ?? value);
  };
  return (
    <Group aria-label="Zoom" className="flex items-center gap-0.5">
      <IconButton label="Zoom arrière" shortcut="Ctrl+-" icon={<Minus size={18} />} onPress={() => next(-1)} />
      <NumberField
        aria-label="Niveau de zoom"
        value={value}
        onChange={(v) => !Number.isNaN(v) && onChange(v)}
        minValue={8}
        maxValue={6400}
        hideStepper
        suffix="%"
        className="w-20"
      />
      <MenuTrigger>
        <IconButton label="Options de zoom" icon={<ChevronDown size={16} />} size="sm" />
        <Menu onAction={(k) => typeof k === "string" && /^\d+$/.test(k) && onChange(Number(k))}>
          <MenuItem id="fit-page" shortcut="Ctrl+0">Ajuster à la page</MenuItem>
          <MenuItem id="fit-width" shortcut="Ctrl+2">Ajuster à la largeur</MenuItem>
          <MenuItem id="100" shortcut="Ctrl+1">Taille réelle</MenuItem>
          <MenuSeparator />
          {[50, 75, 100, 125, 150, 200, 400].map((s) => (
            <MenuItem key={s} id={String(s)}>{`${s} %`}</MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <IconButton label="Zoom avant" shortcut="Ctrl+=" icon={<Plus size={18} />} onPress={() => next(1)} />
    </Group>
  );
}

/* ---------------------------- Navigation de pages ---------------------------- */

export function PageNavigator({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  return (
    <Group aria-label="Navigation dans les pages" className="flex items-center gap-1">
      <IconButton label="Page précédente" shortcut="Ctrl+PageUp" icon={<ChevronUp size={18} />} isDisabled={page <= 1} onPress={() => onChange(page - 1)} />
      <NumberField
        aria-label={`Numéro de page, sur ${total}`}
        value={page}
        onChange={(v) => !Number.isNaN(v) && onChange(Math.min(total, Math.max(1, v)))}
        minValue={1}
        maxValue={total}
        hideStepper
        className="w-14"
      />
      <span className="text-sm text-muted tabular-nums" aria-hidden>
        sur {total}
      </span>
      <IconButton label="Page suivante" shortcut="Ctrl+PageDown" icon={<ChevronDown size={18} />} isDisabled={page >= total} onPress={() => onChange(page + 1)} />
    </Group>
  );
}

/* ---------------------------- Recherche ---------------------------- */

export function FindBar({ onClose }: { onClose?: () => void }) {
  const [query, setQuery] = useState("contrat");
  const [index, setIndex] = useState(3);
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWhole] = useState(false);
  const total = query.trim() === "" ? 0 : query.toLowerCase() === "introuvable" ? 0 : 27;
  return (
    <div role="search" aria-label="Rechercher dans le document" className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised p-1.5 shadow-raised">
      <SearchField label="Rechercher" value={query} onChange={setQuery} size="sm" placeholder="Rechercher" className="w-56" />
      <span aria-live="polite" className={clsx("min-w-22 text-sm tabular-nums", total === 0 && query ? "text-danger" : "text-muted")}>
        {query === "" ? "" : total === 0 ? "Aucun résultat" : `${index} sur ${total}`}
      </span>
      <IconButton label="Résultat précédent" shortcut="Maj+Entrée" size="sm" icon={<ChevronUp size={16} />} isDisabled={total === 0} onPress={() => setIndex((i) => (i > 1 ? i - 1 : total))} />
      <IconButton label="Résultat suivant" shortcut="Entrée" size="sm" icon={<ChevronDown size={16} />} isDisabled={total === 0} onPress={() => setIndex((i) => (i < total ? i + 1 : 1))} />
      <ToolButton label="Respecter la casse" size="sm" icon={<CaseSensitive size={16} />} isSelected={caseSensitive} onChange={setCase} />
      <ToolButton label="Mot entier" size="sm" icon={<WholeWord size={16} />} isSelected={wholeWord} onChange={setWhole} />
      {onClose && <IconButton label="Fermer la recherche" shortcut="Échap" size="sm" icon={<X size={16} />} onPress={onClose} />}
    </div>
  );
}

/* ---------------------------- Vignette ---------------------------- */

export function PageThumbnail({ page, current, children }: { page: number; current?: boolean; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 p-2">
      <div
        className={clsx(
          "pdf-page aspect-[1/1.414] w-full overflow-hidden rounded-[2px]",
          current && "outline-2 outline-offset-2 outline-accent forced-colors:outline-[Highlight]",
        )}
      >
        {children}
      </div>
      <span className={clsx("text-xs tabular-nums", current ? "font-semibold text-fg" : "text-muted")}>{page}</span>
    </div>
  );
}

/* ---------------------------- Commentaire ---------------------------- */

export interface CommentData {
  author: string;
  when: string;
  whenFull: string;
  text: string;
  color: string;
  kind: string;
  page: number;
  replies?: { author: string; when: string; text: string }[];
  resolved?: boolean;
}

export function CommentCard({ c, selected }: { c: CommentData; selected?: boolean }) {
  return (
    <article
      aria-label={`${c.kind} de ${c.author}, page ${c.page}`}
      className={clsx(
        "flex flex-col gap-2 rounded-lg border bg-bg p-3 transition-control",
        selected ? "border-accent shadow-raised" : "border-border",
        c.resolved && "opacity-80",
      )}
    >
      <header className="flex items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-pill shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" style={{ background: c.color }} />
        <span className="text-sm font-semibold">{c.author}</span>
        <span className="text-xs text-muted" title={c.whenFull}>
          {c.when} · p. {c.page}
        </span>
        <span className="ml-auto text-xs text-muted">{c.kind}</span>
      </header>
      <p className={clsx("text-base", c.resolved && "text-muted line-through decoration-1")}>{c.text}</p>
      {c.replies?.map((r, i) => (
        <div key={i} className="ml-3 border-l-2 border-border pl-3">
          <p className="text-sm">
            <span className="font-semibold">{r.author}</span> <span className="text-xs text-muted">{r.when}</span>
          </p>
          <p className="text-sm">{r.text}</p>
        </div>
      ))}
      <footer className="flex gap-1">
        <Button size="sm" variant="ghost" icon={<MessageSquare size={14} />}>
          Répondre
        </Button>
        <Button size="sm" variant="ghost">
          {c.resolved ? "Rouvrir" : "Marquer comme résolu"}
        </Button>
      </footer>
    </article>
  );
}

/* ---------------------------- Signature ---------------------------- */

/** Création de signature (S12) : Taper (voie 100 % clavier), Dessiner, Image. */
export function SignaturePad() {
  const [name, setName] = useState("Camille Durand");
  return (
    <Tabs className="flex flex-col gap-3">
      <TabList aria-label="Méthode de signature" className="flex gap-1 border-b border-border">
        {[
          ["type", "Taper"],
          ["draw", "Dessiner"],
          ["image", "Image"],
        ].map(([id, label]) => (
          <Tab
            key={id}
            id={id}
            className="focus-ring-inset -mb-px cursor-default border-b-2 border-transparent px-3 py-2 text-base text-muted data-hovered:text-fg data-selected:border-accent data-selected:text-fg"
          >
            {label}
          </Tab>
        ))}
      </TabList>
      <TabPanel id="type" className="flex flex-col gap-3 outline-none">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Votre nom
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="focus-ring h-(--control-md) rounded-md border border-border-input bg-bg px-2.5 text-base font-normal"
          />
        </label>
        <div aria-label="Aperçu de la signature" role="img" className="grid h-32 place-items-center rounded-md border border-border bg-page">
          <span className="font-signature text-[2.75rem] leading-none text-annot-black">{name || " "}</span>
        </div>
      </TabPanel>
      <TabPanel id="draw" className="outline-none">
        <DrawPad />
      </TabPanel>
      <TabPanel id="image" className="outline-none">
        <div className="grid h-32 place-items-center rounded-md border border-dashed border-border-strong bg-surface text-sm text-muted">
          <div className="flex flex-col items-center gap-2">
            Déposez une image (PNG, JPEG ou SVG)
            <Button size="sm">Choisir un fichier</Button>
          </div>
        </div>
      </TabPanel>
    </Tabs>
  );
}

function DrawPad() {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * dpr;
    c.height = c.offsetHeight * dpr;
    const ctx = c.getContext("2d");
    ctx?.scale(dpr, dpr);
  }, []);
  const pos = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const ink = () => getComputedStyle(document.documentElement).getPropertyValue("--annot-black") || "#16181c";
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-32 rounded-md border border-border bg-page">
        <canvas
          ref={ref}
          aria-label="Zone de dessin de la signature. Pour signer au clavier, utilisez l'onglet Taper."
          className="absolute inset-0 size-full touch-none"
          onPointerDown={(e) => {
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const ctx = e.currentTarget.getContext("2d");
            if (!ctx) return;
            const [x, y] = pos(e);
            ctx.strokeStyle = ink();
            ctx.lineWidth = 2.2;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(x, y);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const ctx = e.currentTarget.getContext("2d");
            const [x, y] = pos(e);
            ctx?.lineTo(x, y);
            ctx?.stroke();
            setEmpty(false);
          }}
          onPointerUp={() => (drawing.current = false)}
        />
        <div aria-hidden className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-border-strong" />
        {empty && <span className="pointer-events-none absolute inset-x-0 top-3 text-center text-sm text-muted">Dessinez votre signature</span>}
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={<Undo2 size={14} />}
          isDisabled={empty}
          onPress={() => {
            const c = ref.current;
            c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
            setEmpty(true);
          }}
        >
          Effacer
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------- En-tête de panneau ---------------------------- */

export function PanelHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      <Heading level={2} className="text-base font-semibold">
        {title}
      </Heading>
      <div className="flex items-center gap-0.5">{actions}</div>
    </div>
  );
}

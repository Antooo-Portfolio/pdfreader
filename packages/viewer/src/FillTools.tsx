/** S11 (formulaires) et S12 (signature) : champs AcroForm superposés à la page, zone de saisie du
 *  texte libre, boîte de création de la signature. */
import { Button, Checkbox, Dialog } from "@pdfreader/ui";
import { clsx } from "clsx";
import { PenLine, Undo2 } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import type { Field, FieldInput, Rotation, SavedSignature, SignatureKind } from "./engine";
import { rotateBox } from "./layout";

/* ---------------------------------------------------------------- champs de formulaire */

/** Champs superposés à la page non tournée (dans le calque qui tourne avec elle). Les valeurs sont
 *  saisies dans de vrais contrôles HTML (clavier, lecteurs d'écran), puis confiées au moteur de
 *  formulaires de PDFium, qui met à jour la valeur et l'apparence du champ dans le PDF. */
export function FormLayer({
  fields,
  k,
  canFill,
  highlight,
  onSet,
  onSign,
}: {
  fields: Field[];
  k: number;
  canFill: boolean;
  highlight: boolean;
  onSet: (index: number, input: FieldInput) => void;
  onSign: (f: Field) => void;
}) {
  return (
    <div className="absolute inset-0">
      {fields.map((f) => (
        <FieldControl key={f.index} f={f} k={k} disabled={!canFill || f.readOnly} highlight={highlight} onSet={onSet} onSign={onSign} />
      ))}
    </div>
  );
}

const fieldFont = "Helvetica, Arial, sans-serif";

function FieldControl({ f, k, disabled, highlight, onSet, onSign }: { f: Field; k: number; disabled: boolean; highlight: boolean; onSet: (index: number, input: FieldInput) => void; onSign: (f: Field) => void }) {
  const [x, y, w, h] = f.rect;
  const box = { left: x * k, top: y * k, width: w * k, height: h * k };
  const [draft, setDraft] = useState(f.value);
  useEffect(() => setDraft(f.value), [f.value]);
  const label = f.label || f.name || "Champ";
  // Fond opaque : il masque l'apparence du champ rendue dans la page, que le contrôle remplace.
  const fill = highlight ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--page))]" : "bg-page";
  const size = f.fontSize > 0 ? f.fontSize * k : Math.min(h * k * 0.62, 14 * k);
  const common = clsx(
    "absolute text-annot-black outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed",
    f.required && highlight && !draft && "ring-1 ring-danger",
  );

  if (f.kind === "text") {
    const commit = () => {
      if (draft !== f.value) onSet(f.index, { kind: "text", value: draft });
    };
    const props = {
      "aria-label": label,
      "aria-required": f.required || undefined,
      title: label,
      value: draft,
      disabled,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
      onBlur: commit,
      onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onKeyDown: (e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") setDraft(f.value);
        if (e.key === "Enter" && !f.multiline) {
          e.preventDefault();
          commit();
        }
      },
      className: clsx(common, fill, "rounded-[1px] px-[0.15em] select-text"),
      style: { ...box, fontSize: size, fontFamily: fieldFont, letterSpacing: f.comb ? "0.4em" : undefined },
    };
    return f.multiline ? <textarea {...props} className={clsx(props.className, "resize-none leading-tight")} /> : <input type={f.password ? "password" : "text"} {...props} />;
  }

  if (f.kind === "checkbox" || f.kind === "radio") {
    return (
      <input
        type={f.kind}
        name={f.kind === "radio" ? `champ-${f.page}-${f.name}` : undefined}
        aria-label={f.kind === "radio" && f.exportValue ? `${label} : ${f.exportValue}` : label}
        title={label}
        checked={f.checked}
        disabled={disabled}
        onChange={(e) => onSet(f.index, { kind: "checked", checked: e.target.checked })}
        onClick={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        className={clsx(common, "m-0 cursor-pointer appearance-none rounded-[2px]", highlight && "bg-accent/15")}
        style={box}
      />
    );
  }

  if (f.kind === "combo" || f.kind === "list") {
    const selected = f.options.findIndex((o) => o.selected);
    return (
      <select
        aria-label={label}
        title={label}
        disabled={disabled}
        size={f.kind === "list" ? Math.max(2, Math.min(f.options.length, Math.floor(h / 12))) : undefined}
        value={selected >= 0 ? String(selected) : ""}
        onChange={(e) => onSet(f.index, { kind: "choice", index: Number(e.target.value) })}
        onClick={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
        className={clsx(common, fill, "rounded-[1px]")}
        style={{ ...box, fontSize: Math.min(size, h * k * 0.6), fontFamily: fieldFont }}
      >
        {selected < 0 && <option value="">—</option>}
        {f.options.map((o, i) => (
          <option key={i} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (f.kind === "signature") {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={`Signer ici : ${label}`}
        title="Signer ici"
        onClick={(e) => {
          e.stopPropagation();
          onSign(f);
        }}
        className={clsx(common, "flex items-center justify-center gap-1 rounded-[2px] border border-dashed border-accent text-accent-text", highlight ? "bg-accent/10" : "bg-transparent")}
        style={{ ...box, fontSize: Math.min(12, h * k * 0.4) }}
      >
        <PenLine size={Math.min(16, h * k * 0.5)} aria-hidden /> Signer ici
      </button>
    );
  }
  return null;
}

/* ---------------------------------------------------------------- texte libre */

/** Zone de saisie du texte posé sur la page (formulaire plat). Entrée valide, Maj+Entrée va à la
 *  ligne, Échap annule. */
export function TextDraft({
  at,
  size,
  k,
  rotation,
  pageSize,
  color,
  onCommit,
  onCancel,
}: {
  at: { x: number; y: number };
  size: number;
  k: number;
  rotation: Rotation;
  pageSize: [number, number];
  color: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const done = useRef(false);
  useEffect(() => ref.current?.focus(), []);
  const [dx, dy] = rotateBox([at.x, at.y, 0, 0], pageSize[0], pageSize[1], rotation);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && text.trim()) onCommit(text);
    else onCancel();
  };
  const lines = Math.max(1, text.split("\n").length);
  const longest = Math.max(4, ...text.split("\n").map((l) => l.length));
  return (
    <textarea
      ref={ref}
      aria-label="Texte à ajouter sur la page"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        }
      }}
      rows={lines}
      className="absolute z-(--z-popover) resize-none overflow-hidden rounded-[2px] border border-dashed border-accent bg-transparent p-0 leading-[1.2] outline-none select-text"
      style={{ left: dx * k, top: dy * k, fontSize: size * k, fontFamily: fieldFont, color, width: `${longest * 0.6 + 1}em`, minWidth: 40 }}
    />
  );
}

/* ---------------------------------------------------------------- création de la signature */

const INK = "#16181c";

/** Recadre un canevas sur ce qui est dessiné (pixels non transparents), avec une marge. */
function cropToPng(src: HTMLCanvasElement, pad = 8): string | null {
  const ctx = src.getContext("2d");
  if (!ctx) return null;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1 + pad * 2;
  const h = y1 - y0 + 1 + pad * 2;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")?.drawImage(src, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

async function typedToPng(text: string): Promise<string | null> {
  const font = '120px "Caveat Variable", Caveat, "Segoe Script", cursive';
  try {
    await document.fonts.load(font, text);
  } catch {
    // police système de secours
  }
  const c = document.createElement("canvas");
  const probe = c.getContext("2d");
  if (!probe) return null;
  probe.font = font;
  c.width = Math.min(4000, Math.ceil(probe.measureText(text).width) + 80);
  c.height = 220;
  const ctx = c.getContext("2d")!;
  ctx.font = font;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 40, 110);
  return cropToPng(c);
}

async function imageToPng(file: File, removeWhite: boolean): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (removeWhite) {
      // Signature scannée : le papier (pixels très clairs) devient transparent.
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = 0.299 * (d.data[i] ?? 0) + 0.587 * (d.data[i + 1] ?? 0) + 0.114 * (d.data[i + 2] ?? 0);
        if (lum > 225) d.data[i + 3] = 0;
      }
      ctx.putImageData(d, 0, 0);
    }
    return cropToPng(c, 4);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SignatureDialog({
  kind,
  initialName,
  onSave,
  onClose,
}: {
  kind: SignatureKind;
  initialName: string;
  onSave: (method: SavedSignature["method"], data: string, font: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"typed" | "drawn" | "image">("typed");
  const [name, setName] = useState(kind === "initials" ? initialsOf(initialName) : initialName);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (tab !== "image" || !file) return setPreview(null);
    imageToPng(file, removeWhite)
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setError("Cette image n'a pas pu être lue."));
    return () => {
      alive = false;
    };
  }, [tab, file, removeWhite]);

  const ready = tab === "typed" ? name.trim().length > 0 : tab === "drawn" ? !!drawn : !!preview;
  const title = kind === "initials" ? "Créer vos initiales" : "Créer votre signature";

  return (
    <Dialog
      title={title}
      size="md"
      isOpen
      onOpenChange={(o) => !o && onClose()}
      footer={(close) => (
        <>
          <Button onPress={close}>Annuler</Button>
          <Button
            variant="primary"
            isDisabled={!ready || busy}
            isPending={busy}
            onPress={async () => {
              setBusy(true);
              setError(null);
              try {
                const data = tab === "typed" ? await typedToPng(name.trim()) : tab === "drawn" ? drawn : preview;
                if (!data) throw new Error("vide");
                await onSave(tab, data, tab === "typed" ? "Caveat" : null);
                close();
              } catch (e) {
                setError(`L'enregistrement a échoué (${String(e)}).`);
              } finally {
                setBusy(false);
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Elle reste sur cet ordinateur et sera proposée chaque fois que vous signerez.</p>
        <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(k as typeof tab)} className="flex flex-col gap-3">
          <TabList aria-label="Méthode" className="flex gap-1 border-b border-border">
            {(
              [
                ["typed", "Taper"],
                ["drawn", "Dessiner"],
                ["image", "Image"],
              ] as const
            ).map(([id, label]) => (
              <Tab
                key={id}
                id={id}
                className="focus-ring-inset -mb-px cursor-default border-b-2 border-transparent px-3 py-2 text-base text-muted data-hovered:text-fg data-selected:border-accent data-selected:text-fg"
              >
                {label}
              </Tab>
            ))}
          </TabList>
          <TabPanel id="typed" className="flex flex-col gap-3 outline-none">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {kind === "initials" ? "Vos initiales" : "Votre nom"}
              <input
                value={name}
                autoFocus
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                className="focus-ring h-(--control-md) rounded-md border border-border-input bg-bg px-2.5 text-base font-normal"
              />
            </label>
            <div aria-hidden className="grid h-32 place-items-center overflow-hidden rounded-md border border-border bg-page">
              <span className="font-signature text-[3rem] leading-none text-annot-black">{name || " "}</span>
            </div>
          </TabPanel>
          <TabPanel id="drawn" className="outline-none">
            <DrawPad onChange={setDrawn} />
          </TabPanel>
          <TabPanel id="image" className="flex flex-col gap-3 outline-none">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Image de votre signature (PNG ou JPEG)
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm font-normal" />
            </label>
            <Checkbox isSelected={removeWhite} onChange={setRemoveWhite}>
              Rendre le fond blanc transparent
            </Checkbox>
            <div className="grid h-32 place-items-center rounded-md border border-border bg-page">
              {preview ? <img src={preview} alt="Aperçu de la signature" className="max-h-28 max-w-full" /> : <span className="text-sm text-muted">Aucune image choisie</span>}
            </div>
          </TabPanel>
        </Tabs>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function initialsOf(name: string) {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => `${w[0]?.toUpperCase() ?? ""}.`)
    .join("");
}

function DrawPad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // Résolution double pour une signature nette une fois posée.
    c.width = c.offsetWidth * 2;
    c.height = c.offsetHeight * 2;
  }, []);
  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height] as const;
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-32 rounded-md border border-border bg-page">
        <canvas
          ref={ref}
          aria-label="Zone de dessin de la signature. Au clavier, utilisez l'onglet Taper."
          className="absolute inset-0 size-full touch-none"
          onPointerDown={(e) => {
            drawing.current = true;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // sans capture
            }
            const ctx = e.currentTarget.getContext("2d");
            if (!ctx) return;
            const [x, y] = pos(e);
            ctx.strokeStyle = INK;
            ctx.lineWidth = 5;
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
          onPointerUp={(e) => {
            drawing.current = false;
            onChange(cropToPng(e.currentTarget));
          }}
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
            onChange(null);
          }}
        >
          Effacer
        </Button>
      </div>
    </div>
  );
}

import { t, PanelHeader, Button, Checkbox, IconButton, EmptyState, Menu, MenuItem, MenuTrigger, ProgressBar, SearchField, Select, TextField, locale, msg } from "@pdfreader/ui";
import { clsx } from "clsx";
import { CircleCheck, MessageSquare, Pencil, Reply, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDate, KIND_LABELS, parsePdfDate, STATUS_LABELS, toHex } from "./annot";
import type { Annot, AnnotKind, ReviewStatus } from "./engine";

type Sort = "page" | "newest" | "oldest" | "author";

const TYPE_FILTERS: { id: string; label: string; kinds?: AnnotKind[] }[] = [
  { id: "all", label: msg("Tous les types") },
  { id: "highlight", label: msg("Surlignages"), kinds: ["highlight"] },
  { id: "underline", label: msg("Soulignés et barrés"), kinds: ["underline", "strikeout", "squiggly"] },
  { id: "note", label: msg("Notes"), kinds: ["note"] },
  { id: "ink", label: msg("Dessins"), kinds: ["ink"] },
  { id: "shapes", label: msg("Formes"), kinds: ["line", "arrow", "square", "circle", "polygon", "polyline", "cloud"] },
  { id: "stamp", label: msg("Tampons"), kinds: ["stamp"] },
  { id: "other", label: msg("Autres"), kinds: ["freetext", "text", "textbox", "callout", "mark", "signature", "other"] },
];

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: msg("Tous les statuts") },
  { id: "none", label: msg("Sans statut") },
  { id: "accepted", label: STATUS_LABELS.accepted },
  { id: "rejected", label: STATUS_LABELS.rejected },
  { id: "cancelled", label: STATUS_LABELS.cancelled },
  { id: "completed", label: STATUS_LABELS.completed },
  { id: "marked", label: msg("Cochés") },
];

const time = (a: Annot) => parsePdfDate(a.modified ?? a.created)?.getTime() ?? 0;
const unknownAuthor = () => t("Auteur inconnu");

/** S08 : tous les commentaires du document, filtrés et triés ; modifier le texte, répondre,
 *  donner un statut, cocher, supprimer, aller au commentaire. C'est aussi la voie au clavier
 *  pour tout ce qui se fait à la souris sur la page. */
export function CommentsPanel({
  annots,
  pageCount,
  pagesLoaded,
  selected,
  author,
  canEdit,
  onAuthorChange,
  onSelect,
  onSave,
  onDelete,
  onReply,
  onStatus,
  onMarked,
  onClose,
}: {
  annots: Map<number, Annot[]>;
  pageCount: number;
  pagesLoaded: number;
  selected: { page: number; id: string } | null;
  author: string;
  canEdit: boolean;
  onAuthorChange: (name: string) => void;
  onSelect: (a: Annot) => void;
  onSave: (a: Annot, text: string) => void;
  onDelete: (a: Annot) => void;
  onReply: (a: Annot, text: string) => void;
  onStatus: (a: Annot, status: ReviewStatus | "") => void;
  onMarked: (a: Annot, marked: boolean) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState("all");
  const [who, setWho] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<Sort>("page");
  const [query, setQuery] = useState("");
  const [editingAuthor, setEditingAuthor] = useState<string | null>(null);

  const flat = useMemo(() => [...annots.values()].flat(), [annots]);
  const all = useMemo(() => flat.filter((a) => !a.replyTo), [flat]);
  // Réponses de chaque commentaire, de la plus ancienne à la plus récente.
  const replies = useMemo(() => {
    const m = new Map<string, Annot[]>();
    for (const a of flat) {
      if (!a.replyTo) continue;
      const key = `${a.page}:${a.replyTo}`;
      m.set(key, [...(m.get(key) ?? []), a]);
    }
    m.forEach((list) => list.sort((x, y) => time(x) - time(y)));
    return m;
  }, [flat]);
  const authors = useMemo(() => [...new Set(all.map((a) => a.author || unknownAuthor()))].sort((a, b) => a.localeCompare(b, locale())), [all]);
  const shown = useMemo(() => {
    const kinds = TYPE_FILTERS.find((f) => f.id === type)?.kinds;
    const q = query.trim().toLocaleLowerCase(locale());
    const matches = (a: Annot) => a.contents.toLocaleLowerCase(locale()).includes(q) || a.author.toLocaleLowerCase(locale()).includes(q);
    const list = all.filter(
      (a) =>
        (!kinds || kinds.includes(a.kind)) &&
        (who === "all" || (a.author || unknownAuthor()) === who) &&
        (status === "all" || (status === "none" ? !a.status : status === "marked" ? a.marked : a.status === status)) &&
        (!q || matches(a) || (replies.get(`${a.page}:${a.id}`) ?? []).some(matches)),
    );
    const byPage = (a: Annot, b: Annot) => a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0];
    return list.sort((a, b) =>
      sort === "page" ? byPage(a, b) : sort === "newest" ? time(b) - time(a) : sort === "oldest" ? time(a) - time(b) : a.author.localeCompare(b.author, locale()) || byPage(a, b),
    );
  }, [all, replies, type, who, status, sort, query]);

  const loading = pagesLoaded < pageCount;

  return (
    <section aria-label={t("Commentaires")} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={all.length ? t("Commentaires ({count})", { count: all.length }) : t("Commentaires")}
        actions={<IconButton label={t("Fermer le panneau")} size="sm" icon={<X size={16} />} onPress={onClose} />}
      />
      <div className="flex flex-col gap-2 border-b border-border p-3">
        {editingAuthor === null ? (
          <div className="flex items-center gap-1 text-sm text-muted">
            <p className="min-w-0 flex-1">
              {t("Vos commentaires sont signés")}
              <strong className="block truncate text-fg" title={author}>
                {author}
              </strong>
            </p>
            <IconButton label={t("Changer le nom d'auteur")} size="sm" icon={<Pencil size={14} />} onPress={() => setEditingAuthor(author)} />
          </div>
        ) : (
          <form
            className="flex items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (editingAuthor.trim()) onAuthorChange(editingAuthor.trim());
              setEditingAuthor(null);
            }}
          >
            <TextField label={t("Nom d'auteur")} size="sm" value={editingAuthor} onChange={setEditingAuthor} autoFocus className="flex-1" maxLength={100} />
            <Button size="sm" type="submit" variant="primary">
              {t("OK")}
            </Button>
          </form>
        )}
        <SearchField label={t("Rechercher dans les commentaires")} size="sm" placeholder={t("Rechercher")} value={query} onChange={setQuery} />
        <div className="grid grid-cols-1 gap-2">
          <Select aria-label={t("Type")} size="sm" options={TYPE_FILTERS.map((f) => ({ id: f.id, label: t(f.label) }))} selectedKey={type} onSelectionChange={(k) => setType(String(k))} />
          <Select
            aria-label={t("Auteur")}
            size="sm"
            options={[{ id: "all", label: t("Tous les auteurs") }, ...authors.map((a) => ({ id: a, label: a }))]}
            selectedKey={who}
            onSelectionChange={(k) => setWho(String(k))}
          />
          <Select aria-label={t("Statut")} size="sm" options={STATUS_FILTERS.map((f) => ({ id: f.id, label: t(f.label) }))} selectedKey={status} onSelectionChange={(k) => setStatus(String(k))} />
        </div>
        <Select
          aria-label={t("Tri")}
          size="sm"
          options={[
            { id: "page", label: t("Trier par page") },
            { id: "newest", label: t("Plus récents d'abord") },
            { id: "oldest", label: t("Plus anciens d'abord") },
            { id: "author", label: t("Trier par auteur") },
          ]}
          selectedKey={sort}
          onSelectionChange={(k) => setSort(String(k) as Sort)}
        />
        {loading && <ProgressBar label={t("Lecture des commentaires : page {done} sur {total}", { done: pagesLoaded, total: pageCount })} value={(pagesLoaded / pageCount) * 100} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 && !loading ? (
          all.length === 0 ? (
            <EmptyState icon={<MessageSquare size={24} />} title={t("Aucun commentaire")}>
              {t("Surlignez du texte, ajoutez une note ou dessinez : vos commentaires apparaîtront ici.")}
            </EmptyState>
          ) : (
            <EmptyState icon={<MessageSquare size={24} />} title={t("Aucun commentaire ne correspond")}>
              <Button
                size="sm"
                onPress={() => {
                  setType("all");
                  setWho("all");
                  setStatus("all");
                  setQuery("");
                }}
              >
                {t("Effacer les filtres")}
              </Button>
            </EmptyState>
          )
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t("Liste des commentaires")}>
            {shown.map((a) => (
              <CommentItem
                key={`${a.page}:${a.id}`}
                a={a}
                replies={replies.get(`${a.page}:${a.id}`) ?? []}
                selected={selected?.page === a.page && selected.id === a.id}
                canEdit={canEdit && !a.locked}
                canReply={canEdit}
                onSelect={() => onSelect(a)}
                onSave={(text) => onSave(a, text)}
                onDelete={() => onDelete(a)}
                onReply={(text) => onReply(a, text)}
                onStatus={(s) => onStatus(a, s)}
                onMarked={(m) => onMarked(a, m)}
                onSaveReply={(r, text) => onSave(r, text)}
                onDeleteReply={(r) => onDelete(r)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Zone de saisie d'un texte (commentaire ou réponse) : Ctrl+Entrée enregistre, Échap annule. */
function Draft({ label, initial, onSave, onCancel }: { label: string; initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) onSave(draft);
      }}
    >
      <textarea
        aria-label={label}
        value={draft}
        autoFocus
        rows={3}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            if (draft.trim()) onSave(draft);
          }
        }}
        className="focus-ring resize-y rounded-md border border-border-input bg-bg p-2 text-base"
      />
      <div className="flex justify-end gap-1">
        <Button size="sm" onPress={onCancel}>
          {t("Annuler")}
        </Button>
        <Button size="sm" variant="primary" type="submit">
          {t("Enregistrer")}
        </Button>
      </div>
    </form>
  );
}

function CommentItem({
  a,
  replies,
  selected,
  canEdit,
  canReply,
  onSelect,
  onSave,
  onDelete,
  onReply,
  onStatus,
  onMarked,
  onSaveReply,
  onDeleteReply,
}: {
  a: Annot;
  replies: Annot[];
  selected: boolean;
  canEdit: boolean;
  canReply: boolean;
  onSelect: () => void;
  onSave: (t: string) => void;
  onDelete: () => void;
  onReply: (t: string) => void;
  onStatus: (s: ReviewStatus | "") => void;
  onMarked: (m: boolean) => void;
  onSaveReply: (r: Annot, t: string) => void;
  onDeleteReply: (r: Annot) => void;
}) {
  const [mode, setMode] = useState<"edit" | "reply" | null>(null);
  const [editingReply, setEditingReply] = useState<string | null>(null);
  const date = formatDate(parsePdfDate(a.modified ?? a.created));
  return (
    <li
      className={clsx("flex flex-col gap-1.5 rounded-lg border bg-bg p-2.5 transition-control", selected ? "border-accent shadow-raised" : "border-border")}
      data-comment={a.id}
    >
      <div className="flex items-start gap-1.5">
        <Checkbox isSelected={a.marked} isDisabled={!canReply} onChange={onMarked} aria-label={t("Cocher ce commentaire")} className="mt-0.5 min-h-0">
          <span className="sr-only">{t("Cocher ce commentaire")}</span>
        </Checkbox>
        <button type="button" onClick={onSelect} className="focus-ring flex min-w-0 flex-1 cursor-default flex-col gap-1 rounded-sm text-left" aria-current={selected ? "true" : undefined}>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3 shrink-0 rounded-pill shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" style={{ background: a.color ? toHex(a.color) : "transparent" }} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.author || unknownAuthor()}</span>
            <span className="shrink-0 text-xs text-muted">
              {t(KIND_LABELS[a.kind])} · {t("p. {page}", { page: a.page + 1 })}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {date}
            {a.status && (
              <span data-status={a.status} className="inline-flex items-center gap-1 rounded-pill bg-surface px-1.5 py-0.5 font-medium text-fg">
                <CircleCheck size={12} aria-hidden />
                {t(STATUS_LABELS[a.status])}
              </span>
            )}
          </span>
          {a.contents && mode !== "edit" && <span className="text-base break-words whitespace-pre-wrap">{a.contents}</span>}
        </button>
      </div>
      {mode === "edit" && (
        <Draft
          label={t("Texte du commentaire")}
          initial={a.contents}
          onSave={(text) => {
            onSave(text);
            setMode(null);
          }}
          onCancel={() => setMode(null)}
        />
      )}
      {replies.length > 0 && (
        <ul className="ml-3 flex flex-col gap-1.5 border-l-2 border-border pl-2.5" aria-label={t("Réponses")}>
          {replies.map((r) => (
            <li key={r.id} data-reply={r.id} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-xs">
                <span className="font-semibold">{r.author || unknownAuthor()}</span>
                <span className="text-muted">{formatDate(parsePdfDate(r.modified ?? r.created))}</span>
              </span>
              {editingReply === r.id ? (
                <Draft
                  label={t("Texte de la réponse")}
                  initial={r.contents}
                  onSave={(text) => {
                    onSaveReply(r, text);
                    setEditingReply(null);
                  }}
                  onCancel={() => setEditingReply(null)}
                />
              ) : (
                <span className="text-sm break-words whitespace-pre-wrap">{r.contents}</span>
              )}
              {selected && canReply && editingReply !== r.id && (
                <span className="flex gap-1">
                  <IconButton label={t("Modifier la réponse")} size="sm" icon={<Pencil size={14} />} onPress={() => setEditingReply(r.id)} />
                  <IconButton label={t("Supprimer la réponse")} size="sm" icon={<Trash2 size={14} />} onPress={() => onDeleteReply(r)} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode === "reply" && (
        <Draft
          label={t("Votre réponse")}
          initial=""
          onSave={(text) => {
            onReply(text);
            setMode(null);
          }}
          onCancel={() => setMode(null)}
        />
      )}
      {selected && mode === null && (canEdit || canReply) && (
        <div className="flex flex-wrap gap-1">
          {canReply && (
            <Button size="sm" variant="ghost" icon={<Reply size={14} />} onPress={() => setMode("reply")}>
              {t("Répondre")}
            </Button>
          )}
          {canReply && (
            <MenuTrigger>
              <Button size="sm" variant="ghost" icon={<CircleCheck size={14} />}>
                {t("Statut")}
              </Button>
              <Menu aria-label={t("Statut")} selectionMode="single" selectedKeys={[a.status ?? "none"]} onAction={(k) => onStatus(k === "none" ? "" : (k as ReviewStatus))}>
                <MenuItem id="none">{t("Aucun")}</MenuItem>
                {(Object.keys(STATUS_LABELS) as ReviewStatus[]).map((s) => (
                  <MenuItem key={s} id={s}>
                    {t(STATUS_LABELS[s])}
                  </MenuItem>
                ))}
              </Menu>
            </MenuTrigger>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onPress={() => setMode("edit")}>
              {a.contents ? t("Modifier") : t("Ajouter un commentaire")}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onPress={onDelete}>
              {t("Supprimer")}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

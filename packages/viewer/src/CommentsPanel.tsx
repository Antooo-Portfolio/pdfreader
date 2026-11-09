import { Button, EmptyState, IconButton, PanelHeader, ProgressBar, SearchField, Select, TextField } from "@pdfreader/ui";
import { clsx } from "clsx";
import { MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDate, KIND_LABELS, parsePdfDate, toHex } from "./annot";
import type { Annot, AnnotKind } from "./engine";

type Sort = "page" | "newest" | "oldest" | "author";

const TYPE_FILTERS: { id: string; label: string; kinds?: AnnotKind[] }[] = [
  { id: "all", label: "Tous les types" },
  { id: "highlight", label: "Surlignages", kinds: ["highlight"] },
  { id: "underline", label: "Soulignés et barrés", kinds: ["underline", "strikeout", "squiggly"] },
  { id: "note", label: "Notes", kinds: ["note"] },
  { id: "ink", label: "Dessins", kinds: ["ink"] },
  { id: "other", label: "Autres", kinds: ["freetext", "line", "square", "circle", "polygon", "polyline", "stamp", "other"] },
];

const time = (a: Annot) => parsePdfDate(a.modified ?? a.created)?.getTime() ?? 0;

/** S08 : tous les commentaires du document, filtrés et triés ; modifier le texte, supprimer,
 *  aller au commentaire. C'est aussi la voie au clavier pour tout ce qui se fait à la souris
 *  sur la page. */
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
  onClose: () => void;
}) {
  const [type, setType] = useState("all");
  const [who, setWho] = useState("all");
  const [sort, setSort] = useState<Sort>("page");
  const [query, setQuery] = useState("");
  const [editingAuthor, setEditingAuthor] = useState<string | null>(null);

  const all = useMemo(() => [...annots.values()].flat().filter((a) => !a.replyTo), [annots]);
  const authors = useMemo(() => [...new Set(all.map((a) => a.author || "Auteur inconnu"))].sort((a, b) => a.localeCompare(b, "fr")), [all]);
  const shown = useMemo(() => {
    const kinds = TYPE_FILTERS.find((f) => f.id === type)?.kinds;
    const q = query.trim().toLocaleLowerCase("fr");
    const list = all.filter(
      (a) =>
        (!kinds || kinds.includes(a.kind)) &&
        (who === "all" || (a.author || "Auteur inconnu") === who) &&
        (!q || a.contents.toLocaleLowerCase("fr").includes(q) || a.author.toLocaleLowerCase("fr").includes(q)),
    );
    const byPage = (a: Annot, b: Annot) => a.page - b.page || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0];
    return list.sort((a, b) =>
      sort === "page" ? byPage(a, b) : sort === "newest" ? time(b) - time(a) : sort === "oldest" ? time(a) - time(b) : a.author.localeCompare(b.author, "fr") || byPage(a, b),
    );
  }, [all, type, who, sort, query]);

  const loading = pagesLoaded < pageCount;

  return (
    <section aria-label="Commentaires" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={`Commentaires${all.length ? ` (${all.length})` : ""}`} actions={<IconButton label="Fermer le panneau" size="sm" icon={<X size={16} />} onPress={onClose} />} />
      <div className="flex flex-col gap-2 border-b border-border p-3">
        {editingAuthor === null ? (
          <div className="flex items-center gap-1 text-sm text-muted">
            <p className="min-w-0 flex-1">
              Vos commentaires sont signés
              <strong className="block truncate text-fg" title={author}>
                {author}
              </strong>
            </p>
            <IconButton label="Changer le nom d'auteur" size="sm" icon={<Pencil size={14} />} onPress={() => setEditingAuthor(author)} />
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
            <TextField label="Nom d'auteur" size="sm" value={editingAuthor} onChange={setEditingAuthor} autoFocus className="flex-1" maxLength={100} />
            <Button size="sm" type="submit" variant="primary">
              OK
            </Button>
          </form>
        )}
        <SearchField label="Rechercher dans les commentaires" size="sm" placeholder="Rechercher" value={query} onChange={setQuery} />
        <div className="grid grid-cols-1 gap-2">
          <Select aria-label="Type" size="sm" options={TYPE_FILTERS} selectedKey={type} onSelectionChange={(k) => setType(String(k))} />
          <Select
            aria-label="Auteur"
            size="sm"
            options={[{ id: "all", label: "Tous les auteurs" }, ...authors.map((a) => ({ id: a, label: a }))]}
            selectedKey={who}
            onSelectionChange={(k) => setWho(String(k))}
          />
        </div>
        <Select
          aria-label="Tri"
          size="sm"
          options={[
            { id: "page", label: "Trier par page" },
            { id: "newest", label: "Plus récents d'abord" },
            { id: "oldest", label: "Plus anciens d'abord" },
            { id: "author", label: "Trier par auteur" },
          ]}
          selectedKey={sort}
          onSelectionChange={(k) => setSort(String(k) as Sort)}
        />
        {loading && <ProgressBar label={`Lecture des commentaires : page ${pagesLoaded} sur ${pageCount}`} value={(pagesLoaded / pageCount) * 100} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 && !loading ? (
          all.length === 0 ? (
            <EmptyState icon={<MessageSquare size={24} />} title="Aucun commentaire">
              Surlignez du texte, ajoutez une note ou dessinez : vos commentaires apparaîtront ici.
            </EmptyState>
          ) : (
            <EmptyState icon={<MessageSquare size={24} />} title="Aucun commentaire ne correspond">
              <Button
                size="sm"
                onPress={() => {
                  setType("all");
                  setWho("all");
                  setQuery("");
                }}
              >
                Effacer les filtres
              </Button>
            </EmptyState>
          )
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Liste des commentaires">
            {shown.map((a) => (
              <CommentItem
                key={`${a.page}:${a.id}`}
                a={a}
                selected={selected?.page === a.page && selected.id === a.id}
                canEdit={canEdit && !a.locked}
                onSelect={() => onSelect(a)}
                onSave={(t) => onSave(a, t)}
                onDelete={() => onDelete(a)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function CommentItem({ a, selected, canEdit, onSelect, onSave, onDelete }: { a: Annot; selected: boolean; canEdit: boolean; onSelect: () => void; onSave: (t: string) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const date = formatDate(parsePdfDate(a.modified ?? a.created));
  return (
    <li
      className={clsx("flex flex-col gap-1.5 rounded-lg border bg-bg p-2.5 transition-control", selected ? "border-accent shadow-raised" : "border-border")}
      data-comment={a.id}
    >
      <button type="button" onClick={onSelect} className="focus-ring flex cursor-default flex-col gap-1 rounded-sm text-left" aria-current={selected ? "true" : undefined}>
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-3 shrink-0 rounded-pill shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" style={{ background: a.color ? toHex(a.color) : "transparent" }} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.author || "Auteur inconnu"}</span>
          <span className="shrink-0 text-xs text-muted">
            {KIND_LABELS[a.kind]} · p. {a.page + 1}
          </span>
        </span>
        {date && <span className="text-xs text-muted">{date}</span>}
        {a.contents && draft === null && <span className="text-base break-words whitespace-pre-wrap">{a.contents}</span>}
      </button>
      {draft !== null ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft);
            setDraft(null);
          }}
        >
          <textarea
            aria-label="Texte du commentaire"
            value={draft}
            autoFocus
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft(null);
              } else if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                onSave(draft);
                setDraft(null);
              }
            }}
            className="focus-ring resize-y rounded-md border border-border-input bg-bg p-2 text-base"
          />
          <div className="flex justify-end gap-1">
            <Button size="sm" onPress={() => setDraft(null)}>
              Annuler
            </Button>
            <Button size="sm" variant="primary" type="submit">
              Enregistrer
            </Button>
          </div>
        </form>
      ) : (
        canEdit &&
        selected && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onPress={() => setDraft(a.contents)}>
              {a.contents ? "Modifier" : "Ajouter un commentaire"}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onPress={onDelete}>
              Supprimer
            </Button>
          </div>
        )
      )}
    </li>
  );
}

/** Recherche avancée (Ctrl+Maj+F) : liste de tous les résultats avec leur contexte, et recherche
 *  dans les commentaires et les signets. */
import { Checkbox, IconButton, PanelHeader, SearchField, Spinner, t } from "@pdfreader/ui";
import { Bookmark as BookmarkIcon, MessageSquare, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KIND_LABELS } from "./annot";
import type { Annot, Bookmark, EngineClient, LinkAction, SnippetHit } from "./engine";

const BATCH = 20;
/** Résultats affichés au plus par rubrique (la liste complète resterait illisible). */
const SHOWN = 500;

interface CommentHit {
  annot: Annot;
  text: string;
}
interface BookmarkHit {
  title: string;
  action: LinkAction;
}

interface Results {
  text: SnippetHit[];
  comments: CommentHit[];
  bookmarks: BookmarkHit[];
  truncated: boolean;
  /** Pages déjà parcourues (texte). */
  done: number;
  searching: boolean;
}

const EMPTY: Results = { text: [], comments: [], bookmarks: [], truncated: false, done: 0, searching: false };

/** Correspondance hors du texte des pages (commentaires, signets), avec les mêmes options. */
export function matcher(query: string, matchCase: boolean, wholeWord: boolean): (s: string) => boolean {
  const q = query.trim();
  if (!q) return () => false;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])` : esc, matchCase ? "u" : "iu");
  return (s) => re.test(s);
}

function flatten(list: Bookmark[], out: BookmarkHit[] = []): BookmarkHit[] {
  for (const b of list) {
    out.push({ title: b.title, action: b.action });
    flatten(b.children, out);
  }
  return out;
}

export function SearchPanel({
  engine,
  docId,
  generation,
  pageCount,
  initialQuery,
  focusSignal,
  onJump,
  onLink,
  onSelectComment,
  onClose,
}: {
  engine: EngineClient;
  docId: number;
  generation: number;
  pageCount: number;
  initialQuery: string;
  /** Change à chaque Ctrl+Maj+F : remet le curseur dans le champ. */
  focusSignal: number;
  /** Page à partir de 1 ; ordonnée en points depuis le haut. */
  onJump: (page: number, top: number | null) => void;
  onLink: (a: LinkAction) => void;
  onSelectComment: (a: Annot) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [inComments, setInComments] = useState(true);
  const [inBookmarks, setInBookmarks] = useState(true);
  const [res, setRes] = useState<Results>(EMPTY);
  const root = useRef<HTMLElement>(null);

  // Chaque ouverture (Ctrl+Maj+F, texte sélectionné) reprend la requête transmise.
  useEffect(() => {
    if (initialQuery) {
      setQuery(initialQuery);
      setSubmitted(initialQuery);
    }
    requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>("input[type=search]")?.select());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  // Recherche lancée par Entrée, ou après une courte pause dans la saisie.
  useEffect(() => {
    const timer = setTimeout(() => setSubmitted(query), 450);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const q = submitted.trim();
    setRes(EMPTY);
    if (!q) return;
    let cancelled = false;
    const match = matcher(q, matchCase, wholeWord);
    (async () => {
      let cur: Results = { ...EMPTY, searching: true };
      setRes(cur);
      try {
        if (inBookmarks) {
          const b = flatten(await engine.bookmarks(docId).catch(() => []));
          cur = { ...cur, bookmarks: b.filter((x) => match(x.title)) };
        }
        for (let from = 0; from < pageCount && !cur.truncated; from += BATCH) {
          const r = await engine.searchSnippets(docId, from, BATCH, q, matchCase, wholeWord, cur.text.length);
          if (cancelled) return;
          let comments = cur.comments;
          if (inComments) {
            for (let p = from; p < Math.min(pageCount, from + BATCH); p++) {
              const list = await engine.annotations(docId, p).then((x) => x.annots).catch(() => [] as Annot[]);
              if (cancelled) return;
              const found = list.filter((a) => a.contents && (match(a.contents) || match(a.author))).map((a) => ({ annot: a, text: a.contents }));
              if (found.length) comments = [...comments, ...found];
            }
          }
          cur = { ...cur, text: r.hits.length ? [...cur.text, ...r.hits] : cur.text, comments, truncated: r.truncated, done: Math.min(pageCount, from + BATCH) };
          setRes(cur);
        }
      } catch {
        // Document fermé pendant la recherche : rien à afficher.
      }
      if (!cancelled) setRes({ ...cur, searching: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, docId, generation, pageCount, submitted, matchCase, wholeWord, inComments, inBookmarks]);

  const total = res.text.length + res.comments.length + res.bookmarks.length;
  const status = useMemo(() => {
    if (!submitted.trim()) return "";
    if (res.searching) return t("Recherche… {done} pages sur {total}", { done: res.done, total: pageCount });
    if (total === 0) return t("Aucun résultat.");
    return total === 1 ? t("1 résultat") : t("{count} résultats", { count: total });
  }, [submitted, res.searching, res.done, pageCount, total]);

  const item = "focus-ring flex w-full cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover";

  return (
    <section ref={root} aria-label={t("Recherche avancée")} className="flex min-h-0 flex-1 flex-col" data-search-panel>
      <PanelHeader title={t("Recherche avancée")} actions={<IconButton label={t("Fermer le panneau")} size="sm" icon={<X size={16} />} onPress={onClose} />} />
      <form
        className="flex flex-col gap-1 border-b border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query);
        }}
      >
        <SearchField label={t("Rechercher dans le document")} placeholder={t("Rechercher dans le document")} size="sm" value={query} onChange={setQuery} onSubmit={() => setSubmitted(query)} />
        <div className="grid grid-cols-2 gap-x-2">
          <Checkbox isSelected={matchCase} onChange={setMatchCase}>
            {t("Respecter la casse")}
          </Checkbox>
          <Checkbox isSelected={wholeWord} onChange={setWholeWord}>
            {t("Mots entiers")}
          </Checkbox>
          <Checkbox isSelected={inComments} onChange={setInComments}>
            {t("Commentaires")}
          </Checkbox>
          <Checkbox isSelected={inBookmarks} onChange={setInBookmarks}>
            {t("Signets")}
          </Checkbox>
        </div>
      </form>
      <p role="status" aria-live="polite" className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted">
        {res.searching && <Spinner label="" />}
        {status}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-search-results>
        {res.bookmarks.length > 0 && (
          <Group title={t("Signets ({count})", { count: res.bookmarks.length })}>
            {res.bookmarks.slice(0, SHOWN).map((b, i) => (
              <li key={`b${i}`}>
                <button type="button" className={item} onClick={() => onLink(b.action)} data-hit="bookmark">
                  <span className="flex items-center gap-1.5 text-base">
                    <BookmarkIcon size={14} aria-hidden className="shrink-0 text-muted" />
                    <span className="truncate">{b.title || t("(sans titre)")}</span>
                  </span>
                </button>
              </li>
            ))}
          </Group>
        )}
        {res.comments.length > 0 && (
          <Group title={t("Commentaires ({count})", { count: res.comments.length })}>
            {res.comments.slice(0, SHOWN).map((c) => (
              <li key={`c${c.annot.page}-${c.annot.id}`}>
                <button type="button" className={item} onClick={() => onSelectComment(c.annot)} data-hit="comment">
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <MessageSquare size={12} aria-hidden />
                    {t("Page {page}", { page: c.annot.page + 1 })} · {t(KIND_LABELS[c.annot.kind])}
                    {c.annot.author ? ` · ${c.annot.author}` : ""}
                  </span>
                  <span className="line-clamp-2 text-sm">{c.text}</span>
                </button>
              </li>
            ))}
          </Group>
        )}
        {res.text.length > 0 && (
          <Group title={t("Texte des pages ({count})", { count: res.text.length })}>
            {res.text.slice(0, SHOWN).map((h, i) => (
              <li key={`t${i}`}>
                <button type="button" className={item} onClick={() => onJump(h.page + 1, Math.max(0, (h.rects[0]?.[1] ?? 0) - 48))} data-hit="text">
                  <span className="text-xs text-muted">{t("Page {page}", { page: h.page + 1 })}</span>
                  <span className="text-sm">
                    {h.before && <span className="text-muted">…{h.before} </span>}
                    <mark className="rounded-xs bg-search-hit px-0.5 text-fg">{h.matched}</mark>
                    {h.after && <span className="text-muted"> {h.after}…</span>}
                  </span>
                </button>
              </li>
            ))}
          </Group>
        )}
        {(res.truncated || res.text.length > SHOWN || res.comments.length > SHOWN) && (
          <p className="px-3 py-2 text-xs text-muted">{t("Seuls les premiers résultats sont affichés : précisez la recherche.")}</p>
        )}
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <h3 className="px-2 py-1 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

//! Processus moteur : seul propriétaire de PDFium. Lancé par l'application avec `--engine-host`,
//! il lit les demandes sur son entrée standard et répond sur sa sortie standard. S'il plante sur un
//! PDF malformé (ou s'il se bloque), seule cette copie s'arrête : l'application le relance et
//! rouvre les documents.

use std::collections::HashMap;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::SystemTime;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use serde::Serialize;
use serde_json::Value;

use crate::protocol::{AnnotOp, Answer, DocInfo, Envelope, OpenResult, Request, SaveResult, read_frame, write_frame};

/// Commentaire créé (s'il y en a un) et liste à jour des commentaires de la page.
#[derive(Debug, Serialize)]
struct AnnotResult {
    id: Option<String>,
    annots: Vec<eng::annotations::Annot>,
}

/// Résultat d'une saisie : champs à jour de la page, et effets des scripts du formulaire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetFieldResult {
    fields: Vec<eng::fill::Field>,
    outcome: eng::formcalc::Outcome,
}

struct Entry {
    doc: PdfDocument<'static>,
    path: PathBuf,
    password: Option<String>,
    mtime: Option<SystemTime>,
    generation: u32,
    fingerprint: String,
    /// Signets modifiés, écrits au prochain enregistrement (PDFium ne sait pas les écrire).
    outline: Option<Vec<eng::outline::OutlineItem>>,
    /// Le formulaire porte-t-il des scripts (calcul, validation) ? Lu à la première saisie.
    form_scripts: Option<bool>,
}

/// Impression en cours (une seule à la fois).
struct ActivePrint {
    id: u64,
    doc: u32,
    job: eng::print_win::PrintJob,
    pages: Vec<i32>,
    next: usize,
    vector: bool,
    cancelled: bool,
}

/// Sortie vers l'application. Une écriture qui échoue veut dire que l'application est partie :
/// le moteur s'arrête.
struct Out(BufWriter<std::io::Stdout>);

impl Out {
    fn send(&mut self, answer: Answer, data: &[u8]) {
        if write_frame(&mut self.0, &answer, data).is_err() {
            std::process::exit(0);
        }
    }
    fn reply<T: Serialize>(&mut self, id: u64, r: Result<T, String>) {
        self.reply_with(id, r.map(|v| (v, Vec::new())));
    }
    fn reply_with<T: Serialize>(&mut self, id: u64, r: Result<(T, Vec<u8>), String>) {
        match r {
            Ok((v, data)) => match serde_json::to_value(v) {
                Ok(value) => self.send(Answer::Ok { id, value }, &data),
                Err(e) => self.send(Answer::Err { id, error: Value::String(e.to_string()) }, &[]),
            },
            Err(e) => self.send(Answer::Err { id, error: Value::String(e) }, &[]),
        }
    }
}

/// Point d'entrée du processus moteur. `lib_dir` : dossier qui contient pdfium.dll.
pub fn main(lib_dir: PathBuf) {
    quiet_crashes();
    // Lecture des demandes sur un fil à part : la boucle principale peut ainsi intercaler les pages
    // d'une impression entre les demandes.
    let (tx, rx) = mpsc::channel::<(Envelope, Vec<u8>)>();
    std::thread::Builder::new()
        .name("lecture-demandes".into())
        .spawn(move || {
            let mut input = BufReader::new(std::io::stdin().lock());
            while let Ok(Some(frame)) = read_frame::<Envelope>(&mut input) {
                if tx.send(frame).is_err() {
                    break;
                }
            }
            // Fin du flux : l'application est fermée (ou a abandonné ce moteur).
        })
        .expect("fil de lecture");
    let mut out = Out(BufWriter::new(std::io::stdout()));

    let pdfium: &'static Pdfium = match eng::load_pdfium(&lib_dir) {
        Ok(p) => Box::leak(Box::new(p)),
        Err(e) => {
            eprintln!("PDFium introuvable : {e:#}");
            // On répond en erreur à tout, pour que l'interface l'affiche au lieu de rester bloquée.
            for (env, _) in rx {
                out.reply::<()>(env.id, Err("Le moteur PDF n'a pas pu démarrer (pdfium.dll introuvable).".into()));
            }
            return;
        }
    };
    let mut docs: HashMap<u32, Entry> = HashMap::new();
    let mut printing: Option<ActivePrint> = None;

    loop {
        // Les demandes passent toujours avant l'impression : l'affichage reste fluide.
        let frame = if printing.is_some() {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(c) => Some(c),
                Err(_) => break,
            }
        };
        let Some((Envelope { id, req }, data)) = frame else {
            print_next_page(&mut printing, &docs, &mut out);
            continue;
        };
        match req {
            Request::Print { doc, opts } => {
                if printing.is_some() {
                    out.reply::<()>(id, Err("print_busy".into()));
                    continue;
                }
                match start_print(&docs, doc, opts) {
                    Ok((job, pages, vector)) => printing = Some(ActivePrint { id, doc, job, pages, next: 0, vector, cancelled: false }),
                    Err(e) => out.reply::<()>(id, Err(e)),
                }
            }
            Request::CancelPrint => {
                if let Some(p) = printing.as_mut() {
                    p.cancelled = true;
                }
                out.reply(id, Ok(()));
            }
            Request::Snapshot { doc, target } => {
                let r = get(&docs, doc).and_then(|e| {
                    eng::save(&e.doc, &target, true).map_err(|e| e.to_string())?;
                    if let Some(items) = &e.outline {
                        let _ = eng::outline::write(&target, items, &heights(&e.doc));
                    }
                    Ok(std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0))
                });
                out.reply(id, r);
            }
            Request::ChangedOnDisk { doc } => {
                out.reply(id, get(&docs, doc).map(|e| eng::file_mtime(&e.path) != e.mtime));
            }
            Request::Reload { doc } => {
                let r = (|| {
                    let e = get(&docs, doc)?;
                    let (path, password, generation) = (e.path.clone(), e.password.clone(), e.generation + 1);
                    let fresh = eng::open_typed(pdfium, &path, password.as_deref()).map_err(|e| e.to_string())?;
                    let fingerprint = eng::fingerprint(&path).map_err(|e| e.to_string())?;
                    let entry = Entry { doc: fresh, mtime: eng::file_mtime(&path), path, password, generation, fingerprint, outline: None, form_scripts: None };
                    let info = info_of(doc, &entry);
                    docs.insert(doc, entry);
                    Ok(info)
                })();
                out.reply(id, r);
            }
            Request::Open { doc: doc_id, path, shown_as, password, generation } => {
                let result = (|| -> Result<(OpenResult, Vec<u8>), eng::OpenError> {
                    let doc = eng::open_typed(pdfium, &path, password.as_deref())?;
                    let thumbnail = eng::thumbnail_png(&doc, 160).unwrap_or_default();
                    let shown = shown_as.unwrap_or_else(|| path.clone());
                    // Copie de récupération : empreinte du fichier d'origine s'il existe encore.
                    let fingerprint = eng::fingerprint(&shown).or_else(|_| eng::fingerprint(&path)).map_err(|e| eng::OpenError::Other(e.to_string()))?;
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    let entry = Entry { doc, mtime: eng::file_mtime(&shown), path: shown, password: password.clone(), generation: generation.max(1), fingerprint, outline: None, form_scripts: None };
                    let info = info_of(doc_id, &entry);
                    docs.insert(doc_id, entry);
                    Ok((OpenResult { info, size }, thumbnail))
                })();
                match result {
                    Ok((r, thumb)) => out.reply_with(id, Ok((r, thumb))),
                    // Erreur typée (mot de passe, fichier endommagé…) : l'interface y réagit.
                    Err(e) => out.send(Answer::Err { id, error: serde_json::to_value(&e).unwrap_or(Value::Null) }, &[]),
                }
            }
            Request::TextLayer { doc, page } => {
                let r = get(&docs, doc).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    eng::text_layer(&p).map_err(|e| e.to_string())
                });
                out.reply(id, r);
            }
            Request::Annot { doc, page, op } => {
                out.reply(id, annot(&docs, doc, page, op, data));
            }
            Request::CountHighlights { doc, page } => {
                let r = get(&docs, doc).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::count_annotations(&p, PdfPageAnnotationType::Highlight))
                });
                out.reply(id, r);
            }
            Request::Links { doc, page } => {
                let r = get(&docs, doc).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::page_links(&e.doc, &p))
                });
                out.reply(id, r);
            }
            Request::Fields { doc, page } => {
                let r = get(&docs, doc).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::fill::fields(&e.doc, &p, page))
                });
                out.reply(id, r);
            }
            Request::SetField { doc, page, index, input, scripts } => {
                let r = docs.get_mut(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    let old = eng::fill::fields(&e.doc, &p, page).into_iter().find(|f| f.index == index).map(|f| f.value).unwrap_or_default();
                    eng::fill::set_field(&e.doc, &p, index, &input).map_err(|e| e.to_string())?;
                    // Calculs et validations : seulement si le formulaire en a (vérifié une fois).
                    // Préférence coupée : aucun calcul ni aucune vérification (même standard).
                    let has = scripts && *e.form_scripts.get_or_insert_with(|| eng::formcalc::has_scripts(&eng::formcalc::collect(&e.doc)));
                    let outcome = if has { eng::formcalc::after_change(&e.doc, page, index, &old, scripts).map_err(|e| e.to_string())? } else { Default::default() };
                    Ok(SetFieldResult { fields: eng::fill::fields(&e.doc, &p, page), outcome })
                });
                out.reply(id, r);
            }
            Request::Bookmarks { doc } => {
                let r = get(&docs, doc).map(|e| match &e.outline {
                    Some(items) => outline_as_bookmarks(items),
                    None => eng::bookmarks(&e.doc),
                });
                out.reply(id, r);
            }
            Request::SetBookmarks { doc, items } => {
                let r = docs.get_mut(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    if eng::is_encrypted(&e.doc) {
                        return Err("encrypted".to_string());
                    }
                    if eng::outline::count(&items) > eng::outline::MAX_ITEMS {
                        return Err("trop de signets".to_string());
                    }
                    e.outline = Some(items);
                    Ok(())
                });
                out.reply(id, r);
            }
            Request::Attachments { doc } => {
                out.reply(id, get(&docs, doc).map(|e| eng::navigation::attachments(&e.doc)));
            }
            Request::AttachmentBytes { doc, index } => {
                let r = get(&docs, doc).and_then(|e| eng::navigation::attachment_bytes(&e.doc, index).map_err(|e| e.to_string()));
                out.reply_with(id, r.map(|bytes| ((), bytes)));
            }
            Request::SearchSnippets { doc, from, count, query, match_case, whole_word, already } => {
                let r = get(&docs, doc).and_then(|e| eng::navigation::search_snippets(&e.doc, from, count, &query, match_case, whole_word, already).map_err(|e| e.to_string()));
                out.reply(id, r);
            }
            Request::Properties { doc } => {
                out.reply(id, get(&docs, doc).map(|e| eng::properties::properties(&e.doc, &e.path)));
            }
            Request::Search { doc, from, count, query, match_case, whole_word } => {
                let r = get(&docs, doc).and_then(|e| eng::search(&e.doc, from, count, &query, match_case, whole_word).map_err(|e| e.to_string()));
                out.reply(id, r);
            }
            Request::Save { doc, path } => {
                let r = save(pdfium, &mut docs, doc, path);
                out.reply(id, r);
            }
            Request::Close { doc } => {
                docs.remove(&doc);
                if printing.as_ref().is_some_and(|p| p.doc == doc) {
                    printing.as_mut().unwrap().cancelled = true;
                }
                out.reply(id, Ok(()));
            }
            Request::Tile { doc, page, scale, x, y, size } => {
                let r = get(&docs, doc).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    let tile = eng::render_tile(&p, scale, x, y, size).map_err(|e| e.to_string())?;
                    eng::tile_webp(&tile).map_err(|e| e.to_string())
                });
                out.reply_with(id, r.map(|webp| ((), webp)));
            }
            // Double garde : l'application ne transmet ces demandes qu'en test, et le moteur vérifie
            // aussi la variable (héritée de l'application).
            Request::TestCrash { .. } if std::env::var("PDFREADER_E2E").is_ok() => std::process::abort(),
            Request::TestHang { .. } if std::env::var("PDFREADER_E2E").is_ok() => loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
            },
            Request::TestCrash { .. } | Request::TestHang { .. } => out.reply::<()>(id, Err("refusé".into())),
        }
    }
}

/// Plantage : pas de fenêtre « PDFReader a cessé de fonctionner » pour le processus moteur,
/// l'application s'en charge (elle relance le moteur et prévient l'utilisateur).
fn quiet_crashes() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::{SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX, SetErrorMode};
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }
}

fn get(docs: &HashMap<u32, Entry>, doc: u32) -> Result<&Entry, String> {
    docs.get(&doc).ok_or_else(|| "document fermé".to_string())
}

fn info_of(id: u32, e: &Entry) -> DocInfo {
    let doc = &e.doc;
    let pages = doc.pages().iter().map(|p| [p.width().value, p.height().value]).collect();
    DocInfo {
        id,
        path: e.path.display().to_string(),
        name: e.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        title: doc.metadata().get(PdfDocumentMetadataTagType::Title).map(|t| t.value().to_string()).filter(|t| !t.is_empty()),
        page_count: doc.pages().len(),
        pages,
        encrypted: e.password.is_some(),
        has_form: doc.form().is_some(),
        is_xfa: doc.form().map(|f| matches!(f.form_type(), PdfFormType::XfaFull | PdfFormType::XfaForeground)).unwrap_or(false),
        permissions: serde_json::to_value(eng::permissions(doc)).unwrap_or(Value::Null),
        attachment_count: doc.attachments().len(),
        from_internet: eng::navigation::from_internet(&e.path),
        bookmarks_editable: !eng::is_encrypted(doc),
        fingerprint: e.fingerprint.clone(),
        view_state: None,
        generation: e.generation,
    }
}

fn annot(docs: &HashMap<u32, Entry>, doc: u32, page: i32, op: AnnotOp, data: Vec<u8>) -> Result<AnnotResult, String> {
    use eng::annotations as an;
    let e = get(docs, doc)?;
    let mut p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
    let id = match op {
        AnnotOp::List => None,
        AnnotOp::Markup { kind, rects, color, opacity, author } => Some(an::add_markup(&mut p, &kind, &rects, color, opacity, &author)),
        AnnotOp::Note { x, y, contents, color, author } => Some(an::add_note(&mut p, x, y, &contents, color, &author)),
        AnnotOp::Ink { strokes, color, opacity, width, author } => Some(an::add_ink(&mut p, &strokes, color, opacity, width, &author)),
        AnnotOp::Text { x, y, text, size, color, author } => Some(eng::fill::add_text(&e.doc, &mut p, x, y, &text, size, color, &author)),
        AnnotOp::Mark { x, y, size, cross, color, author } => Some(eng::fill::add_mark(&mut p, x, y, size, cross, color, &author)),
        AnnotOp::TextBox { rect, text, size, color, filled, anchor, author } => {
            Some(eng::fill::add_textbox(&e.doc, &mut p, rect, &text, size, color, filled.then_some([255, 255, 255]), anchor, &author))
        }
        AnnotOp::Image { rect, kind, author } => Some(eng::fill::add_image(&e.doc, &mut p, rect, &data, &kind, &author)),
        AnnotOp::Update { id, patch } => {
            an::update(&mut p, &id, &patch).map_err(|e| e.to_string())?;
            None
        }
        AnnotOp::Delete { id } => {
            an::delete(&mut p, &id).map_err(|e| e.to_string())?;
            None
        }
        AnnotOp::Shape { kind, points, color, opacity, width, fill, author } => Some(an::add_shape(&mut p, &kind, &points, color, opacity, width, fill, &author)),
        AnnotOp::Stamp { x, y, preset, label, subtitle, author } => Some(eng::fill::add_preset_stamp(&e.doc, &mut p, x, y, &preset, &label, subtitle.as_deref(), &author)),
        AnnotOp::Reply { parent, contents, author } => Some(an::add_reply(&mut p, &parent, &contents, &author)),
        AnnotOp::Status { id, status, marked } => {
            an::set_status(&mut p, &id, status.as_deref(), marked).map_err(|e| e.to_string())?;
            None
        }
    };
    let id = id.transpose().map_err(|e| e.to_string())?;
    Ok(AnnotResult { id, annots: an::list(&p, page) })
}

fn start_print(docs: &HashMap<u32, Entry>, doc: u32, opts: eng::print_win::PrintOptions) -> Result<(eng::print_win::PrintJob, Vec<i32>, bool), String> {
    let e = get(docs, doc)?;
    let perms = eng::permissions(&e.doc);
    if !perms.print {
        return Err("print_forbidden".to_string());
    }
    let count = e.doc.pages().len();
    let pages: Vec<i32> = opts.pages.iter().copied().filter(|p| (0..count).contains(p)).collect();
    if pages.is_empty() {
        return Err("aucune page à imprimer".to_string());
    }
    let mut opts = opts;
    opts.pages = pages.clone();
    if opts.title.is_empty() {
        opts.title = e.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    }
    let job = eng::print_win::PrintJob::start(&opts).map_err(|e| e.to_string())?;
    Ok((job, pages, perms.print_high_quality))
}

/// Rien en attente : une page de plus pour l'impression en cours.
fn print_next_page(printing: &mut Option<ActivePrint>, docs: &HashMap<u32, Entry>, out: &mut Out) {
    let Some(mut p) = printing.take() else { return };
    if p.cancelled {
        out.reply::<()>(p.id, Err("print_cancelled".into()));
        return; // la tâche abandonnée annule le document côté spouleur
    }
    let Some(e) = docs.get(&p.doc) else {
        out.reply::<()>(p.id, Err("document fermé".into()));
        return;
    };
    let Some(&page) = p.pages.get(p.next) else {
        let n = p.pages.len();
        out.reply(p.id, p.job.finish().map(|_| n).map_err(|e| e.to_string()));
        return;
    };
    match p.job.page(&e.doc, page, p.vector) {
        Ok(()) => {
            p.next += 1;
            out.send(Answer::Progress { id: p.id, done: p.next, total: p.pages.len() }, &[]);
            *printing = Some(p);
        }
        Err(err) => out.reply::<()>(p.id, Err(err.to_string())),
    }
}

/// Enregistre (sur place ou ailleurs), puis recharge le document depuis le fichier écrit pour que
/// les enregistrements suivants s'appuient sur la nouvelle version.
fn save(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, target: Option<PathBuf>) -> Result<SaveResult, String> {
    let e = get(docs, id)?;
    let same_file = target.as_ref().map(|t| same_path(t, &e.path)).unwrap_or(true);
    let target = target.unwrap_or_else(|| e.path.clone());
    if same_file && eng::file_mtime(&e.path) != e.mtime {
        return Err("file_changed".into());
    }
    // Sur place : incrémental (préserve les signatures). Ailleurs : incrémental aussi, le fichier
    // d'origine est recopié en tête puis la mise à jour ajoutée.
    eng::save(&e.doc, &target, true).map_err(|err| {
        if err.to_string().contains("os error 32") || err.to_string().contains("os error 5") {
            "file_locked".to_string()
        } else {
            err.to_string()
        }
    })?;
    if let Some(items) = &e.outline {
        eng::outline::write(&target, items, &heights(&e.doc)).map_err(|err| {
            let m = err.to_string();
            if m.contains("encrypted") || m.contains("file_too_big") { m } else { format!("bookmarks_failed: {m}") }
        })?;
    }
    let password = e.password.clone();
    let generation = e.generation + 1;
    let old_fingerprint = e.fingerprint.clone();
    let doc = eng::open_typed(pdfium, &target, password.as_deref()).map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let fingerprint = eng::fingerprint(&target).map_err(|e| e.to_string())?;
    let entry = Entry { doc, path: target.clone(), password, mtime: eng::file_mtime(&target), generation, fingerprint: fingerprint.clone(), outline: None, form_scripts: None };
    docs.insert(id, entry);
    Ok(SaveResult { path: target.display().to_string(), bytes, generation, fingerprint, old_fingerprint })
}

fn heights(doc: &PdfDocument) -> Vec<f32> {
    doc.pages().iter().map(|p| p.height().value).collect()
}

/// Signets en attente, présentés comme ceux lus dans le fichier.
fn outline_as_bookmarks(items: &[eng::outline::OutlineItem]) -> Vec<eng::Bookmark> {
    items
        .iter()
        .map(|i| eng::Bookmark {
            title: i.title.clone(),
            action: match (&i.uri, i.page) {
                (Some(u), _) => eng::LinkAction::Uri { uri: u.clone() },
                (None, p) if p >= 0 => eng::LinkAction::Goto { page: p, top: i.top },
                _ => eng::LinkAction::None,
            },
            children: outline_as_bookmarks(&i.children),
        })
        .collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}


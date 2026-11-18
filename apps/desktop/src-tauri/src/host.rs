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

use crate::protocol::{AnnotOp, Answer, DocInfo, Envelope, OpenResult, OcrOp, PageOp, PageTextOp, Request, SaveResult, StampOp, TextEditOp, read_frame, write_frame};

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
    /// États précédents (et suivants) des opérations sur les pages, pour annuler et rétablir.
    undo: Vec<PageState>,
    redo: Vec<PageState>,
    /// Des pages ont été supprimées : le prochain enregistrement réécrit tout le fichier, pour
    /// qu'elles n'y restent pas (un enregistrement incrémental garde l'ancienne version en tête).
    full_save: bool,
    /// Polices TrueType intégrées pour le texte ajouté dans les pages (une fois chacune).
    fonts: eng::pagetext::FontCache,
}

/// Copie complète du document en mémoire, avec ses signets en attente.
struct PageState {
    bytes: Vec<u8>,
    outline: Option<Vec<eng::outline::OutlineItem>>,
}

/// Annuler les opérations sur les pages : au plus 20 états, 512 Mo en tout ; pas d'annulation pour
/// un fichier de plus de 128 Mo (chaque état en est une copie complète).
const UNDO_STATES: usize = 20;
const UNDO_TOTAL: usize = 512 << 20;
const UNDO_FILE_MAX: u64 = 128 << 20;

/// Résultat d'une opération sur les pages : document à jour, correspondance des anciens index vers
/// les nouveaux (absente après annuler / rétablir), possibilités d'annuler et de rétablir.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PagesResult {
    info: DocInfo,
    map: Option<eng::pages::PageMap>,
    can_undo: bool,
    can_redo: bool,
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
                        let _ = eng::outline::write(&target, items, &frames(&e.doc));
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
                    let entry = Entry { doc: fresh, mtime: eng::file_mtime(&path), path, password, generation, fingerprint, outline: None, form_scripts: None, undo: Vec::new(), redo: Vec::new(), full_save: false, fonts: Default::default() };
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
                    let entry = Entry { doc, mtime: eng::file_mtime(&shown), path: shown, password: password.clone(), generation: generation.max(1), fingerprint, outline: None, form_scripts: None, undo: Vec::new(), redo: Vec::new(), full_save: false, fonts: Default::default() };
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
                let changes = !matches!(op, AnnotOp::List);
                let r = annot(&docs, doc, page, op, data);
                if changes && r.is_ok() {
                    forget_page_history(&mut docs, doc);
                }
                out.reply(id, r);
            }
            Request::TextEdit { doc, page, op } => {
                out.reply(id, text_edit(&mut docs, doc, page, op));
            }
            Request::PageText { doc, page, op } => {
                let changes = !matches!(op, PageTextOp::List);
                let r = page_text(&mut docs, doc, page, op);
                if changes && r.is_ok() {
                    forget_page_history(&mut docs, doc);
                }
                out.reply(id, r);
            }
            Request::Pages { doc, op } => {
                out.reply(id, page_op(pdfium, &mut docs, doc, op));
            }
            Request::Stamps { doc, op } => {
                out.reply(id, stamps(pdfium, &mut docs, doc, op));
            }
            Request::Ocr { doc, op } => {
                out.reply(id, ocr(&mut docs, doc, op));
            }
            Request::ExtractPages { doc, pages, target } => {
                let r = get(&docs, doc).and_then(|e| {
                    may_copy_out(&e.doc)?;
                    eng::pages::extract(pdfium, &e.doc, &pages, &target).map_err(|e| e.to_string())?;
                    Ok(std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0))
                });
                out.reply(id, r);
            }
            Request::SplitPages { doc, per_file, folder } => {
                out.reply(id, get(&docs, doc).and_then(|e| split(pdfium, e, per_file, &folder)));
            }
            Request::Combine { sources, target, image_page } => {
                out.reply(id, combine(pdfium, &sources, &target, &image_page));
            }
            Request::Compress { doc, options, target } => {
                out.reply(id, compress_doc(pdfium, &mut docs, doc, options, target));
            }
            Request::Protect { doc, protection, target } => {
                out.reply(id, protect_doc(pdfium, &mut docs, doc, protection, target));
            }
            Request::ExportImage { doc, page, options, target, unique } => {
                let r = get(&docs, doc).and_then(|e| {
                    // Une image du contenu en est une copie : refusée si l'auteur interdit la copie.
                    if !eng::permissions(&e.doc).copy {
                        return Err("copy_forbidden".to_string());
                    }
                    let target = if unique { free_file(&target) } else { target };
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    let result = eng::export::export_page(&p, &options, &target).map_err(|e| e.to_string())?;
                    Ok(ExportedImage { path: target.display().to_string(), result })
                });
                out.reply(id, r);
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
                forget_page_history(&mut docs, doc);
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
                    e.undo.clear();
                    e.redo.clear();
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
    eng::save(&e.doc, &target, !e.full_save).map_err(|err| {
        if err.to_string().contains("os error 32") || err.to_string().contains("os error 5") {
            "file_locked".to_string()
        } else {
            err.to_string()
        }
    })?;
    if let Some(items) = &e.outline {
        eng::outline::write(&target, items, &frames(&e.doc)).map_err(|err| {
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
    let entry = Entry { doc, path: target.clone(), password, mtime: eng::file_mtime(&target), generation, fingerprint: fingerprint.clone(), outline: None, form_scripts: None, undo: Vec::new(), redo: Vec::new(), full_save: false, fonts: Default::default() };
    docs.insert(id, entry);
    Ok(SaveResult { path: target.display().to_string(), bytes, generation, fingerprint, old_fingerprint })
}

/// Lignes de texte existant de la page, et effet de la dernière modification.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextEditResult {
    lines: Vec<eng::textedit::TextLine>,
    kept_font: bool,
    can_undo: bool,
}

fn text_edit(docs: &mut HashMap<u32, Entry>, doc: u32, page: i32, op: TextEditOp) -> Result<TextEditResult, String> {
    let e = docs.get_mut(&doc).ok_or("document fermé")?;
    let mut kept_font = true;
    if let TextEditOp::Edit { objects, expected, text } = op {
        if !eng::permissions(&e.doc).modify {
            return Err("modify_forbidden".into());
        }
        // Annulable : état complet mémorisé avant la modification (même pile que les pages).
        let before = page_state(e);
        let mut p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
        let r = eng::textedit::edit(&e.doc, &mut p, &mut e.fonts, &objects, &expected, &text).map_err(|e| e.to_string())?;
        drop(p);
        kept_font = r.kept_font;
        match before {
            Some(s) => {
                e.undo.push(s);
                while e.undo.len() > UNDO_STATES || e.undo.iter().map(|s| s.bytes.len()).sum::<usize>() > UNDO_TOTAL {
                    e.undo.remove(0);
                }
            }
            None => e.undo.clear(),
        }
        e.redo.clear();
    }
    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
    Ok(TextEditResult { lines: eng::textedit::lines(&p, page), kept_font, can_undo: !e.undo.is_empty() })
}

/// Filigrane, en-têtes et pieds de page : réglage en place ; après application ou retrait, document
/// à jour (nouvelle génération : toutes les pages changent) et nombre de pages ou d'objets touchés.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StampsResult {
    current: Option<eng::stamps::StampConfig>,
    count: usize,
    info: Option<DocInfo>,
    can_undo: bool,
    can_redo: bool,
}

fn stamps(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, op: StampOp) -> Result<StampsResult, String> {
    let e = docs.get_mut(&id).ok_or("document fermé")?;
    if matches!(op, StampOp::Current) {
        return Ok(StampsResult { current: eng::stamps::current(&e.doc), count: 0, info: None, can_undo: !e.undo.is_empty(), can_redo: !e.redo.is_empty() });
    }
    if !eng::permissions(&e.doc).modify {
        return Err("modify_forbidden".into());
    }
    let before = page_state(e);
    let file = e.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let r = match &op {
        StampOp::Apply { config, date } => eng::stamps::apply(&e.doc, &mut e.fonts, config, &file, date),
        StampOp::Remove => eng::stamps::remove(&e.doc),
        StampOp::Current => unreachable!(),
    };
    let count = match r {
        Ok(n) => n,
        Err(err) => {
            // Une page refusée en route peut laisser les autres déjà modifiées.
            if let Some(s) = before {
                restore(pdfium, e, s)?;
            }
            return Err(err.to_string());
        }
    };
    if count > 0 || matches!(op, StampOp::Apply { .. }) {
        match before {
            Some(s) => {
                e.undo.push(s);
                while e.undo.len() > UNDO_STATES || e.undo.iter().map(|s| s.bytes.len()).sum::<usize>() > UNDO_TOTAL {
                    e.undo.remove(0);
                }
            }
            None => e.undo.clear(),
        }
        e.redo.clear();
        e.generation += 1;
    }
    Ok(StampsResult { current: eng::stamps::current(&e.doc), count, info: Some(info_of(id, e)), can_undo: !e.undo.is_empty(), can_redo: !e.redo.is_empty() })
}

/// Reconnaître le texte : langues, mots écrits sur une page (ou page laissée car elle a déjà du
/// texte), document à jour en fin de série ou après un retrait.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrResult {
    languages: Vec<eng::ocr::OcrLanguage>,
    words: usize,
    skipped: bool,
    info: Option<DocInfo>,
    can_undo: bool,
    can_redo: bool,
}

fn push_undo(e: &mut Entry, before: Option<PageState>) {
    match before {
        Some(s) => {
            e.undo.push(s);
            while e.undo.len() > UNDO_STATES || e.undo.iter().map(|s| s.bytes.len()).sum::<usize>() > UNDO_TOTAL {
                e.undo.remove(0);
            }
        }
        None => e.undo.clear(),
    }
    e.redo.clear();
}

fn ocr(docs: &mut HashMap<u32, Entry>, id: u32, op: OcrOp) -> Result<OcrResult, String> {
    if matches!(op, OcrOp::Languages) {
        return Ok(OcrResult { languages: eng::ocr::languages(), ..Default::default() });
    }
    let e = docs.get_mut(&id).ok_or("document fermé")?;
    if !eng::permissions(&e.doc).modify {
        return Err("modify_forbidden".into());
    }
    let mut r = OcrResult::default();
    match op {
        OcrOp::Languages => unreachable!(),
        OcrOp::Page { page, lang, first, skip_text } => {
            if first {
                let before = page_state(e);
                push_undo(e, before);
            }
            let p = e.doc.pages().get(page).map_err(|err| format!("{err:?}"))?;
            if skip_text && eng::ocr::has_text(&p) {
                r.skipped = true;
            } else {
                let lines = eng::ocr::recognize_page(&p, lang.as_deref()).map_err(|err| err.to_string())?;
                r.words = eng::ocr::add_layer(&e.doc, &p, &mut e.fonts, &lines).map_err(|err| err.to_string())?;
            }
        }
        OcrOp::Finish => {
            e.generation += 1;
            r.info = Some(info_of(id, e));
        }
        OcrOp::Remove => {
            let before = page_state(e);
            let mut n = 0;
            for p in e.doc.pages().iter() {
                n += eng::ocr::remove_layer(&p).map_err(|err| err.to_string())?;
            }
            if n > 0 {
                push_undo(e, before);
                e.generation += 1;
            }
            r.words = n;
            r.info = Some(info_of(id, e));
        }
    }
    r.can_undo = !e.undo.is_empty();
    r.can_redo = !e.redo.is_empty();
    Ok(r)
}

/// Texte ajouté dans le contenu de la page : liste, ajout ou remplacement, suppression ; renvoie les
/// blocs de la page et l'identifiant du bloc écrit.
#[derive(Debug, Serialize)]
struct PageTextResult {
    id: Option<String>,
    blocks: Vec<eng::pagetext::TextBlock>,
}

fn page_text(docs: &mut HashMap<u32, Entry>, doc: u32, page: i32, op: PageTextOp) -> Result<PageTextResult, String> {
    let e = docs.get_mut(&doc).ok_or("document fermé")?;
    let mut p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
    let id = match op {
        PageTextOp::List => None,
        PageTextOp::Set { id, x, y, text, style } => {
            if !eng::permissions(&e.doc).modify {
                return Err("modify_forbidden".into());
            }
            eng::pagetext::set(&e.doc, &mut p, &mut e.fonts, id.as_deref(), x, y, &text, &style).map_err(|e| e.to_string())?
        }
        PageTextOp::Delete { id } => {
            if !eng::permissions(&e.doc).modify {
                return Err("modify_forbidden".into());
            }
            eng::pagetext::delete(&mut p, &id).map_err(|e| e.to_string())?;
            None
        }
    };
    Ok(PageTextResult { id, blocks: eng::pagetext::list(&p, page) })
}

/// Une autre modification (commentaire, champ, signet) rend les états mémorisés obsolètes : les
/// rétablir l'effacerait.
fn forget_page_history(docs: &mut HashMap<u32, Entry>, doc: u32) {
    if let Some(e) = docs.get_mut(&doc) {
        e.undo.clear();
        e.redo.clear();
    }
}

/// Copie complète du document en mémoire (None : fichier trop gros pour être annulable).
fn page_state(e: &Entry) -> Option<PageState> {
    if std::fs::metadata(&e.path).map(|m| m.len()).unwrap_or(0) > UNDO_FILE_MAX {
        return None;
    }
    let bytes = e.doc.save_to_bytes().ok()?;
    Some(PageState { bytes, outline: e.outline.clone() })
}

fn restore(pdfium: &'static Pdfium, e: &mut Entry, s: PageState) -> Result<(), String> {
    e.doc = pdfium.load_pdf_from_byte_vec(s.bytes, e.password.as_deref()).map_err(|err| format!("{err:?}"))?;
    e.outline = s.outline;
    e.fonts.clear();
    // Document relu depuis la mémoire : enregistrement complet.
    e.full_save = true;
    Ok(())
}

fn page_op(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, op: PageOp) -> Result<PagesResult, String> {
    use eng::pages;
    let e = docs.get_mut(&id).ok_or("document fermé")?;
    let rights = eng::permissions(&e.doc);
    let history = matches!(op, PageOp::Undo | PageOp::Redo);
    if !rights.assemble && !(history && rights.modify) {
        return Err("assemble_forbidden".into());
    }
    let mut map = None;
    match op {
        PageOp::Undo => {
            let prev = e.undo.pop().ok_or("rien à annuler")?;
            if let Some(cur) = page_state(e) {
                e.redo.push(cur);
            }
            restore(pdfium, e, prev)?;
        }
        PageOp::Redo => {
            let next = e.redo.pop().ok_or("rien à rétablir")?;
            if let Some(cur) = page_state(e) {
                e.undo.push(cur);
            }
            restore(pdfium, e, next)?;
        }
        op => {
            let before = page_state(e);
            let r = match op {
                PageOp::Rotate { pages, quarters } => pages::rotate(&e.doc, &pages, quarters),
                PageOp::Delete { pages } => pages::delete(&e.doc, &pages).inspect(|_| e.full_save = true),
                PageOp::Move { pages, before } => pages::move_pages(&e.doc, &pages, before),
                PageOp::InsertBlank { at, width, height } => pages::insert_blank(&e.doc, at, width, height),
                PageOp::InsertFile { at, path, .. } if eng::images::is_image_path(&path) => {
                    // Image : une page de la taille de la page voisine.
                    let near = e.doc.pages().get((at - 1).max(0)).map(|p| (p.width().value, p.height().value)).unwrap_or((595.28, 841.89));
                    let opts = eng::images::ImagePageOptions { size: eng::images::PageSize::Fixed { width: near.0, height: near.1 }, margin: 0.0 };
                    let n = e.doc.pages().len();
                    eng::images::add_image_page(&e.doc, at, &path, &opts).map(|_| (0..n).map(|p| Some(if p >= at { p + 1 } else { p })).collect())
                }
                PageOp::InsertFile { at, path, password, pages: wanted } => {
                    let src = eng::open_typed(pdfium, &path, password.as_deref()).map_err(|err| match err {
                        eng::OpenError::PasswordRequired | eng::OpenError::WrongPassword => "source_password".to_string(),
                        other => format!("source_unreadable: {other}"),
                    })?;
                    if !eng::permissions(&src).assemble {
                        return Err("assemble_forbidden".into());
                    }
                    pages::insert_from(&e.doc, &src, wanted.as_deref(), at).map(|(m, _)| m)
                }
                PageOp::Undo | PageOp::Redo => unreachable!(),
            };
            match r {
                Ok(m) => {
                    match before {
                        Some(s) => {
                            e.undo.push(s);
                            while e.undo.len() > UNDO_STATES || e.undo.iter().map(|s| s.bytes.len()).sum::<usize>() > UNDO_TOTAL {
                                e.undo.remove(0);
                            }
                        }
                        None => e.undo.clear(),
                    }
                    e.redo.clear();
                    if let Some(items) = e.outline.as_mut() {
                        pages::remap_outline(items, &m);
                    }
                    map = Some(m);
                }
                Err(err) => {
                    // Une opération refusée en route peut laisser le document à moitié modifié.
                    if let Some(s) = before {
                        restore(pdfium, e, s)?;
                    }
                    return Err(err.to_string());
                }
            }
        }
    }
    e.generation += 1;
    e.form_scripts = None;
    Ok(PagesResult { info: info_of(id, e), map, can_undo: !e.undo.is_empty(), can_redo: !e.redo.is_empty() })
}

/// Une copie hors du document (extraire, diviser, combiner) n'est pas chiffrée : refusée pour un
/// document protégé, qui perdrait sa protection, et sans le droit d'assembler.
fn may_copy_out(doc: &PdfDocument) -> Result<(), String> {
    if eng::is_encrypted(doc) {
        return Err("encrypted".into());
    }
    if !eng::permissions(doc).assemble {
        return Err("assemble_forbidden".into());
    }
    Ok(())
}

/// Document protégé (ou dont la protection est retirée) : enregistré et rouvert.
#[derive(Debug, Serialize)]
struct ProtectResult {
    info: DocInfo,
    save: SaveResult,
}

fn protect_doc(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, protection: Option<eng::security::Protection>, target: Option<PathBuf>) -> Result<ProtectResult, String> {
    use eng::security;
    let e = get(docs, id)?;
    // Changer ou retirer une protection demande tous les droits (mot de passe des droits).
    if !security::full_rights(&e.doc) {
        return Err("owner_required".into());
    }
    if protection.is_none() && !eng::is_encrypted(&e.doc) {
        return Err("not_protected".into());
    }
    let password = protection.as_ref().and_then(|p| p.full_access_password());
    let (info, save) = rewrite_doc(pdfium, docs, id, target, password, |plain| match &protection {
        Some(p) => security::protect(&plain, p).map_err(|e| e.to_string()),
        None => Ok(plain),
    })?;
    Ok(ProtectResult { info, save })
}

/// Document compressé : enregistré et rouvert, avec les tailles avant et après.
#[derive(Debug, Serialize)]
struct CompressResult {
    info: DocInfo,
    save: SaveResult,
    report: eng::compress::CompressReport,
}

fn compress_doc(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, options: eng::compress::CompressOptions, target: Option<PathBuf>) -> Result<CompressResult, String> {
    let e = get(docs, id)?;
    // Un document chiffré perdrait sa protection : il faut d'abord la retirer.
    if eng::is_encrypted(&e.doc) {
        return Err("encrypted".into());
    }
    let before = std::fs::metadata(&e.path).map(|m| m.len()).unwrap_or(0);
    let longest = e.doc.pages().iter().map(|p| p.width().value.max(p.height().value)).fold(0.0f32, f32::max);
    let mut report = eng::compress::CompressReport::default();
    let (info, save) = rewrite_doc(pdfium, docs, id, target, None, |plain| {
        let (out, r) = eng::compress::compress(&plain, &options, longest).map_err(|e| e.to_string())?;
        // Rien à gagner (déjà compact) : on n'écrit rien.
        if before > 0 && r.after >= before {
            return Err("no_gain".into());
        }
        report = r;
        Ok(out)
    })?;
    report.before = before;
    Ok(CompressResult { info, save, report })
}

/// Réécrit le document ouvert : copie en clair (modifications et signets en attente compris)
/// transformée par `transform`, écrite sur place ou sous `target`, puis rouverte avec `password`.
fn rewrite_doc(
    pdfium: &'static Pdfium,
    docs: &mut HashMap<u32, Entry>,
    id: u32,
    target: Option<PathBuf>,
    password: Option<String>,
    transform: impl FnOnce(Vec<u8>) -> Result<Vec<u8>, String>,
) -> Result<(DocInfo, SaveResult), String> {
    let e = get(docs, id)?;
    let same_file = target.as_ref().map(|t| same_path(t, &e.path)).unwrap_or(true);
    let target = target.unwrap_or_else(|| e.path.clone());
    if same_file && eng::file_mtime(&e.path) != e.mtime {
        return Err("file_changed".into());
    }
    let mut plain = eng::security::plain_bytes(&e.doc).map_err(|e| e.to_string())?;
    // Signets en attente : écrits dans la copie en clair (fichier temporaire, aussitôt effacé).
    if let Some(items) = &e.outline {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!("pdfreader-{}-{nonce}.pdf", std::process::id()));
        let r = std::fs::write(&tmp, &plain).map_err(|e| e.to_string()).and_then(|_| eng::outline::write(&tmp, items, &frames(&e.doc)).map_err(|e| e.to_string())).and_then(|_| std::fs::read(&tmp).map_err(|e| e.to_string()));
        let _ = std::fs::remove_file(&tmp);
        plain = r?;
    }
    let bytes = transform(plain)?;
    eng::atomic_write(&target, |f| {
        use std::io::Write;
        f.write_all(&bytes)?;
        Ok(())
    })
    .map_err(|err| if err.to_string().contains("os error 32") || err.to_string().contains("os error 5") { "file_locked".to_string() } else { err.to_string() })?;
    let (generation, old_fingerprint) = (e.generation + 1, e.fingerprint.clone());
    let doc = eng::open_typed(pdfium, &target, password.as_deref()).map_err(|e| e.to_string())?;
    let fingerprint = eng::fingerprint(&target).map_err(|e| e.to_string())?;
    let entry = Entry {
        doc,
        path: target.clone(),
        password,
        mtime: eng::file_mtime(&target),
        generation,
        fingerprint: fingerprint.clone(),
        outline: None,
        form_scripts: None,
        undo: Vec::new(),
        redo: Vec::new(),
        full_save: false,
        fonts: Default::default(),
    };
    let info = info_of(id, &entry);
    docs.insert(id, entry);
    Ok((info, SaveResult { path: target.display().to_string(), bytes: bytes.len() as u64, generation, fingerprint, old_fingerprint }))
}

/// Image écrite : chemin final (renommé si le fichier existait) et dimensions.
#[derive(Debug, Serialize)]
struct ExportedImage {
    path: String,
    #[serde(flatten)]
    result: eng::export::ImageResult,
}

/// Le chemin s'il est libre, sinon « nom (2).ext », « nom (3).ext »…
fn free_file(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let dir = p.parent().unwrap_or(Path::new("."));
    (2..).map(|n| dir.join(format!("{stem} ({n}).{ext}"))).find(|c| !c.exists()).unwrap()
}

/// Nom libre dans `folder` : « nom.pdf », sinon « nom (2).pdf »…
fn free_name(folder: &Path, stem: &str) -> PathBuf {
    let mut p = folder.join(format!("{stem}.pdf"));
    let mut n = 2;
    while p.exists() {
        p = folder.join(format!("{stem} ({n}).pdf"));
        n += 1;
    }
    p
}

fn split(pdfium: &'static Pdfium, e: &Entry, per_file: i32, folder: &Path) -> Result<Vec<String>, String> {
    may_copy_out(&e.doc)?;
    if !folder.is_dir() {
        return Err("dossier introuvable".into());
    }
    let ranges = eng::pages::split_ranges(e.doc.pages().len(), per_file);
    if ranges.len() > 1000 {
        return Err("trop de fichiers".into());
    }
    let stem = e.path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Document".into());
    let mut written = Vec::new();
    for (k, (a, b)) in ranges.iter().enumerate() {
        let target = free_name(folder, &format!("{stem} - partie {}", k + 1));
        let pages: Vec<i32> = (*a..=*b).collect();
        eng::pages::extract(pdfium, &e.doc, &pages, &target).map_err(|e| e.to_string())?;
        written.push(target.display().to_string());
    }
    Ok(written)
}

fn combine(pdfium: &'static Pdfium, sources: &[PathBuf], target: &Path, image_page: &eng::images::ImagePageOptions) -> Result<i32, String> {
    if sources.is_empty() || sources.len() > 500 {
        return Err("aucun fichier".into());
    }
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let out = pdfium.create_new_pdf().map_err(|e| format!("{e:?}"))?;
    let mut prefs_from: Option<PdfDocument> = None;
    for p in sources {
        let at = out.pages().len();
        if eng::images::is_image_path(p) {
            eng::images::add_image_page(&out, at, p, image_page).map_err(|err| format!("image_unreadable: {} ({err})", name(p)))?;
            continue;
        }
        let d = eng::open_typed(pdfium, p, None).map_err(|err| match err {
            eng::OpenError::PasswordRequired => format!("encrypted: {}", name(p)),
            other => format!("source_unreadable: {} ({other})", name(p)),
        })?;
        may_copy_out(&d).map_err(|err| format!("{err}: {}", name(p)))?;
        if !d.pages().is_empty() {
            eng::pages::insert_from(&out, &d, None, at).map_err(|e| e.to_string())?;
        }
        // Préférences d'affichage reprises du premier PDF.
        if prefs_from.is_none() {
            prefs_from = Some(d);
        }
    }
    if let Some(first) = &prefs_from {
        unsafe { raw_bindings().FPDF_CopyViewerPreferences(out.raw_handle(), first.raw_handle()) };
    }
    eng::save(&out, target, false).map_err(|e| e.to_string())?;
    Ok(out.pages().len())
}

fn frames(doc: &PdfDocument) -> Vec<eng::Frame> {
    doc.pages().iter().map(|p| eng::Frame::of(&p)).collect()
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


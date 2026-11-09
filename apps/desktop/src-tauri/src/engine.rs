//! Thread moteur : seul propriétaire de PDFium (non thread-safe). Les commandes Tauri et le
//! protocole `pdfpage://` lui envoient des messages et attendent la réponse.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::SystemTime;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use serde::Serialize;
use tauri::UriSchemeResponder;
use tauri::http::Response;
use tokio::sync::oneshot;

pub type Reply<T> = oneshot::Sender<Result<T, String>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub title: Option<String>,
    pub page_count: i32,
    /// Taille de chaque page en points PDF (largeur, hauteur), rotation comprise.
    pub pages: Vec<[f32; 2]>,
    pub encrypted: bool,
    pub has_form: bool,
    pub is_xfa: bool,
    pub permissions: eng::Permissions,
    /// Empreinte du fichier (clé des récents et de l'état de vue).
    pub fingerprint: String,
    /// Dernier état de vue mémorisé, rempli par la commande `doc_open`.
    pub view_state: Option<serde_json::Value>,
    /// Change à chaque rechargement (après enregistrement) : invalide le cache des tuiles.
    pub generation: u32,
}

#[derive(Debug, Serialize)]
pub struct OpenResult {
    pub info: DocInfo,
    #[serde(skip)]
    pub size: u64,
    #[serde(skip)]
    pub thumbnail: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub bytes: u64,
    pub generation: u32,
    pub fingerprint: String,
    #[serde(skip)]
    pub old_fingerprint: String,
}

/// Opération sur les commentaires d'une page.
pub enum AnnotOp {
    List,
    Markup { kind: String, rects: Vec<[f32; 4]>, color: [u8; 3], opacity: f32, author: String },
    Note { x: f32, y: f32, contents: String, color: [u8; 3], author: String },
    Ink { strokes: Vec<Vec<[f32; 2]>>, color: [u8; 3], opacity: f32, width: f32, author: String },
    Update { id: String, patch: eng::annotations::AnnotPatch },
    Text { x: f32, y: f32, text: String, size: f32, color: [u8; 3], author: String },
    Mark { x: f32, y: f32, size: f32, cross: bool, color: [u8; 3], author: String },
    Image { rect: [f32; 4], png: Vec<u8>, kind: String, author: String },
    Delete { id: String },
}

/// Commentaire créé (s'il y en a un) et liste à jour des commentaires de la page.
#[derive(Debug, Serialize)]
pub struct AnnotResult {
    pub id: Option<String>,
    pub annots: Vec<eng::annotations::Annot>,
}

pub enum Cmd {
    Open { path: PathBuf, password: Option<String>, reply: oneshot::Sender<Result<OpenResult, eng::OpenError>> },
    TextLayer { doc: u32, page: i32, reply: Reply<Vec<Vec<eng::TextWord>>> },
    Annot { doc: u32, page: i32, op: AnnotOp, reply: Reply<AnnotResult> },
    Save { doc: u32, path: Option<PathBuf>, reply: Reply<SaveResult> },
    CountHighlights { doc: u32, page: i32, reply: Reply<usize> },
    Fields { doc: u32, page: i32, reply: Reply<Vec<eng::fill::Field>> },
    SetField { doc: u32, page: i32, index: i32, input: eng::fill::FieldInput, reply: Reply<Vec<eng::fill::Field>> },
    Links { doc: u32, page: i32, reply: Reply<Vec<eng::PageLink>> },
    Bookmarks { doc: u32, reply: Reply<Vec<eng::Bookmark>> },
    Search { doc: u32, from: i32, count: i32, query: String, match_case: bool, whole_word: bool, reply: Reply<eng::SearchBatch> },
    Close { doc: u32 },
    Tile { doc: u32, page: i32, scale: f32, x: i32, y: i32, size: i32, responder: UriSchemeResponder },
}

struct Entry {
    doc: PdfDocument<'static>,
    path: PathBuf,
    password: Option<String>,
    mtime: Option<SystemTime>,
    generation: u32,
    fingerprint: String,
}

#[derive(Clone)]
pub struct EngineHandle(pub mpsc::Sender<Cmd>);

impl EngineHandle {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.0.send(cmd);
    }
}

/// Démarre le thread moteur. `lib_dir` : dossier qui contient pdfium.dll.
pub fn start(lib_dir: PathBuf) -> EngineHandle {
    let (tx, rx) = mpsc::channel::<Cmd>();
    std::thread::Builder::new()
        .name("moteur-pdf".into())
        .spawn(move || run(lib_dir, rx))
        .expect("thread moteur");
    EngineHandle(tx)
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
        permissions: eng::permissions(doc),
        fingerprint: e.fingerprint.clone(),
        view_state: None,
        generation: e.generation,
    }
}

fn respond(responder: UriSchemeResponder, status: u16, content_type: &str, body: Vec<u8>) {
    responder.respond(
        Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            // L'URL contient la génération du document et la version de la page : immuable.
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(body)
            .unwrap(),
    );
}

fn run(lib_dir: PathBuf, rx: mpsc::Receiver<Cmd>) {
    let pdfium: &'static Pdfium = match eng::load_pdfium(&lib_dir) {
        Ok(p) => Box::leak(Box::new(p)),
        Err(e) => {
            eprintln!("PDFium introuvable : {e:#}");
            // On répond en erreur à tout, pour que l'interface l'affiche au lieu de rester bloquée.
            for cmd in rx {
                fail(cmd, "Le moteur PDF n'a pas pu démarrer (pdfium.dll introuvable).");
            }
            return;
        }
    };
    let mut docs: HashMap<u32, Entry> = HashMap::new();
    let mut next_id: u32 = 1;

    for cmd in rx {
        match cmd {
            Cmd::Open { path, password, reply } => {
                let result = (|| {
                    let doc = eng::open_typed(pdfium, &path, password.as_deref())?;
                    let thumbnail = eng::thumbnail_png(&doc, 160).unwrap_or_default();
                    let fingerprint = eng::fingerprint(&path).map_err(|e| eng::OpenError::Other(e.to_string()))?;
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    let entry = Entry { doc, path: path.clone(), password: password.clone(), mtime: eng::file_mtime(&path), generation: 1, fingerprint };
                    let id = next_id;
                    next_id += 1;
                    let info = info_of(id, &entry);
                    docs.insert(id, entry);
                    Ok(OpenResult { info, size, thumbnail })
                })();
                let _ = reply.send(result);
            }
            Cmd::TextLayer { doc, page, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    eng::text_layer(&p).map_err(|e| e.to_string())
                });
                let _ = reply.send(r);
            }
            Cmd::Annot { doc, page, op, reply } => {
                use eng::annotations as an;
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let mut p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    let id = match op {
                        AnnotOp::List => None,
                        AnnotOp::Markup { kind, rects, color, opacity, author } => Some(an::add_markup(&mut p, &kind, &rects, color, opacity, &author)),
                        AnnotOp::Note { x, y, contents, color, author } => Some(an::add_note(&mut p, x, y, &contents, color, &author)),
                        AnnotOp::Ink { strokes, color, opacity, width, author } => Some(an::add_ink(&mut p, &strokes, color, opacity, width, &author)),
                        AnnotOp::Text { x, y, text, size, color, author } => Some(eng::fill::add_text(&e.doc, &mut p, x, y, &text, size, color, &author)),
                        AnnotOp::Mark { x, y, size, cross, color, author } => Some(eng::fill::add_mark(&mut p, x, y, size, cross, color, &author)),
                        AnnotOp::Image { rect, png, kind, author } => Some(eng::fill::add_image(&e.doc, &mut p, rect, &png, &kind, &author)),
                        AnnotOp::Update { id, patch } => {
                            an::update(&mut p, &id, &patch).map_err(|e| e.to_string())?;
                            None
                        }
                        AnnotOp::Delete { id } => {
                            an::delete(&mut p, &id).map_err(|e| e.to_string())?;
                            None
                        }
                    };
                    let id = id.transpose().map_err(|e| e.to_string())?;
                    Ok(AnnotResult { id, annots: an::list(&p, page) })
                });
                let _ = reply.send(r);
            }
            Cmd::CountHighlights { doc, page, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::count_annotations(&p, PdfPageAnnotationType::Highlight))
                });
                let _ = reply.send(r);
            }
            Cmd::Links { doc, page, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::page_links(&e.doc, &p))
                });
                let _ = reply.send(r);
            }
            Cmd::Fields { doc, page, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    Ok(eng::fill::fields(&e.doc, &p, page))
                });
                let _ = reply.send(r);
            }
            Cmd::SetField { doc, page, index, input, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    eng::fill::set_field(&e.doc, &p, index, &input).map_err(|e| e.to_string())?;
                    Ok(eng::fill::fields(&e.doc, &p, page))
                });
                let _ = reply.send(r);
            }
            Cmd::Bookmarks { doc, reply } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).map(|e| eng::bookmarks(&e.doc));
                let _ = reply.send(r);
            }
            Cmd::Search { doc, from, count, query, match_case, whole_word, reply } => {
                let r = docs
                    .get(&doc)
                    .ok_or("document fermé".to_string())
                    .and_then(|e| eng::search(&e.doc, from, count, &query, match_case, whole_word).map_err(|e| e.to_string()));
                let _ = reply.send(r);
            }
            Cmd::Save { doc, path, reply } => {
                let r = save(pdfium, &mut docs, doc, path);
                let _ = reply.send(r);
            }
            Cmd::Close { doc } => {
                docs.remove(&doc);
            }
            Cmd::Tile { doc, page, scale, x, y, size, responder } => {
                let r = docs.get(&doc).ok_or("document fermé".to_string()).and_then(|e| {
                    let p = e.doc.pages().get(page).map_err(|e| format!("{e:?}"))?;
                    let tile = eng::render_tile(&p, scale, x, y, size).map_err(|e| e.to_string())?;
                    eng::tile_webp(&tile).map_err(|e| e.to_string())
                });
                match r {
                    Ok(webp) => respond(responder, 200, "image/webp", webp),
                    Err(e) => respond(responder, 404, "text/plain", e.into_bytes()),
                }
            }
        }
    }
}

/// Enregistre (sur place ou ailleurs), puis recharge le document depuis le fichier écrit pour que
/// les enregistrements suivants s'appuient sur la nouvelle version.
fn save(pdfium: &'static Pdfium, docs: &mut HashMap<u32, Entry>, id: u32, target: Option<PathBuf>) -> Result<SaveResult, String> {
    let e = docs.get(&id).ok_or("document fermé")?;
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
    let password = e.password.clone();
    let generation = e.generation + 1;
    let old_fingerprint = e.fingerprint.clone();
    let doc = eng::open_typed(pdfium, &target, password.as_deref()).map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let fingerprint = eng::fingerprint(&target).map_err(|e| e.to_string())?;
    let entry = Entry { doc, path: target.clone(), password, mtime: eng::file_mtime(&target), generation, fingerprint: fingerprint.clone() };
    docs.insert(id, entry);
    Ok(SaveResult { path: target.display().to_string(), bytes, generation, fingerprint, old_fingerprint })
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn fail(cmd: Cmd, msg: &str) {
    match cmd {
        Cmd::Open { reply, .. } => {
            let _ = reply.send(Err(eng::OpenError::Other(msg.into())));
        }
        Cmd::TextLayer { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Annot { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::CountHighlights { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Links { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Bookmarks { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Fields { reply, .. } | Cmd::SetField { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Search { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Save { reply, .. } => {
            let _ = reply.send(Err(msg.into()));
        }
        Cmd::Close { .. } => {}
        Cmd::Tile { responder, .. } => respond(responder, 503, "text/plain", msg.as_bytes().to_vec()),
    }
}

// PDFReader : application de bureau. Coquille Tauri : commandes, protocole des tuiles, base locale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod engine;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use engine::{AnnotOp, AnnotResult, Cmd, DocInfo, EngineHandle, SaveResult};
use pdfreader_engine::{Bookmark, OpenError, PageLink, SearchBatch, TextWord};
use tauri::http::Response;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// Fichiers .pdf passés en argument (double-clic, « Ouvrir avec »).
fn pdf_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false))
        .map(|p| p.display().to_string())
        .collect()
}

fn author_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "Utilisateur".into())
}

async fn ask<T>(engine: &EngineHandle, make: impl FnOnce(engine::Reply<T>) -> Cmd) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    engine.send(make(tx));
    rx.await.map_err(|_| "moteur indisponible".to_string())?
}

// ------------------------------------------------------------------ commandes

#[tauri::command]
fn get_launch_files() -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    pdf_args(std::env::args(), &cwd)
}

#[tauri::command]
async fn doc_open(path: String, password: Option<String>, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<DocInfo, OpenError> {
    let (tx, rx) = oneshot::channel();
    engine.send(Cmd::Open { path: PathBuf::from(&path), shown_as: None, password, reply: tx });
    let mut r = rx.await.map_err(|_| OpenError::Other("moteur indisponible".into()))??;
    let _ = db.touch(&r.info.fingerprint, &r.info.path, &r.info.name, r.size, r.info.page_count, &r.thumbnail);
    r.info.view_state = db.view_state(&r.info.fingerprint);
    Ok(r.info)
}

#[tauri::command]
async fn doc_text_layer(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<Vec<Vec<TextWord>>, String> {
    ask(&engine, |reply| Cmd::TextLayer { doc, page, reply }).await
}

/// Nom d'auteur des commentaires : préférence « author », sinon le nom de session Windows.
fn comment_author(db: &db::Db) -> String {
    db.preferences()
        .ok()
        .and_then(|p| p.get("author").and_then(|v| v.as_str()).map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(100).collect())
        .unwrap_or_else(author_name)
}

#[tauri::command]
async fn doc_annotations(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<AnnotResult, String> {
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::List, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn annot_add_markup(
    doc: u32,
    page: i32,
    kind: String,
    rects: Vec<[f32; 4]>,
    color: [u8; 3],
    opacity: f32,
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Markup { kind, rects, color, opacity, author }, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn annot_add_note(
    doc: u32,
    page: i32,
    x: f32,
    y: f32,
    contents: String,
    color: [u8; 3],
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Note { x, y, contents, color, author }, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn annot_add_shape(
    doc: u32,
    page: i32,
    kind: String,
    points: Vec<[f32; 2]>,
    color: [u8; 3],
    opacity: f32,
    width: f32,
    fill: Option<[u8; 3]>,
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Shape { kind, points, color, opacity, width, fill, author }, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn annot_add_stamp(
    doc: u32,
    page: i32,
    x: f32,
    y: f32,
    preset: String,
    label: String,
    subtitle: Option<String>,
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Stamp { x, y, preset, label, subtitle, author }, reply }).await
}

#[tauri::command]
async fn annot_reply(doc: u32, page: i32, parent: String, contents: String, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Reply { parent, contents, author }, reply }).await
}

#[tauri::command]
async fn annot_set_status(doc: u32, page: i32, id: String, status: Option<String>, marked: Option<bool>, engine: State<'_, EngineHandle>) -> Result<AnnotResult, String> {
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Status { id, status, marked }, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn annot_add_ink(
    doc: u32,
    page: i32,
    strokes: Vec<Vec<[f32; 2]>>,
    color: [u8; 3],
    opacity: f32,
    width: f32,
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Ink { strokes, color, opacity, width, author }, reply }).await
}

#[tauri::command]
async fn annot_update(doc: u32, page: i32, id: String, patch: pdfreader_engine::annotations::AnnotPatch, engine: State<'_, EngineHandle>) -> Result<AnnotResult, String> {
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Update { id, patch }, reply }).await
}

#[tauri::command]
async fn annot_delete(doc: u32, page: i32, id: String, engine: State<'_, EngineHandle>) -> Result<AnnotResult, String> {
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Delete { id }, reply }).await
}

#[tauri::command]
async fn doc_fields(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<Vec<pdfreader_engine::fill::Field>, String> {
    ask(&engine, |reply| Cmd::Fields { doc, page, reply }).await
}

#[tauri::command]
async fn field_set(doc: u32, page: i32, index: i32, input: pdfreader_engine::fill::FieldInput, scripts: bool, engine: State<'_, EngineHandle>) -> Result<engine::SetFieldResult, String> {
    ask(&engine, |reply| Cmd::SetField { doc, page, index, input, scripts, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fill_add_text(
    doc: u32,
    page: i32,
    x: f32,
    y: f32,
    text: String,
    size: f32,
    color: [u8; 3],
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Text { x, y, text, size, color, author }, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fill_add_mark(
    doc: u32,
    page: i32,
    x: f32,
    y: f32,
    size: f32,
    cross: bool,
    color: [u8; 3],
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Mark { x, y, size, cross, color, author }, reply }).await
}

/// Zone de texte encadrée ; avec `anchor`, légende reliée au point désigné.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fill_add_textbox(
    doc: u32,
    page: i32,
    rect: [f32; 4],
    text: String,
    size: f32,
    color: [u8; 3],
    filled: bool,
    anchor: Option<[f32; 2]>,
    engine: State<'_, EngineHandle>,
    db: State<'_, db::Db>,
) -> Result<AnnotResult, String> {
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::TextBox { rect, text, size, color, filled, anchor, author }, reply }).await
}

/// Pose la signature (ou les initiales) mémorisée dans le rectangle donné.
#[tauri::command]
async fn fill_add_signature(doc: u32, page: i32, rect: [f32; 4], kind: String, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<AnnotResult, String> {
    let sig = db.signature(&kind).map_err(|e| e.to_string())?.ok_or("aucune signature enregistrée")?;
    let png = decode_png_data_url(&sig.data)?;
    let author = comment_author(&db);
    ask(&engine, |reply| Cmd::Annot { doc, page, op: AnnotOp::Image { rect, png, kind, author }, reply }).await
}

fn decode_png_data_url(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64 = data.strip_prefix("data:image/png;base64,").ok_or("format de signature inattendu")?;
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())
}

#[tauri::command]
fn signature_get(kind: String, db: State<'_, db::Db>) -> Result<Option<db::Signature>, String> {
    db.signature(&kind).map_err(|e| e.to_string())
}

#[tauri::command]
fn signature_set(kind: String, method: String, data: String, font: Option<String>, db: State<'_, db::Db>) -> Result<(), String> {
    if !matches!(kind.as_str(), "signature" | "initials") || !matches!(method.as_str(), "typed" | "drawn" | "image") {
        return Err("valeur refusée".into());
    }
    // Vérifie que c'est bien un PNG lisible et de taille raisonnable avant de l'enregistrer.
    if data.len() > 4_000_000 {
        return Err("image trop lourde".into());
    }
    let png = decode_png_data_url(&data)?;
    if !png.starts_with(b"\x89PNG") {
        return Err("ce n'est pas une image PNG".into());
    }
    db.set_signature(&kind, &method, &data, font.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn signature_delete(kind: String, db: State<'_, db::Db>) -> Result<(), String> {
    db.delete_signature(&kind).map_err(|e| e.to_string())
}

/// Dossier de données de cette session.
struct DataDir(PathBuf);

fn recovery_dir(data: &DataDir) -> PathBuf {
    data.0.join("recovery")
}

fn remove_files(files: Vec<String>) {
    for f in files {
        // Peut échouer si le fichier est encore ouvert : il sera supprimé au prochain démarrage.
        let _ = std::fs::remove_file(f);
    }
}

/// Copie de récupération des modifications non enregistrées d'un document ouvert.
#[tauri::command]
async fn recovery_snapshot(doc: u32, path: String, fingerprint: String, engine: State<'_, EngineHandle>, db: State<'_, db::Db>, data: State<'_, DataDir>) -> Result<(), String> {
    let dir = recovery_dir(&data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{}.pdf", uuid::Uuid::new_v4()));
    ask(&engine, |reply| Cmd::Snapshot { doc, target: target.clone(), reply }).await?;
    let old = db.add_snapshot(&fingerprint, &path, &target.display().to_string()).map_err(|e| e.to_string())?;
    remove_files(old);
    Ok(())
}

/// Le document a été enregistré ou fermé volontairement : ses copies ne servent plus.
#[tauri::command]
fn recovery_clear(path: String, db: State<'_, db::Db>) -> Result<(), String> {
    remove_files(db.remove_snapshots(None, Some(&path)).map_err(|e| e.to_string())?);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryItem {
    id: String,
    original_path: String,
    name: String,
    created_at: i64,
}

/// Copies laissées par une fermeture inattendue (plantage, coupure de courant).
#[tauri::command]
fn recovery_list(db: State<'_, db::Db>) -> Result<Vec<RecoveryItem>, String> {
    let mut out = Vec::new();
    for (id, original, snapshot, created_at) in db.snapshots().map_err(|e| e.to_string())? {
        if !Path::new(&snapshot).exists() {
            let _ = db.remove_snapshots(Some(&id), None);
            continue;
        }
        let name = Path::new(&original).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Document".into());
        out.push(RecoveryItem { id, original_path: original, name, created_at });
    }
    Ok(out)
}

/// Rouvre une copie de récupération à la place du document d'origine : Ctrl+S l'enregistrera
/// sous le chemin d'origine.
#[tauri::command]
async fn recovery_restore(id: String, password: Option<String>, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<DocInfo, OpenError> {
    let (original, snapshot) = db
        .snapshots()
        .map_err(|e| OpenError::Other(e.to_string()))?
        .into_iter()
        .find(|s| s.0 == id)
        .map(|s| (s.1, s.2))
        .ok_or(OpenError::NotFound)?;
    let (tx, rx) = oneshot::channel();
    engine.send(Cmd::Open { path: PathBuf::from(&snapshot), shown_as: Some(PathBuf::from(&original)), password, reply: tx });
    let mut r = rx.await.map_err(|_| OpenError::Other("moteur indisponible".into()))??;
    r.info.view_state = db.view_state(&r.info.fingerprint);
    Ok(r.info)
}

#[tauri::command]
fn recovery_discard(id: String, db: State<'_, db::Db>) -> Result<(), String> {
    remove_files(db.remove_snapshots(Some(&id), None).map_err(|e| e.to_string())?);
    Ok(())
}

#[tauri::command]
fn pref_reset(db: State<'_, db::Db>) -> Result<(), String> {
    db.reset_preferences().map_err(|e| e.to_string())
}

#[tauri::command]
async fn printer_sheet(name: String) -> Result<Option<[f32; 2]>, String> {
    tauri::async_runtime::spawn_blocking(move || pdfreader_engine::print_win::sheet_size(&name)).await.map_err(|e| e.to_string())
}

/// Documents légaux installés avec l'application : contrat de licence, mentions des composants
/// tiers (texte complet ou résumé JSON). Liste fermée de fichiers.
#[tauri::command]
fn legal_document(name: String, app: AppHandle) -> Result<String, String> {
    let file = match name.as_str() {
        "licence" => "LICENCE.txt",
        "notices" => "THIRD-PARTY-NOTICES.txt",
        "summary" => "third-party.json",
        _ => return Err("document inconnu".into()),
    };
    let mut candidates = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join(file));
    }
    // Développement : fichiers du dépôt.
    if let Some(root) = repo_root() {
        candidates.push(root.join("apps").join("desktop").join("src-tauri").join("legal").join(file));
    }
    let path = candidates.into_iter().find(|p| p.exists()).ok_or("document introuvable")?;
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

#[derive(serde::Serialize)]
struct AppInfo {
    name: String,
    version: String,
    pdfium: String,
    data_dir: String,
}

#[tauri::command]
fn app_info(app: AppHandle, data: State<'_, DataDir>) -> AppInfo {
    let build = env!("PDFIUM_BUILD");
    let pdfium_version = if build.is_empty() { "intégré".to_string() } else { format!("chromium/{build}") };
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        pdfium: pdfium_version,
        data_dir: data.0.display().to_string(),
    }
}

/// Ouvre une page des Paramètres de Windows (liste fermée : applications par défaut, imprimantes).
#[tauri::command]
fn open_settings(page: String) -> Result<(), String> {
    let uri = match page.as_str() {
        "defaultapps" => "ms-settings:defaultapps",
        "printers" => "ms-settings:printers",
        _ => return Err("page inconnue".into()),
    };
    shell_open(uri)
}

// ------------------------------------------------------------------ mises à jour (sur consentement)
//
// Aucune connexion n'a lieu sans l'accord de l'utilisateur : l'interface n'appelle `update_check`
// que s'il a accepté la vérification automatique ou s'il clique « Rechercher des mises à jour ».
// Le fichier téléchargé est vérifié avec la clé publique Ed25519 de tauri.conf.json avant d'être
// lancé (signature Tauri, indépendante de la signature Authenticode, que nous n'avons pas).

/// Mise à jour trouvée, en attente d'installation.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let b = app.updater_builder().timeout(std::time::Duration::from_secs(30));
    b.build().map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let found = updater(&app)?.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) });
    *pending.0.lock().unwrap() = found;
    Ok(info)
}

/// Télécharge, vérifie la signature et lance l'installeur (mode passif), puis redémarre.
/// Émet « update-progress » { done, total }.
#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("aucune mise à jour en attente")?;
    let mut done = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Drapeau d'annulation de l'impression en cours.
#[derive(Default)]
struct PrintState(Mutex<Arc<AtomicBool>>);

#[tauri::command]
async fn printers() -> Result<Vec<pdfreader_engine::print_win::PrinterInfo>, String> {
    // L'énumération peut être lente (imprimantes réseau) : hors du fil de l'interface.
    tauri::async_runtime::spawn_blocking(pdfreader_engine::print_win::printers).await.map_err(|e| e.to_string())
}

/// Imprime ; renvoie le nombre de pages envoyées. Émet « print-progress » { done, total }.
/// Erreurs typées : `print_forbidden`, `print_cancelled`, `print_busy`.
#[tauri::command]
async fn doc_print(doc: u32, mut options: pdfreader_engine::print_win::PrintOptions, app: AppHandle, engine: State<'_, EngineHandle>, state: State<'_, PrintState>) -> Result<usize, String> {
    // Le fichier de sortie n'est accepté que pour les tests : sinon le pilote demande lui-même.
    if std::env::var("PDFREADER_E2E").is_err() {
        options.output_file = None;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.0.lock().unwrap() = cancel.clone();
    let progress = Box::new(move |done: usize, total: usize| {
        let _ = app.emit("print-progress", serde_json::json!({ "done": done, "total": total }));
    });
    ask(&engine, |reply| Cmd::Print { doc, opts: options, cancel, progress, reply }).await
}

#[tauri::command]
fn print_cancel(state: State<'_, PrintState>) {
    state.0.lock().unwrap().store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn doc_changed_on_disk(doc: u32, engine: State<'_, EngineHandle>) -> Result<bool, String> {
    ask(&engine, |reply| Cmd::ChangedOnDisk { doc, reply }).await
}

#[tauri::command]
async fn doc_reload(doc: u32, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<DocInfo, String> {
    let mut info = ask(&engine, |reply| Cmd::Reload { doc, reply }).await?;
    info.view_state = db.view_state(&info.fingerprint);
    Ok(info)
}

#[tauri::command]
fn recent_star(id: String, starred: bool, db: State<'_, db::Db>) -> Result<(), String> {
    db.set_starred(&id, starred).map_err(|e| e.to_string())
}

#[tauri::command]
async fn doc_count_highlights(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<usize, String> {
    ask(&engine, |reply| Cmd::CountHighlights { doc, page, reply }).await
}

#[tauri::command]
async fn doc_save(doc: u32, path: Option<String>, engine: State<'_, EngineHandle>, db: State<'_, db::Db>) -> Result<SaveResult, String> {
    let as_copy = path.is_some();
    let r = ask(&engine, |reply| Cmd::Save { doc, path: path.map(PathBuf::from), reply }).await?;
    // Enregistrer sur place : même document, nouvelle empreinte. Enregistrer sous : l'original
    // garde la sienne, la copie sera ajoutée aux récents à sa prochaine ouverture.
    if !as_copy {
        let _ = db.rekey(&r.old_fingerprint, &r.fingerprint, r.bytes, None);
    }
    Ok(r)
}

#[tauri::command]
async fn doc_links(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<Vec<PageLink>, String> {
    ask(&engine, |reply| Cmd::Links { doc, page, reply }).await
}

#[tauri::command]
async fn doc_bookmarks(doc: u32, engine: State<'_, EngineHandle>) -> Result<Vec<Bookmark>, String> {
    ask(&engine, |reply| Cmd::Bookmarks { doc, reply }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn doc_search(
    doc: u32,
    from: i32,
    count: i32,
    query: String,
    match_case: bool,
    whole_word: bool,
    engine: State<'_, EngineHandle>,
) -> Result<SearchBatch, String> {
    let count = count.clamp(1, 200);
    ask(&engine, |reply| Cmd::Search { doc, from, count, query, match_case, whole_word, reply }).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewStateIn {
    page: i64,
    zoom_mode: String,
    zoom: Option<f64>,
    layout: String,
    cover: bool,
    rotation: i64,
    panel: Option<String>,
}

#[tauri::command]
fn view_state_set(fingerprint: String, state: ViewStateIn, db: State<'_, db::Db>) -> Result<(), String> {
    let zoom_mode = match state.zoom_mode.as_str() {
        m @ ("fit-page" | "fit-width") => m,
        _ => "custom",
    };
    let layout = match state.layout.as_str() {
        l @ ("single" | "double" | "continuous" | "continuous-double") => l,
        _ => "continuous",
    };
    let rotation = if [0, 90, 180, 270].contains(&state.rotation) { state.rotation } else { 0 };
    let panel = state.panel.as_deref().filter(|p| ["thumbnails", "bookmarks", "comments", "attachments", "layers"].contains(p));
    let zoom = state.zoom.map(|z| z.clamp(0.08, 64.0));
    db.set_view_state(&fingerprint, state.page, zoom_mode, zoom, layout, state.cover, rotation, panel).map_err(|e| e.to_string())
}

#[tauri::command]
async fn doc_set_bookmarks(doc: u32, items: Vec<pdfreader_engine::outline::OutlineItem>, engine: State<'_, EngineHandle>) -> Result<(), String> {
    ask(&engine, |reply| Cmd::SetBookmarks { doc, items, reply }).await
}

#[tauri::command]
async fn doc_properties(doc: u32, engine: State<'_, EngineHandle>) -> Result<pdfreader_engine::properties::DocProperties, String> {
    ask(&engine, |reply| Cmd::Properties { doc, reply }).await
}

#[tauri::command]
async fn doc_attachments(doc: u32, engine: State<'_, EngineHandle>) -> Result<Vec<pdfreader_engine::navigation::Attachment>, String> {
    ask(&engine, |reply| Cmd::Attachments { doc, reply }).await
}

/// Enregistre une pièce jointe là où l'utilisateur l'a choisi. Jamais exécutée.
#[tauri::command]
async fn attachment_save(doc: u32, index: u16, path: String, engine: State<'_, EngineHandle>) -> Result<u64, String> {
    let bytes = ask(&engine, |reply| Cmd::AttachmentBytes { doc, index, reply }).await?;
    pdfreader_engine::atomic_write(Path::new(&path), |f| {
        use std::io::Write;
        f.write_all(&bytes)?;
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

/// Pièce jointe PDF : copiée dans le dossier de données de l'application, pour être ouverte dans
/// PDFReader. Refusé pour tout autre type de fichier.
#[tauri::command]
async fn attachment_open_pdf(doc: u32, index: u16, engine: State<'_, EngineHandle>, dir: State<'_, DataDir>) -> Result<String, String> {
    let list = ask(&engine, |reply| Cmd::Attachments { doc, reply }).await?;
    let item = list.into_iter().find(|a| a.index == index).ok_or("pièce jointe introuvable")?;
    let bytes = ask(&engine, |reply| Cmd::AttachmentBytes { doc, index, reply }).await?;
    if !item.name.to_ascii_lowercase().ends_with(".pdf") || !bytes.starts_with(b"%PDF") {
        return Err("not_pdf".into());
    }
    let folder = dir.0.join("attachments");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let stem = item.name[..item.name.len() - 4].to_string();
    let mut target = folder.join(&item.name);
    let mut n = 2;
    while target.exists() && std::fs::read(&target).map(|b| b != bytes).unwrap_or(true) {
        target = folder.join(format!("{stem} ({n}).pdf"));
        n += 1;
    }
    if !target.exists() {
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(target.display().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn doc_search_snippets(
    doc: u32,
    from: i32,
    count: i32,
    query: String,
    match_case: bool,
    whole_word: bool,
    already: usize,
    engine: State<'_, EngineHandle>,
) -> Result<pdfreader_engine::navigation::SnippetBatch, String> {
    ask(&engine, |reply| Cmd::SearchSnippets { doc, from, count, query, match_case, whole_word, already, reply }).await
}

/// Préférences non exportées : propres à ce poste.
const PREFS_NOT_EXPORTED: [&str; 1] = ["updatesLastCheck"];
const PREFS_FILE_MAX: u64 = 1024 * 1024;

fn valid_pref_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Exporte les préférences dans un fichier JSON (sans les signatures, qui restent sur ce poste).
#[tauri::command]
fn pref_export(path: String, db: State<'_, db::Db>) -> Result<usize, String> {
    if !path.to_ascii_lowercase().ends_with(".json") {
        return Err("fichier .json attendu".into());
    }
    let mut prefs = db.preferences().map_err(|e| e.to_string())?;
    prefs.retain(|k, _| !PREFS_NOT_EXPORTED.contains(&k.as_str()));
    let n = prefs.len();
    let out = serde_json::json!({ "app": "PDFReader", "kind": "preferences", "version": 1, "preferences": prefs });
    std::fs::write(&path, serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(n)
}

/// Importe un fichier exporté par `pref_export` : les clés présentes remplacent les réglages
/// actuels. Fichier refusé s'il n'en vient pas, ou s'il est démesuré.
#[tauri::command]
fn pref_import(path: String, db: State<'_, db::Db>) -> Result<usize, String> {
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > PREFS_FILE_MAX {
        return Err("invalid_file".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|_| "invalid_file".to_string())?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "invalid_file".to_string())?;
    if v.get("app").and_then(|a| a.as_str()) != Some("PDFReader") || v.get("kind").and_then(|a| a.as_str()) != Some("preferences") {
        return Err("invalid_file".into());
    }
    let prefs = v.get("preferences").and_then(|p| p.as_object()).ok_or("invalid_file")?;
    let mut n = 0;
    for (k, val) in prefs {
        if !valid_pref_key(k) || PREFS_NOT_EXPORTED.contains(&k.as_str()) || val.to_string().len() > 64 * 1024 {
            continue;
        }
        db.set_preference(k, val).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

#[tauri::command]
fn pref_all(db: State<'_, db::Db>) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    db.preferences().map_err(|e| e.to_string())
}

#[tauri::command]
fn pref_set(key: String, value: serde_json::Value, db: State<'_, db::Db>) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("clé invalide".into());
    }
    db.set_preference(&key, &value).map_err(|e| e.to_string())
}

/// Ouvre une adresse web dans le navigateur par défaut, après confirmation dans l'interface.
/// Seuls http, https et mailto sont acceptés : jamais de fichier local ni de programme.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) || url.len() > 4096 {
        return Err("adresse refusée".into());
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("adresse refusée".into());
    }
    shell_open(url.trim())
}

#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, w};
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL) };
    // ShellExecuteW renvoie une valeur > 32 en cas de succès.
    if r.0 as isize > 32 { Ok(()) } else { Err(format!("ouverture impossible ({})", r.0 as isize)) }
}

#[cfg(not(windows))]
fn shell_open(url: &str) -> Result<(), String> {
    std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn doc_close(doc: u32, engine: State<'_, EngineHandle>) {
    engine.send(Cmd::Close { doc });
}

#[tauri::command]
fn recent_list(db: State<'_, db::Db>) -> Result<Vec<db::RecentFile>, String> {
    db.list(50).map_err(|e| e.to_string())
}

#[tauri::command]
fn recent_remove(id: String, db: State<'_, db::Db>) -> Result<(), String> {
    db.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn author(db: State<'_, db::Db>) -> String {
    comment_author(&db)
}

/// Tests de bout en bout : actifs seulement avec la variable PDFREADER_E2E (jamais en usage normal).
#[tauri::command]
fn e2e_enabled() -> bool {
    std::env::var("PDFREADER_E2E").is_ok()
}

#[tauri::command]
fn e2e_pause() -> u32 {
    if std::env::var("PDFREADER_E2E").is_err() {
        return 0;
    }
    std::env::var("PDFREADER_E2E_PAUSE").ok().and_then(|v| v.parse().ok()).unwrap_or(0).min(10_000)
}

/// Étape demandée au scénario (« crash » : préparer une copie de récupération puis quitter net).
#[tauri::command]
fn e2e_stage() -> String {
    if std::env::var("PDFREADER_E2E").is_err() {
        return String::new();
    }
    std::env::var("PDFREADER_E2E_STAGE").unwrap_or_default()
}

#[tauri::command]
fn e2e_report(report: String, app: AppHandle) {
    if let Ok(path) = std::env::var("PDFREADER_E2E") {
        let _ = std::fs::write(path, report);
        app.exit(0);
    }
}

/// Dossier de données (base locale, copies de récupération). Les tests de bout en bout
/// (PDFREADER_E2E) utilisent toujours un dossier à part, à côté de leur rapport : ils ne touchent
/// jamais aux récents, aux préférences ni à la signature de l'utilisateur. PDFREADER_DATA_DIR
/// permet de le choisir (captures d'écran, version portable).
fn data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(d) = std::env::var("PDFREADER_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Ok(report) = std::env::var("PDFREADER_E2E") {
        return Path::new(&report).parent().unwrap_or(Path::new(".")).join("e2e-data");
    }
    app.path().app_data_dir().expect("dossier de données")
}

// ------------------------------------------------------------------ PDFium et protocole

fn pdfium_dir(app: &AppHandle) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r);
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        candidates.push(exe_dir);
    }
    if cfg!(debug_assertions) || std::env::var("PDFREADER_DEV").is_ok() {
        if let Some(root) = repo_root() {
            candidates.push(root.join("vendor").join("pdfium-win-x64").join("bin"));
        }
    }
    let first = candidates.first().cloned().unwrap_or_else(|| PathBuf::from("."));
    candidates.into_iter().find(|d| d.join("pdfium.dll").exists()).unwrap_or(first)
}

/// Racine du dépôt, pour le développement. En version publiée, déduite de l'emplacement de
/// l'exécutable (target/release/PDFReader.exe) : aucun chemin de la machine de compilation
/// n'est inscrit dans le binaire.
fn repo_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(".."))
    }
    #[cfg(not(debug_assertions))]
    {
        let exe = std::env::current_exe().ok()?;
        exe.parent()?.parent()?.parent().map(Path::to_path_buf)
    }
}

/// `pdfpage://localhost/tile/<doc>/<gen>/<ver>/<page>/<scale>/<x>/<y>` (WebP) et `/thumb/<id>` (PNG).
fn handle_protocol(app: &AppHandle, request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = request.uri().path().trim_start_matches('/').to_string();
    let parts: Vec<&str> = path.split('/').collect();
    let bad = |responder: tauri::UriSchemeResponder| {
        responder.respond(Response::builder().status(400).body(b"requete invalide".to_vec()).unwrap());
    };
    match parts.first().copied() {
        Some("tile") if parts.len() == 8 => {
            let n = |i: usize| parts[i].parse::<f32>().ok();
            let (Some(doc), Some(page), Some(scale), Some(x), Some(y)) = (n(1), n(4), n(5), n(6), n(7)) else {
                return bad(responder);
            };
            if !(0.01..=64.0).contains(&scale) {
                return bad(responder);
            }
            let engine = app.state::<EngineHandle>();
            engine.send(Cmd::Tile { doc: doc as u32, page: page as i32, scale, x: x as i32, y: y as i32, size: 512, responder });
        }
        Some("thumb") if parts.len() == 2 => {
            let db = app.state::<db::Db>();
            match db.thumbnail(parts[1]) {
                Some(png) => responder.respond(
                    Response::builder().status(200).header("Content-Type", "image/png").header("Cache-Control", "no-cache").body(png).unwrap(),
                ),
                None => responder.respond(Response::builder().status(404).body(Vec::new()).unwrap()),
            }
        }
        _ => bad(responder),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Deuxième lancement (double-clic sur un autre PDF) : on l'ouvre dans la fenêtre existante.
            let files = pdf_args(args, Path::new(&cwd));
            let _ = app.emit("open-files", files);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(engine::start(pdfium_dir(&handle)));
            let dir = data_dir(&handle);
            let db = db::Db::open(&dir).expect("base locale");
            // Ménage : fichiers de récupération que plus aucune ligne ne référence.
            if let (Ok(known), Ok(files)) = (db.snapshots(), std::fs::read_dir(dir.join("recovery"))) {
                for f in files.flatten() {
                    let p = f.path().display().to_string();
                    if !known.iter().any(|k| k.2 == p) {
                        let _ = std::fs::remove_file(f.path());
                    }
                }
            }
            app.manage(db);
            app.manage(DataDir(dir));
            app.manage(PrintState::default());
            app.manage(PendingUpdate::default());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("pdfpage", |ctx, request, responder| {
            handle_protocol(ctx.app_handle(), request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_files,
            doc_open,
            doc_text_layer,
            doc_annotations,
            annot_add_markup,
            annot_add_note,
            annot_add_ink,
            annot_add_shape,
            annot_add_stamp,
            annot_reply,
            annot_set_status,
            annot_update,
            annot_delete,
            recent_star,
            printers,
            printer_sheet,
            open_settings,
            legal_document,
            update_check,
            update_install,
            app_info,
            pref_reset,
            recovery_snapshot,
            recovery_clear,
            recovery_list,
            recovery_restore,
            recovery_discard,
            e2e_stage,
            doc_print,
            print_cancel,
            doc_changed_on_disk,
            doc_reload,
            doc_fields,
            field_set,
            fill_add_text,
            fill_add_mark,
            fill_add_textbox,
            fill_add_signature,
            signature_get,
            signature_set,
            signature_delete,
            doc_count_highlights,
            doc_save,
            doc_links,
            doc_bookmarks,
            doc_properties,
            doc_set_bookmarks,
            doc_attachments,
            attachment_save,
            attachment_open_pdf,
            doc_search_snippets,
            pref_export,
            pref_import,
            doc_search,
            view_state_set,
            pref_all,
            pref_set,
            open_url,
            doc_close,
            recent_list,
            recent_remove,
            author,
            e2e_enabled,
            e2e_pause,
            e2e_report
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de PDFReader");
}

// PDFReader : application de bureau. Coquille Tauri : commandes, protocole des tuiles, base locale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod engine;

use std::path::{Path, PathBuf};

use engine::{Cmd, DocInfo, EngineHandle, SaveResult};
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
    engine.send(Cmd::Open { path: PathBuf::from(&path), password, reply: tx });
    let mut r = rx.await.map_err(|_| OpenError::Other("moteur indisponible".into()))??;
    let _ = db.touch(&r.info.fingerprint, &r.info.path, &r.info.name, r.size, r.info.page_count, &r.thumbnail);
    r.info.view_state = db.view_state(&r.info.fingerprint);
    Ok(r.info)
}

#[tauri::command]
async fn doc_text_layer(doc: u32, page: i32, engine: State<'_, EngineHandle>) -> Result<Vec<Vec<TextWord>>, String> {
    ask(&engine, |reply| Cmd::TextLayer { doc, page, reply }).await
}

#[tauri::command]
async fn annot_add_highlight(doc: u32, page: i32, rects: Vec<[f32; 4]>, color: [u8; 3], engine: State<'_, EngineHandle>) -> Result<usize, String> {
    ask(&engine, |reply| Cmd::Highlight { doc, page, rects, color, author: author_name(), reply }).await
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
fn author() -> String {
    author_name()
}

/// Tests de bout en bout : actifs seulement avec la variable PDFREADER_E2E (jamais en usage normal).
#[tauri::command]
fn e2e_enabled() -> bool {
    std::env::var("PDFREADER_E2E").is_ok()
}

#[tauri::command]
fn e2e_report(report: String, app: AppHandle) {
    if let Ok(path) = std::env::var("PDFREADER_E2E") {
        let _ = std::fs::write(path, report);
        app.exit(0);
    }
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
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vendor/pdfium-win-x64/bin"));
    }
    candidates
        .into_iter()
        .find(|d| d.join("pdfium.dll").exists())
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vendor/pdfium-win-x64/bin"))
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
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(engine::start(pdfium_dir(&handle)));
            let dir = app.path().app_data_dir().expect("dossier de données");
            app.manage(db::Db::open(&dir).expect("base locale"));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("pdfpage", |ctx, request, responder| {
            handle_protocol(ctx.app_handle(), request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            get_launch_files,
            doc_open,
            doc_text_layer,
            annot_add_highlight,
            doc_count_highlights,
            doc_save,
            doc_links,
            doc_bookmarks,
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
            e2e_report
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de PDFReader");
}

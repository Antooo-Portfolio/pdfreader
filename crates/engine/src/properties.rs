//! M3 : propriétés du document (S15) — métadonnées, version, sécurité, structure, polices.

use std::ffi::c_char;
use std::io::Read;
use std::path::Path;

use pdfium_render::prelude::*;

/// Une police utilisée par le document.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FontInfo {
    /// Nom de base, sans le préfixe de sous-ensemble (« ABCDEF+ »).
    pub name: String,
    pub embedded: bool,
    /// Seuls les caractères utilisés sont embarqués.
    pub subset: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocProperties {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
    /// Application qui a créé le document d'origine.
    pub creator: String,
    /// Outil qui a produit le PDF.
    pub producer: String,
    /// Dates PDF brutes (« D:20261109183000+01'00' »).
    pub created: String,
    pub modified: String,
    /// « 1.7 », « 2.0 »…
    pub version: Option<String>,
    pub page_count: i32,
    /// Taille de la première page, en points.
    pub page_size: Option<[f32; 2]>,
    pub file_size: u64,
    /// Balisé (structure logique, utile aux lecteurs d'écran).
    pub tagged: bool,
    /// Optimisé pour l'affichage web rapide.
    pub linearized: bool,
    /// Révision du chiffrement (absent : non chiffré).
    pub security_revision: Option<i32>,
    pub fonts: Vec<FontInfo>,
    /// Pages parcourues pour les polices (toutes, sauf très gros documents).
    pub fonts_pages: i32,
}

/// Pages parcourues au plus pour lister les polices (le moteur ne doit pas rester bloqué).
pub const MAX_FONT_PAGES: i32 = 500;
const MAX_FONTS: usize = 2000;
/// Profondeur des objets de formulaire imbriqués (contre les PDF piégés).
const MAX_FORM_DEPTH: usize = 12;
// Types d'objet de page (fpdf_edit.h).
const OBJ_TEXT: i32 = 1;
const OBJ_FORM: i32 = 5;

fn meta(doc: &PdfDocument, tag: PdfDocumentMetadataTagType) -> String {
    doc.metadata()
        .get(tag)
        .map(|t| t.value().replace(['\0', '\r', '\n'], " ").trim().to_string())
        .unwrap_or_default()
}

fn font_info(font: FPDF_FONT) -> Option<FontInfo> {
    let b = raw_bindings();
    let len = unsafe { b.FPDFFont_GetBaseFontName(font, std::ptr::null_mut(), 0) };
    if len == 0 || len > 1024 {
        return None;
    }
    let mut buf = vec![0u8; len];
    unsafe { b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr() as *mut c_char, len) };
    let raw = String::from_utf8_lossy(&buf).trim_end_matches('\0').to_string();
    let (subset, name) = match raw.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_uppercase()) => (true, rest.to_string()),
        _ => (false, raw),
    };
    if name.is_empty() {
        return None;
    }
    let embedded = unsafe { b.FPDFFont_GetIsEmbedded(font) } == 1;
    Some(FontInfo { name, embedded, subset })
}

fn collect(obj: FPDF_PAGEOBJECT, depth: usize, out: &mut Vec<FontInfo>) {
    let b = raw_bindings();
    match unsafe { b.FPDFPageObj_GetType(obj) } as i32 {
        OBJ_TEXT => {
            let font = unsafe { b.FPDFTextObj_GetFont(obj) };
            if font.is_null() {
                return;
            }
            if let Some(f) = font_info(font) {
                if !out.iter().any(|x| x.name == f.name && x.embedded == f.embedded) && out.len() < MAX_FONTS {
                    out.push(f);
                }
            }
        }
        OBJ_FORM if depth < MAX_FORM_DEPTH => {
            let n = unsafe { b.FPDFFormObj_CountObjects(obj) };
            for i in 0..n.max(0) {
                let child = unsafe { b.FPDFFormObj_GetObject(obj, i as _) };
                if !child.is_null() {
                    collect(child, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

/// Polices des `max_pages` premières pages.
pub fn fonts(doc: &PdfDocument, max_pages: i32) -> (Vec<FontInfo>, i32) {
    let b = raw_bindings();
    let pages = doc.pages().len().min(max_pages);
    let mut out = Vec::new();
    for i in 0..pages {
        let Ok(page) = doc.pages().get(i) else { continue };
        let h = page.raw_handle();
        let n = unsafe { b.FPDFPage_CountObjects(h) };
        for j in 0..n.max(0) {
            let obj = unsafe { b.FPDFPage_GetObject(h, j) };
            if !obj.is_null() {
                collect(obj, 0, &mut out);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (out, pages)
}

/// Le fichier commence-t-il par un dictionnaire de linéarisation ?
fn is_linearized(path: &Path) -> bool {
    let mut head = vec![0u8; 2048];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    head[..n].windows(11).any(|w| w == b"/Linearized")
}

pub fn properties(doc: &PdfDocument, path: &Path) -> DocProperties {
    let b = raw_bindings();
    let h = doc.raw_handle();
    let mut v: std::os::raw::c_int = 0;
    let version = (unsafe { b.FPDF_GetFileVersion(h, &mut v) } != 0 && v > 0).then(|| format!("{}.{}", v / 10, v % 10));
    let rev = unsafe { b.FPDF_GetSecurityHandlerRevision(h) };
    let (fonts, fonts_pages) = fonts(doc, MAX_FONT_PAGES);
    DocProperties {
        title: meta(doc, PdfDocumentMetadataTagType::Title),
        author: meta(doc, PdfDocumentMetadataTagType::Author),
        subject: meta(doc, PdfDocumentMetadataTagType::Subject),
        keywords: meta(doc, PdfDocumentMetadataTagType::Keywords),
        creator: meta(doc, PdfDocumentMetadataTagType::Creator),
        producer: meta(doc, PdfDocumentMetadataTagType::Producer),
        created: meta(doc, PdfDocumentMetadataTagType::CreationDate),
        modified: meta(doc, PdfDocumentMetadataTagType::ModificationDate),
        version,
        page_count: doc.pages().len(),
        page_size: doc.pages().page_size(0).ok().map(|r| [r.width().value, r.height().value]),
        file_size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        tagged: unsafe { b.FPDFCatalog_IsTagged(h) } != 0,
        linearized: is_linearized(path),
        security_revision: (rev > 0).then_some(rev),
        fonts,
        fonts_pages,
    }
}

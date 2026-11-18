//! Phase 2, « Ajouter du texte » : du vrai texte dans le contenu de la page (sélectionnable,
//! cherchable, imprimé), pas un commentaire posé dessus. Chaque bloc est fait d'objets texte (un
//! par ligne) marqués « PDFReaderText » avec un identifiant, le texte complet et le style, pour
//! pouvoir le retrouver, le modifier, le déplacer ou le supprimer ensuite.
//!
//! Polices : les 14 polices standard (Helvetica, Times, Courier) suffisent au français et aux
//! langues d'Europe de l'Ouest (Windows-1252) et n'alourdissent pas le fichier ; au-delà (grec,
//! cyrillique, Europe de l'Est…), la police TrueType équivalente de Windows est intégrée.

use std::collections::HashMap;
use std::ffi::c_ulong;

use anyhow::{Result, bail};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

const MARK: &str = "PDFReaderText";
/// FPDF_PAGEOBJ_TEXT
const TEXT_OBJECT: i32 = 1;
/// FPDF_FONT_TRUETYPE
const TRUETYPE: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    Sans,
    Serif,
    Mono,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub family: Family,
    pub bold: bool,
    pub italic: bool,
    /// Taille en points.
    pub size: f32,
    pub color: [u8; 3],
}

/// Bloc de texte ajouté par PDFReader. Coordonnées en points, depuis le HAUT de la page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub id: String,
    pub page: i32,
    /// Coin haut gauche du bloc tel qu'il a été posé.
    pub x: f32,
    pub y: f32,
    /// Rectangle occupé par le texte (gauche, haut, largeur, hauteur).
    pub rect: [f32; 4],
    pub text: String,
    pub style: TextStyle,
}

/// Polices TrueType déjà intégrées au document (une seule fois chacune).
pub type FontCache = HashMap<String, usize>;

fn standard_font(s: &TextStyle) -> &'static str {
    match (s.family, s.bold, s.italic) {
        (Family::Sans, false, false) => "Helvetica",
        (Family::Sans, true, false) => "Helvetica-Bold",
        (Family::Sans, false, true) => "Helvetica-Oblique",
        (Family::Sans, true, true) => "Helvetica-BoldOblique",
        (Family::Serif, false, false) => "Times-Roman",
        (Family::Serif, true, false) => "Times-Bold",
        (Family::Serif, false, true) => "Times-Italic",
        (Family::Serif, true, true) => "Times-BoldItalic",
        (Family::Mono, false, false) => "Courier",
        (Family::Mono, true, false) => "Courier-Bold",
        (Family::Mono, false, true) => "Courier-Oblique",
        (Family::Mono, true, true) => "Courier-BoldOblique",
    }
}

fn truetype_file(s: &TextStyle) -> &'static str {
    match (s.family, s.bold, s.italic) {
        (Family::Sans, false, false) => "arial.ttf",
        (Family::Sans, true, false) => "arialbd.ttf",
        (Family::Sans, false, true) => "ariali.ttf",
        (Family::Sans, true, true) => "arialbi.ttf",
        (Family::Serif, false, false) => "times.ttf",
        (Family::Serif, true, false) => "timesbd.ttf",
        (Family::Serif, false, true) => "timesi.ttf",
        (Family::Serif, true, true) => "timesbi.ttf",
        (Family::Mono, false, false) => "cour.ttf",
        (Family::Mono, true, false) => "courbd.ttf",
        (Family::Mono, false, true) => "couri.ttf",
        (Family::Mono, true, true) => "courbi.ttf",
    }
}

/// Caractères couverts par les polices standard (Windows-1252, sans les caractères de contrôle).
fn standard_encodable(c: char) -> bool {
    matches!(c as u32, 0x20..=0x7E | 0xA0..=0xFF) || "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".contains(c)
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    let bytes: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect();
    String::from_utf8(bytes?).ok()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Nom et paramètre texte d'une marque.
unsafe fn mark_name(b: &dyn PdfiumLibraryBindings, m: FPDF_PAGEOBJECTMARK) -> String {
    let mut len: c_ulong = 0;
    unsafe { b.FPDFPageObjMark_GetName(m, std::ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize / 2 + 1];
    unsafe { b.FPDFPageObjMark_GetName(m, buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong, &mut len) };
    from_wide(&buf)
}

unsafe fn mark_param(b: &dyn PdfiumLibraryBindings, m: FPDF_PAGEOBJECTMARK, key: &str) -> Option<String> {
    let mut len: c_ulong = 0;
    if unsafe { b.FPDFPageObjMark_GetParamStringValue(m, key, std::ptr::null_mut(), 0, &mut len) } == 0 || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize / 2 + 1];
    unsafe { b.FPDFPageObjMark_GetParamStringValue(m, key, buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong, &mut len) };
    Some(from_wide(&buf))
}

/// Marque PDFReaderText d'un objet, s'il en a une.
unsafe fn our_mark(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> Option<FPDF_PAGEOBJECTMARK> {
    let n = unsafe { b.FPDFPageObj_CountMarks(obj) };
    (0..n).map(|i| unsafe { b.FPDFPageObj_GetMark(obj, i as c_ulong) }).find(|m| !m.is_null() && unsafe { mark_name(b, *m) } == MARK)
}

/// Blocs de texte ajoutés par PDFReader sur la page.
pub fn list(page: &PdfPage, index: i32) -> Vec<TextBlock> {
    let b = raw_bindings();
    let h = page.raw_handle();
    let page_h = page.height().value;
    let mut blocks: Vec<TextBlock> = Vec::new();
    let mut bounds: HashMap<String, (f32, f32, f32, f32)> = HashMap::new();
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    for i in 0..count {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT {
            continue;
        }
        let Some(m) = (unsafe { our_mark(b, obj) }) else { continue };
        let Some(id) = (unsafe { mark_param(b, m, "id") }) else { continue };
        let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
        unsafe { b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) };
        let e = bounds.entry(id.clone()).or_insert((l, bt, r, t));
        *e = (e.0.min(l), e.1.min(bt), e.2.max(r), e.3.max(t));
        // La première ligne porte le texte complet, la position et le style.
        if let (Some(text), Some(style), Some(pos)) = unsafe { (mark_param(b, m, "t").and_then(|s| unhex(&s)), mark_param(b, m, "s").and_then(|s| unhex(&s)), mark_param(b, m, "p")) } {
            let Ok(style) = serde_json::from_str::<TextStyle>(&style) else { continue };
            let mut it = pos.split(' ').filter_map(|v| v.parse::<f32>().ok());
            let (Some(x), Some(y)) = (it.next(), it.next()) else { continue };
            blocks.push(TextBlock { id, page: index, x, y, rect: [0.0; 4], text, style });
        }
    }
    for blk in &mut blocks {
        if let Some((l, bt, r, t)) = bounds.get(&blk.id) {
            blk.rect = [*l, page_h - t, r - l, t - bt];
        }
    }
    blocks.sort_by(|a, b| a.rect[1].total_cmp(&b.rect[1]).then(a.rect[0].total_cmp(&b.rect[0])));
    blocks
}

fn new_id() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("t{n:x}")
}

/// Ajoute (ou remplace, si `id` est donné) un bloc de texte, coin haut gauche en (`x`, `y`) depuis
/// le haut de la page. Texte vide : le bloc est supprimé. Renvoie l'identifiant du bloc.
#[allow(clippy::too_many_arguments)]
pub fn set(doc: &PdfDocument, page: &mut PdfPage, fonts: &mut FontCache, id: Option<&str>, x: f32, y: f32, text: &str, style: &TextStyle) -> Result<Option<String>> {
    let text = text.replace('\t', "    ").replace("\r\n", "\n");
    if let Some(old) = id {
        remove_objects(page, old)?;
    }
    if text.trim().is_empty() {
        regenerate(page)?;
        return Ok(None);
    }
    let style = TextStyle { size: style.size.clamp(4.0, 144.0), ..*style };
    let b = raw_bindings();
    let id = id.map(str::to_string).unwrap_or_else(new_id);
    let page_h = page.height().value;
    let top = page_h - y;
    let standard = text.chars().all(|c| c == '\n' || standard_encodable(c));
    let font = if standard {
        None
    } else {
        let file = truetype_file(&style);
        if let Some(f) = fonts.get(file) {
            Some(*f as FPDF_FONT)
        } else {
            let dir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
            let data = std::fs::read(std::path::Path::new(&dir).join("Fonts").join(file)).map_err(|_| anyhow::anyhow!("font_missing: {file}"))?;
            let f = unsafe { b.FPDFText_LoadFont(doc.raw_handle(), data.as_ptr(), data.len() as u32, TRUETYPE, 1) };
            if f.is_null() {
                bail!("police refusée par PDFium : {file}");
            }
            fonts.insert(file.to_string(), f as usize);
            Some(f)
        }
    };
    let style_json = serde_json::to_string(&style)?;
    for (i, line) in text.split('\n').enumerate() {
        if line.trim_end().is_empty() {
            continue;
        }
        let obj = unsafe {
            match font {
                None => b.FPDFPageObj_NewTextObj(doc.raw_handle(), standard_font(&style), style.size),
                Some(f) => b.FPDFPageObj_CreateTextObj(doc.raw_handle(), f, style.size),
            }
        };
        if obj.is_null() {
            bail!("objet texte refusé par PDFium");
        }
        let w = wide(line.trim_end());
        unsafe {
            b.FPDFText_SetText(obj, w.as_ptr() as _);
            let [r, g, bl] = style.color;
            b.FPDFPageObj_SetFillColor(obj, r as u32, g as u32, bl as u32, 255);
            // Ligne de base : hauteur de capitale (≈ 0,8 em) sous le haut, interligne 1,2.
            b.FPDFPageObj_Transform(obj, 1.0, 0.0, 0.0, 1.0, x as f64, (top - style.size * 0.8 - style.size * 1.2 * i as f32) as f64);
            let m = b.FPDFPageObj_AddMark(obj, MARK);
            b.FPDFPageObjMark_SetStringParam(doc.raw_handle(), obj, m, "id", &id);
            b.FPDFPage_InsertObject(page.raw_handle(), obj);
        }
    }
    // Texte, position et style sur le premier objet du bloc (le premier ajouté).
    let first = first_object(page, &id).ok_or_else(|| anyhow::anyhow!("bloc introuvable après l'ajout"))?;
    unsafe {
        let m = our_mark(b, first).ok_or_else(|| anyhow::anyhow!("marque introuvable"))?;
        b.FPDFPageObjMark_SetStringParam(doc.raw_handle(), first, m, "t", &hex(&text));
        b.FPDFPageObjMark_SetStringParam(doc.raw_handle(), first, m, "s", &hex(&style_json));
        b.FPDFPageObjMark_SetStringParam(doc.raw_handle(), first, m, "p", &format!("{x} {y}"));
    }
    regenerate(page)?;
    Ok(Some(id))
}

fn first_object(page: &PdfPage, id: &str) -> Option<FPDF_PAGEOBJECT> {
    let b = raw_bindings();
    let h = page.raw_handle();
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    (0..count).map(|i| unsafe { b.FPDFPage_GetObject(h, i) }).find(|o| !o.is_null() && unsafe { our_mark(b, *o).and_then(|m| mark_param(b, m, "id")) }.as_deref() == Some(id))
}

/// Retire les objets d'un bloc (sans régénérer le contenu).
fn remove_objects(page: &PdfPage, id: &str) -> Result<()> {
    let b = raw_bindings();
    let h = page.raw_handle();
    let mut found = false;
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    for i in (0..count).rev() {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT {
            continue;
        }
        if unsafe { our_mark(b, obj).and_then(|m| mark_param(b, m, "id")) }.as_deref() == Some(id) {
            unsafe {
                if b.FPDFPage_RemoveObject(h, obj) != 0 {
                    b.FPDFPageObj_Destroy(obj);
                }
            }
            found = true;
        }
    }
    if !found {
        bail!("bloc de texte introuvable");
    }
    Ok(())
}

/// Supprime un bloc de texte.
pub fn delete(page: &mut PdfPage, id: &str) -> Result<()> {
    remove_objects(page, id)?;
    regenerate(page)
}

fn regenerate(page: &PdfPage) -> Result<()> {
    if unsafe { raw_bindings().FPDFPage_GenerateContent(page.raw_handle()) } == 0 {
        bail!("contenu de la page non régénéré");
    }
    Ok(())
}

//! Phase 2, « Filigrane, en-têtes et pieds de page » : texte répété sur les pages choisies —
//! filigrane (diagonal ou horizontal, transparent), en-tête et pied de page à gauche, au centre et
//! à droite, avec des champs remplacés page par page ({page}, {pages}, {date}, {fichier}).
//!
//! Tout est placé par rapport à la page telle qu'elle s'affiche (rotation /Rotate comprise). Les
//! objets ajoutés portent la marque « PDFReaderStamp » et le réglage complet : appliquer de
//! nouveau remplace l'ancien jeu, et on peut tout retirer.

use std::ffi::c_ulong;

use anyhow::{Result, bail};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::pagetext::{Family, FontCache, TextStyle};

const MARK: &str = "PDFReaderStamp";
const TEXT_OBJECT: i32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watermark {
    pub text: String,
    pub size: f32,
    pub color: [u8; 3],
    /// Opacité, de 0,05 à 1.
    pub opacity: f32,
    pub diagonal: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Band {
    pub left: String,
    pub center: String,
    pub right: String,
}

impl Band {
    fn is_empty(&self) -> bool {
        self.left.trim().is_empty() && self.center.trim().is_empty() && self.right.trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampConfig {
    pub watermark: Option<Watermark>,
    pub header: Band,
    pub footer: Band,
    /// Taille du texte des en-têtes et pieds de page.
    pub size: f32,
    pub color: [u8; 3],
    /// Distance au bord de la page (points).
    pub margin: f32,
    /// Pages concernées (index à partir de 0) ; vide : toutes.
    pub pages: Vec<i32>,
    /// Numéro donné à la première page (numérotation qui ne commence pas à 1).
    pub first_number: i32,
}

/// Valeurs des champs pour une page.
pub struct Fields<'a> {
    pub page: i32,
    pub pages: i32,
    pub date: &'a str,
    pub file: &'a str,
}

pub fn fill(template: &str, f: &Fields) -> String {
    template.replace("{page}", &f.page.to_string()).replace("{pages}", &f.pages.to_string()).replace("{date}", f.date).replace("{fichier}", f.file).replace("{file}", f.file)
}

fn utf16(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

unsafe fn mark_named(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT, name: &str) -> Option<FPDF_PAGEOBJECTMARK> {
    let n = unsafe { b.FPDFPageObj_CountMarks(obj) };
    for i in 0..n {
        let m = unsafe { b.FPDFPageObj_GetMark(obj, i as c_ulong) };
        if m.is_null() {
            continue;
        }
        let mut len: c_ulong = 0;
        unsafe { b.FPDFPageObjMark_GetName(m, std::ptr::null_mut(), 0, &mut len) };
        let mut buf = vec![0u16; len as usize / 2 + 1];
        unsafe { b.FPDFPageObjMark_GetName(m, buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong, &mut len) };
        if utf16(&buf) == name {
            return Some(m);
        }
    }
    None
}

/// Retire les objets ajoutés par une application précédente ; renvoie leur nombre.
fn remove_page(page: &PdfPage) -> usize {
    let b = raw_bindings();
    let h = page.raw_handle();
    let mut n = 0;
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    for i in (0..count).rev() {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT {
            continue;
        }
        if unsafe { mark_named(b, obj, MARK) }.is_some() && unsafe { b.FPDFPage_RemoveObject(h, obj) } != 0 {
            unsafe { b.FPDFPageObj_Destroy(obj) };
            n += 1;
        }
    }
    n
}

/// Réglage déjà appliqué au document (lu sur le premier objet marqué trouvé), pour reprendre la
/// boîte là où on l'avait laissée.
pub fn current(doc: &PdfDocument) -> Option<StampConfig> {
    let b = raw_bindings();
    for page in doc.pages().iter() {
        let h = page.raw_handle();
        let count = unsafe { b.FPDFPage_CountObjects(h) };
        for i in 0..count {
            let obj = unsafe { b.FPDFPage_GetObject(h, i) };
            if obj.is_null() {
                continue;
            }
            let Some(m) = (unsafe { mark_named(b, obj, MARK) }) else { continue };
            let mut len: c_ulong = 0;
            if unsafe { b.FPDFPageObjMark_GetParamStringValue(m, "c", std::ptr::null_mut(), 0, &mut len) } == 0 || len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize / 2 + 1];
            unsafe { b.FPDFPageObjMark_GetParamStringValue(m, "c", buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong, &mut len) };
            if let Some(json) = crate::pagetext::unhex(&utf16(&buf))
                && let Ok(c) = serde_json::from_str(&json)
            {
                return Some(c);
            }
        }
    }
    None
}

/// Place un texte : `anchor` (0 gauche, 0,5 centre, 1 droite) au point affiché (xd, yd = ligne de
/// base), avec une rotation supplémentaire `extra` (degrés) autour de ce point.
#[allow(clippy::too_many_arguments)]
fn place(doc: &PdfDocument, page: &PdfPage, fonts: &mut FontCache, text: &str, style: &TextStyle, alpha: u8, frame: &crate::Frame, xd: f32, yd: f32, anchor: f32, extra: f32, config_json: Option<&str>) -> Result<()> {
    let b = raw_bindings();
    let obj = crate::pagetext::new_text_object(doc, fonts, text, style)?;
    let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
    unsafe { b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) };
    let width = r - l;
    let (x, y) = frame.to_content(xd, frame.height() - yd);
    let a = (frame.angle() + extra).to_radians();
    let (cos, sin) = (a.cos() as f64, a.sin() as f64);
    // Décalage le long de la ligne de base pour l'alignement, puis rotation et placement.
    let shift = -(width * anchor) as f64;
    unsafe {
        b.FPDFPageObj_Transform(obj, 1.0, 0.0, 0.0, 1.0, shift, 0.0);
        b.FPDFPageObj_Transform(obj, cos, sin, -sin, cos, x as f64, y as f64);
        let [cr, cg, cb] = style.color;
        b.FPDFPageObj_SetFillColor(obj, cr as u32, cg as u32, cb as u32, alpha as u32);
        let m = b.FPDFPageObj_AddMark(obj, MARK);
        if let Some(c) = config_json {
            b.FPDFPageObjMark_SetStringParam(doc.raw_handle(), obj, m, "c", c);
        }
        b.FPDFPage_InsertObject(page.raw_handle(), obj);
    }
    Ok(())
}

/// Applique le réglage (en remplaçant l'éventuel jeu précédent) ; renvoie le nombre de pages
/// touchées. `file` et `date` remplissent {fichier} et {date}.
pub fn apply(doc: &PdfDocument, fonts: &mut FontCache, config: &StampConfig, file: &str, date: &str) -> Result<usize> {
    let total = doc.pages().len();
    let wanted: Vec<i32> = if config.pages.is_empty() { (0..total).collect() } else { config.pages.iter().copied().filter(|p| (0..total).contains(p)).collect() };
    if config.watermark.as_ref().is_none_or(|w| w.text.trim().is_empty()) && config.header.is_empty() && config.footer.is_empty() {
        bail!("nothing_to_apply");
    }
    let b = raw_bindings();
    // Le réglage complet est gardé (en hexadécimal) sur le premier objet ajouté.
    let json = crate::pagetext::hex(&serde_json::to_string(config)?);
    let mut first = true;
    let size = config.size.clamp(4.0, 72.0);
    let margin = config.margin.clamp(0.0, 200.0);
    let band_style = TextStyle { family: Family::Sans, bold: false, italic: false, size, color: config.color };
    for p in 0..total {
        let page = doc.pages().get(p)?;
        remove_page(&page);
        if wanted.contains(&p) {
            let frame = crate::Frame::of(&page);
            let (dw, dh) = (frame.width(), frame.height());
            let f = Fields { page: config.first_number + wanted.iter().position(|x| *x == p).unwrap_or(0) as i32, pages: config.first_number - 1 + wanted.len() as i32, date, file };
            let tag = |first: &mut bool| -> Option<String> { if std::mem::take(first) { Some(json.clone()) } else { None } };
            if let Some(w) = &config.watermark
                && !w.text.trim().is_empty()
            {
                let st = TextStyle { family: Family::Sans, bold: true, italic: false, size: w.size.clamp(8.0, 400.0), color: w.color };
                let alpha = (w.opacity.clamp(0.05, 1.0) * 255.0).round() as u8;
                // Centre de la page ; ligne de base décalée d'un tiers de la taille pour centrer.
                // (vers le bas de la ligne, perpendiculairement au sens du texte).
                let extra = if w.diagonal { 45.0f32 } else { 0.0 };
                let dy = st.size * 0.33;
                let (cx, cy) = (dw / 2.0 + dy * extra.to_radians().sin(), dh / 2.0 + dy * extra.to_radians().cos());
                place(doc, &page, fonts, &fill(&w.text, &f), &st, alpha, &frame, cx, cy, 0.5, extra, tag(&mut first).as_deref())?;
            }
            for (band, top) in [(&config.header, true), (&config.footer, false)] {
                let yd = if top { margin + size * 0.8 } else { dh - margin };
                for (txt, x, anchor) in [(&band.left, margin, 0.0), (&band.center, dw / 2.0, 0.5), (&band.right, dw - margin, 1.0)] {
                    let s = fill(txt, &f);
                    if !s.trim().is_empty() {
                        place(doc, &page, fonts, &s, &band_style, 255, &frame, x, yd, anchor, 0.0, tag(&mut first).as_deref())?;
                    }
                }
            }
        }
        if unsafe { b.FPDFPage_GenerateContent(page.raw_handle()) } == 0 {
            bail!("contenu de la page non régénéré");
        }
    }
    Ok(wanted.len())
}

/// Retire filigranes, en-têtes et pieds de page ajoutés par PDFReader ; renvoie le nombre d'objets retirés.
pub fn remove(doc: &PdfDocument) -> Result<usize> {
    let b = raw_bindings();
    let mut n = 0;
    for p in 0..doc.pages().len() {
        let page = doc.pages().get(p)?;
        let k = remove_page(&page);
        if k > 0 && unsafe { b.FPDFPage_GenerateContent(page.raw_handle()) } == 0 {
            bail!("contenu de la page non régénéré");
        }
        n += k;
    }
    Ok(n)
}

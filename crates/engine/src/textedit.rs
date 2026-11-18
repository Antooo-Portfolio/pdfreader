//! Phase 2, « Modifier le texte » : le texte existant d'une page, regroupé en lignes (objets texte
//! sur la même ligne de base, même police et même taille, proches), modifiable ligne par ligne.
//!
//! Le texte modifié garde la police d'origine quand elle contient tous les caractères voulus
//! (police standard, ou police intégrée qui a ces glyphes) ; sinon il prend une police proche
//! (standard, ou TrueType intégrée au-delà de Windows-1252), à la même place, taille et couleur.
//! Les lignes voisines ne sont pas recalculées (pas de remise en page du paragraphe).

use std::ffi::{c_char, c_ulong};

use anyhow::{Result, bail};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::pagetext::{Family, FontCache, TextStyle};

const TEXT_OBJECT: i32 = 1;
/// Mode de rendu « invisible » (texte d'OCR sous une image) : pas modifiable ici.
const INVISIBLE: i32 = 3;

/// Ligne de texte modifiable. Points depuis le HAUT de la page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    /// Index des objets texte de la ligne (dans l'ordre de la page, au moment de la lecture).
    pub objects: Vec<i32>,
    pub page: i32,
    /// Rectangle occupé (gauche, haut, largeur, hauteur).
    pub rect: [f32; 4],
    pub text: String,
    /// Nom de la police (sans le préfixe de sous-ensemble « ABCDEF+ »).
    pub font: String,
    /// Taille affichée (points).
    pub size: f32,
    pub bold: bool,
    pub italic: bool,
    pub family: Family,
    pub color: [u8; 3],
    pub embedded: bool,
}

/// Résultat d'une modification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
    /// La police d'origine a été gardée (sinon : police proche).
    pub kept_font: bool,
}

struct Obj {
    index: i32,
    handle: FPDF_PAGEOBJECT,
    text: String,
    l: f32,
    b: f32,
    r: f32,
    t: f32,
    /// Ligne de base.
    y: f32,
    size: f32,
    font: FPDF_FONT,
    horizontal: bool,
}

fn utf16(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn object_text(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT, tp: FPDF_TEXTPAGE) -> String {
    let n = unsafe { b.FPDFTextObj_GetText(obj, tp, std::ptr::null_mut(), 0) };
    if n == 0 {
        return String::new();
    }
    let mut buf = vec![0u16; n as usize / 2 + 1];
    unsafe { b.FPDFTextObj_GetText(obj, tp, buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong) };
    utf16(&buf)
}

/// Nom de la police (PDFium retire le préfixe « ABCDEF+ » des sous-ensembles).
fn font_name(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT) -> String {
    let n = unsafe { b.FPDFFont_GetBaseFontName(font, std::ptr::null_mut(), 0) };
    if n == 0 {
        return String::new();
    }
    let mut buf = vec![0u8; n];
    unsafe { b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr() as *mut c_char, n) };
    let s = String::from_utf8_lossy(&buf).trim_end_matches(char::from(0)).to_string();
    match s.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_uppercase()) => rest.to_string(),
        _ => s,
    }
}

/// Style approché d'une police (pour l'aperçu et la police de remplacement).
fn font_style(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT, name: &str) -> (Family, bool, bool) {
    let flags = unsafe { b.FPDFFont_GetFlags(font) };
    let weight = unsafe { b.FPDFFont_GetWeight(font) };
    let n = name.to_ascii_lowercase();
    let mono = flags & 1 != 0 || n.contains("courier") || n.contains("mono") || n.contains("consol");
    let serif = !mono && (flags & 2 != 0 || ["times", "serif", "georgia", "garamond", "cambria", "minion", "palatino", "book"].iter().any(|w| n.contains(w))) && !n.contains("sans");
    let bold = weight >= 600 || flags & 0x40000 != 0 || n.contains("bold") || n.contains("black") || n.contains("heavy");
    let italic = flags & 0x40 != 0 || n.contains("italic") || n.contains("oblique");
    (if mono { Family::Mono } else if serif { Family::Serif } else { Family::Sans }, bold, italic)
}

fn our_object(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> bool {
    let n = unsafe { b.FPDFPageObj_CountMarks(obj) };
    (0..n).any(|i| {
        let m = unsafe { b.FPDFPageObj_GetMark(obj, i as c_ulong) };
        if m.is_null() {
            return false;
        }
        let mut len: c_ulong = 0;
        unsafe { b.FPDFPageObjMark_GetName(m, std::ptr::null_mut(), 0, &mut len) };
        let mut buf = vec![0u16; len as usize / 2 + 1];
        unsafe { b.FPDFPageObjMark_GetName(m, buf.as_mut_ptr() as _, (buf.len() * 2) as c_ulong, &mut len) };
        utf16(&buf) == "PDFReaderText"
    })
}

/// Objets texte de la page (texte visible, hors blocs ajoutés par PDFReader).
fn objects(page: &PdfPage) -> Vec<Obj> {
    let b = raw_bindings();
    let h = page.raw_handle();
    let tp = unsafe { b.FPDFText_LoadPage(h) };
    let mut out = Vec::new();
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    for i in 0..count {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT {
            continue;
        }
        if unsafe { b.FPDFTextObj_GetTextRenderMode(obj) } as i32 == INVISIBLE || our_object(b, obj) {
            continue;
        }
        let text = object_text(b, obj, tp);
        if text.trim().is_empty() {
            continue;
        }
        let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
        unsafe { b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) };
        let mut m = FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
        unsafe { b.FPDFPageObj_GetMatrix(obj, &mut m) };
        let mut fs = 0f32;
        unsafe { b.FPDFTextObj_GetFontSize(obj, &mut fs) };
        let size = fs * (m.c * m.c + m.d * m.d).sqrt();
        let font = unsafe { b.FPDFTextObj_GetFont(obj) };
        out.push(Obj { index: i, handle: obj, text, l, b: bt, r, t, y: m.f, size, font, horizontal: m.b.abs() < 1e-3 && m.c.abs() < 1e-3 && m.a > 0.0 });
    }
    if !tp.is_null() {
        unsafe { b.FPDFText_ClosePage(tp) };
    }
    out
}

/// Regroupe en lignes les objets qui se suivent sur la même ligne de base.
fn group(objs: &[Obj]) -> Vec<Vec<usize>> {
    let mut lines: Vec<Vec<usize>> = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        if let Some(last) = lines.last_mut() {
            let p = &objs[*last.last().unwrap()];
            let same = o.horizontal
                && p.horizontal
                && o.font == p.font
                && (o.size - p.size).abs() <= p.size * 0.05
                && (o.y - p.y).abs() <= p.size * 0.2
                && o.l - p.r <= p.size * 2.0
                && o.l - p.r >= -p.size;
            if same {
                last.push(i);
                continue;
            }
        }
        lines.push(vec![i]);
    }
    lines
}

fn join(objs: &[&Obj]) -> String {
    let mut s = String::new();
    for (k, o) in objs.iter().enumerate() {
        if k > 0 {
            let p = objs[k - 1];
            let gap = o.l - p.r;
            if gap > p.size * 0.25 && !s.ends_with(' ') && !o.text.starts_with(' ') {
                s.push(' ');
            }
        }
        s.push_str(&o.text);
    }
    s.trim_end().to_string()
}

/// Lignes de texte modifiables de la page.
pub fn lines(page: &PdfPage, index: i32) -> Vec<TextLine> {
    let b = raw_bindings();
    let page_h = page.height().value;
    let objs = objects(page);
    group(&objs)
        .into_iter()
        .map(|g| {
            let parts: Vec<&Obj> = g.iter().map(|i| &objs[*i]).collect();
            let first = parts[0];
            let (l, bt, r, t) = parts.iter().fold((f32::MAX, f32::MAX, f32::MIN, f32::MIN), |(l, bt, r, t), o| (l.min(o.l), bt.min(o.b), r.max(o.r), t.max(o.t)));
            let name = font_name(b, first.font);
            let (family, bold, italic) = font_style(b, first.font, &name);
            let (mut cr, mut cg, mut cb, mut ca) = (0u32, 0u32, 0u32, 0u32);
            unsafe { b.FPDFPageObj_GetFillColor(first.handle, &mut cr, &mut cg, &mut cb, &mut ca) };
            let embedded = unsafe { b.FPDFFont_GetIsEmbedded(first.font) } != 0;
            TextLine {
                objects: parts.iter().map(|o| o.index).collect(),
                page: index,
                rect: [l, page_h - t, r - l, t - bt],
                text: join(&parts),
                font: name,
                size: (first.size * 100.0).round() / 100.0,
                bold,
                italic,
                family,
                color: [cr as u8, cg as u8, cb as u8],
                embedded,
            }
        })
        .collect()
}

/// La police contient-elle un glyphe dessiné pour ce caractère ?
fn has_glyph(b: &dyn PdfiumLibraryBindings, font: FPDF_FONT, c: char, size: f32) -> bool {
    let path = unsafe { b.FPDFFont_GetGlyphPath(font, c as u32, size.max(1.0)) };
    !path.is_null() && unsafe { b.FPDFGlyphPath_CountGlyphSegments(path) } > 0
}

/// Remplace le texte d'une ligne (texte vide : la ligne est effacée). `objects` et `expected`
/// viennent de [`lines`] : si la page a changé depuis, la modification est refusée (« stale »).
pub fn edit(doc: &PdfDocument, page: &mut PdfPage, fonts: &mut FontCache, objects_idx: &[i32], expected: &str, new_text: &str) -> Result<EditOutcome> {
    let b = raw_bindings();
    let objs = objects(page);
    let parts: Vec<&Obj> = objects_idx.iter().filter_map(|i| objs.iter().find(|o| o.index == *i)).collect();
    if parts.is_empty() || parts.len() != objects_idx.len() || join(&parts) != expected {
        bail!("stale");
    }
    let new_text = new_text.replace(['\r', '\n', '\t'], " ");
    let new_text = new_text.trim_end();
    let first = parts[0];
    let h = page.raw_handle();
    // Les autres objets de la ligne disparaissent ; le premier porte le nouveau texte.
    let remove = |o: &Obj| unsafe {
        if b.FPDFPage_RemoveObject(h, o.handle) != 0 {
            b.FPDFPageObj_Destroy(o.handle);
        }
    };
    if new_text.is_empty() {
        for o in &parts {
            remove(o);
        }
        regenerate(page)?;
        return Ok(EditOutcome { kept_font: true });
    }
    // Police gardée si elle peut dessiner chaque caractère. Une police intégrée est souvent un
    // sous-ensemble (seuls les glyphes déjà utilisés sont dans le fichier, et PDFium ne dit pas
    // lesquels : il renvoie un tracé de remplacement pour un glyphe absent) : seuls les caractères
    // déjà employés avec elle sur la page sont sûrs. Police non intégrée (standard ou du
    // système) : le glyphe doit exister.
    let embedded = unsafe { b.FPDFFont_GetIsEmbedded(first.font) } != 0;
    let used: String = objs.iter().filter(|o| o.font == first.font).map(|o| o.text.as_str()).collect();
    let keep = new_text.chars().all(|c| c.is_whitespace() || used.contains(c) || (!embedded && has_glyph(b, first.font, c, first.size)));
    let mut m = FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
    unsafe { b.FPDFPageObj_GetMatrix(first.handle, &mut m) };
    let mut font_size = 0f32;
    unsafe { b.FPDFTextObj_GetFontSize(first.handle, &mut font_size) };
    let (mut cr, mut cg, mut cb, mut ca) = (0u32, 0u32, 0u32, 255u32);
    unsafe { b.FPDFPageObj_GetFillColor(first.handle, &mut cr, &mut cg, &mut cb, &mut ca) };
    let name = font_name(b, first.font);
    let (family, bold, italic) = font_style(b, first.font, &name);
    let wide: Vec<u16> = new_text.encode_utf16().chain(std::iter::once(0)).collect();
    if keep && unsafe { b.FPDFText_SetText(first.handle, wide.as_ptr() as _) } != 0 {
        for o in &parts[1..] {
            remove(o);
        }
        regenerate(page)?;
        // Contrôle : le texte relu doit être celui voulu (encodage de la police).
        let back = lines(page, 0).into_iter().any(|l| l.text == new_text);
        if back {
            return Ok(EditOutcome { kept_font: true });
        }
    }
    // Police proche : nouvel objet à la même place (même matrice), même taille et même couleur.
    let fresh = objects(page);
    for o in &fresh {
        if parts.iter().any(|p| p.handle == o.handle) {
            remove(o);
        }
    }
    let style = TextStyle { family, bold, italic, size: font_size.max(1.0), color: [cr as u8, cg as u8, cb as u8] };
    let obj = crate::pagetext::new_text_object(doc, fonts, new_text, &style)?;
    unsafe {
        b.FPDFPageObj_SetFillColor(obj, cr, cg, cb, ca.max(1));
        b.FPDFPageObj_SetMatrix(obj, &m);
        b.FPDFPage_InsertObject(h, obj);
    }
    regenerate(page)?;
    Ok(EditOutcome { kept_font: false })
}

fn regenerate(page: &PdfPage) -> Result<()> {
    if unsafe { raw_bindings().FPDFPage_GenerateContent(page.raw_handle()) } == 0 {
        bail!("contenu de la page non régénéré");
    }
    Ok(())
}

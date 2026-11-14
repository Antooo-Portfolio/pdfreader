//! M2, lot « formulaires et signature » :
//! - champs AcroForm : lecture et saisie par le moteur interactif de PDFium (`FORM_*`), qui
//!   régénère l'apparence de chaque champ (décision du spike M0 : jamais `set_value` seul) ;
//! - « Remplir et signer » sur un document sans champs : texte, coche, date et signature posés
//!   comme annotations Tampon (/Stamp) dont l'apparence contient nos objets (texte, tracé,
//!   image). PDFium ne génère pas l'apparence des zones de texte (/FreeText) ; un tampon s'affiche
//!   et s'imprime partout, et reste un commentaire que l'on peut supprimer.
//! Coordonnées échangées avec l'interface : points PDF depuis le HAUT à gauche de la page.

use anyhow::{Context, Result, bail};
use pdfium_render::prelude::*;

use crate::annotations::pdf_date_now;

// Types de champ (fpdf_formfill.h).
const FIELD_PUSHBUTTON: i32 = 1;
const FIELD_CHECKBOX: i32 = 2;
const FIELD_RADIOBUTTON: i32 = 3;
const FIELD_COMBOBOX: i32 = 4;
const FIELD_LISTBOX: i32 = 5;
const FIELD_TEXTFIELD: i32 = 6;
const FIELD_SIGNATURE: i32 = 7;

// Drapeaux de champ (ISO 32000-2, tableaux 227, 228, 230, 231).
const FF_READONLY: i32 = 1;
const FF_REQUIRED: i32 = 1 << 1;
const FF_MULTILINE: i32 = 1 << 12;
const FF_PASSWORD: i32 = 1 << 13;
const FF_COMBO_EDIT: i32 = 1 << 18;
const FF_MULTISELECT: i32 = 1 << 21;
const FF_COMB: i32 = 1 << 24;

const WIDGET: i32 = 20;
const STAMP: i32 = 13;

/// Clé privée qui distingue nos tampons « texte », « coche » et « signature ».
pub const KIND_KEY: &str = "PDFReaderKind";

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChoiceOption {
    pub label: String,
    pub selected: bool,
}

/// Un champ de formulaire (un widget : un bouton radio par widget).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// Rang de l'annotation sur la page : identifiant pour la saisie.
    pub index: i32,
    pub page: i32,
    pub name: String,
    /// Nom lisible (/TU), à défaut le nom technique.
    pub label: String,
    pub kind: &'static str,
    pub rect: [f32; 4],
    pub value: String,
    pub checked: bool,
    /// Valeur d'export d'une case ou d'un bouton radio.
    pub export_value: String,
    pub options: Vec<ChoiceOption>,
    pub read_only: bool,
    pub required: bool,
    pub multiline: bool,
    pub password: bool,
    pub editable_combo: bool,
    pub multi_select: bool,
    pub comb: bool,
    /// Taille de police du champ (0 : automatique).
    pub font_size: f32,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read_wide(f: impl Fn(*mut u16, u64) -> u64) -> String {
    let len = f(std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize).div_ceil(2)];
    f(buf.as_mut_ptr(), len);
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf16_lossy(&buf)
}

/// Page ouverte pour le moteur de formulaires : PDFium exige `FORM_OnAfterLoadPage` avant toute
/// interaction et `FORM_OnBeforeClosePage` après.
struct FormPage<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    page: FPDF_PAGE,
}

impl<'a> FormPage<'a> {
    fn new(doc: &PdfDocument, page: &PdfPage) -> Option<Self> {
        let form = doc.form()?.raw_handle();
        let b = raw_bindings();
        unsafe { b.FORM_OnAfterLoadPage(page.raw_handle(), form) };
        Some(Self { b, form, page: page.raw_handle() })
    }
}

impl Drop for FormPage<'_> {
    fn drop(&mut self) {
        unsafe {
            self.b.FORM_ForceToKillFocus(self.form);
            self.b.FORM_OnBeforeClosePage(self.page, self.form);
        }
    }
}

struct Annot<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    h: FPDF_ANNOTATION,
}

impl Drop for Annot<'_> {
    fn drop(&mut self) {
        unsafe { self.b.FPDFPage_CloseAnnot(self.h) };
    }
}

fn get_annot<'a>(b: &'a dyn PdfiumLibraryBindings, page: FPDF_PAGE, index: i32) -> Option<Annot<'a>> {
    let h = unsafe { b.FPDFPage_GetAnnot(page, index) };
    (!h.is_null()).then_some(Annot { b, h })
}

fn rect_of(b: &dyn PdfiumLibraryBindings, a: FPDF_ANNOTATION) -> Option<(f32, f32, f32, f32)> {
    let mut r = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
    if unsafe { b.FPDFAnnot_GetRect(a, &mut r) } == 0 {
        return None;
    }
    Some((r.left.min(r.right), r.bottom.min(r.top), r.left.max(r.right), r.bottom.max(r.top)))
}

fn kind_of(t: i32) -> &'static str {
    match t {
        FIELD_PUSHBUTTON => "button",
        FIELD_CHECKBOX => "checkbox",
        FIELD_RADIOBUTTON => "radio",
        FIELD_COMBOBOX => "combo",
        FIELD_LISTBOX => "list",
        FIELD_TEXTFIELD => "text",
        FIELD_SIGNATURE => "signature",
        _ => "unknown",
    }
}

/// Champs de formulaire d'une page (vide si le document n'a pas de formulaire AcroForm).
pub fn fields(doc: &PdfDocument, page: &PdfPage, page_index: i32) -> Vec<Field> {
    let Some(fp) = FormPage::new(doc, page) else { return Vec::new() };
    let b = fp.b;
    let page_h = page.height().value;
    let n = unsafe { b.FPDFPage_GetAnnotCount(fp.page) };
    let mut out = Vec::new();
    for i in 0..n.min(5000) {
        let Some(a) = get_annot(b, fp.page, i) else { continue };
        if unsafe { b.FPDFAnnot_GetSubtype(a.h) } as i32 != WIDGET {
            continue;
        }
        let t = unsafe { b.FPDFAnnot_GetFormFieldType(fp.form, a.h) };
        let Some((l, bt, r, tp)) = rect_of(b, a.h) else { continue };
        let flags = unsafe { b.FPDFAnnot_GetFormFieldFlags(fp.form, a.h) };
        let name = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldName(fp.form, a.h, buf, len as _) as u64 });
        let alt = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldAlternateName(fp.form, a.h, buf, len as _) as u64 });
        let value = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldValue(fp.form, a.h, buf, len as _) as u64 });
        let export_value = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetFormFieldExportValue(fp.form, a.h, buf, len as _) as u64 });
        let mut options = Vec::new();
        if t == FIELD_COMBOBOX || t == FIELD_LISTBOX {
            let count = unsafe { b.FPDFAnnot_GetOptionCount(fp.form, a.h) };
            for k in 0..count.clamp(0, 2000) {
                let label = read_wide(|buf, len| unsafe { b.FPDFAnnot_GetOptionLabel(fp.form, a.h, k, buf, len as _) as u64 });
                let selected = unsafe { b.FPDFAnnot_IsOptionSelected(fp.form, a.h, k) } != 0;
                options.push(ChoiceOption { label, selected });
            }
        }
        let mut font_size = 0f32;
        unsafe { b.FPDFAnnot_GetFontSize(fp.form, a.h, &mut font_size) };
        let checked = (t == FIELD_CHECKBOX || t == FIELD_RADIOBUTTON) && unsafe { b.FPDFAnnot_IsChecked(fp.form, a.h) } != 0;
        out.push(Field {
            index: i,
            page: page_index,
            label: if alt.trim().is_empty() { name.clone() } else { alt },
            name,
            kind: kind_of(t),
            rect: [l, page_h - tp, r - l, tp - bt],
            value,
            checked,
            export_value,
            options,
            read_only: flags & FF_READONLY != 0,
            required: flags & FF_REQUIRED != 0,
            multiline: flags & FF_MULTILINE != 0,
            password: flags & FF_PASSWORD != 0,
            editable_combo: flags & FF_COMBO_EDIT != 0,
            multi_select: flags & FF_MULTISELECT != 0,
            comb: flags & FF_COMB != 0,
            font_size,
        });
    }
    out
}

/// Valeur à saisir dans un champ.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldInput {
    Text { value: String },
    Checked { checked: bool },
    Choice { index: i32 },
}

/// Saisit une valeur comme le ferait l'utilisateur dans PDFium : focus, saisie, perte du focus.
/// PDFium met alors à jour la valeur (/V) et régénère l'apparence de tous les widgets du champ.
pub fn set_field(doc: &PdfDocument, page: &PdfPage, index: i32, input: &FieldInput) -> Result<()> {
    let fp = FormPage::new(doc, page).context("pas de formulaire")?;
    let b = fp.b;
    let a = get_annot(b, fp.page, index).context("champ introuvable")?;
    if unsafe { b.FPDFAnnot_GetSubtype(a.h) } as i32 != WIDGET {
        bail!("ce n'est pas un champ");
    }
    let t = unsafe { b.FPDFAnnot_GetFormFieldType(fp.form, a.h) };
    let flags = unsafe { b.FPDFAnnot_GetFormFieldFlags(fp.form, a.h) };
    if flags & FF_READONLY != 0 {
        bail!("champ en lecture seule");
    }
    let (l, bt, r, tp) = rect_of(b, a.h).context("champ sans position")?;
    let (cx, cy) = (((l + r) / 2.0) as f64, ((bt + tp) / 2.0) as f64);
    let click = || unsafe {
        b.FORM_OnMouseMove(fp.form, fp.page, 0, cx, cy);
        b.FORM_OnLButtonDown(fp.form, fp.page, 0, cx, cy);
        b.FORM_OnLButtonUp(fp.form, fp.page, 0, cx, cy);
    };
    match (t, input) {
        (FIELD_TEXTFIELD, FieldInput::Text { value }) | (FIELD_COMBOBOX, FieldInput::Text { value }) => {
            if unsafe { b.FORM_SetFocusedAnnot(fp.form, a.h) } == 0 {
                click();
            }
            let w = wide(value);
            unsafe {
                b.FORM_SelectAllText(fp.form, fp.page);
                b.FORM_ReplaceSelection(fp.form, fp.page, w.as_ptr() as _);
            }
        }
        (FIELD_CHECKBOX | FIELD_RADIOBUTTON, FieldInput::Checked { checked }) => {
            let now = unsafe { b.FPDFAnnot_IsChecked(fp.form, a.h) } != 0;
            // Un bouton radio coché ne se décoche pas en cliquant dessus (comportement normal).
            if now != *checked {
                click();
            }
        }
        (FIELD_COMBOBOX | FIELD_LISTBOX, FieldInput::Choice { index }) => {
            if unsafe { b.FORM_SetFocusedAnnot(fp.form, a.h) } == 0 {
                bail!("le champ refuse le focus");
            }
            if unsafe { b.FORM_SetIndexSelected(fp.form, fp.page, *index, 1) } == 0 {
                bail!("choix refusé");
            }
        }
        _ => bail!("saisie incompatible avec ce champ"),
    }
    drop(a);
    drop(fp); // perte du focus : la valeur est validée
    crate::render_page(page, 0.25)?;
    Ok(())
}

/* ------------------------------------------------------------------ tampons « Remplir et signer » */

struct Obj<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    h: FPDF_PAGEOBJECT,
}

impl Obj<'_> {
    fn bounds(&self) -> (f32, f32, f32, f32) {
        let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
        unsafe { self.b.FPDFPageObj_GetBounds(self.h, &mut l, &mut bt, &mut r, &mut t) };
        (l, bt, r, t)
    }
}

fn new_stamp<'a>(b: &'a dyn PdfiumLibraryBindings, page: &PdfPage) -> Result<Annot<'a>> {
    let h = unsafe { b.FPDFPage_CreateAnnot(page.raw_handle(), STAMP as _) };
    if h.is_null() {
        bail!("PDFium n'a pas pu créer l'annotation");
    }
    Ok(Annot { b, h })
}

fn finish_stamp(a: &Annot, kind: &str, contents: &str, author: &str, rect: (f32, f32, f32, f32)) -> Result<String> {
    let b = a.b;
    let r = FS_RECTF { left: rect.0, bottom: rect.1, right: rect.2, top: rect.3 };
    unsafe { b.FPDFAnnot_SetRect(a.h, &r) };
    let name = format!("pdfreader-{kind}-{}", pdf_date_now().trim_start_matches("D:").trim_end_matches('Z'));
    let name = format!("{name}-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0));
    let now = pdf_date_now();
    unsafe {
        b.FPDFAnnot_SetStringValue_str(a.h, "NM", &name);
        b.FPDFAnnot_SetStringValue_str(a.h, "T", author);
        b.FPDFAnnot_SetStringValue_str(a.h, "M", &now);
        b.FPDFAnnot_SetStringValue_str(a.h, "CreationDate", &now);
        b.FPDFAnnot_SetStringValue_str(a.h, "Contents", contents);
        b.FPDFAnnot_SetStringValue_str(a.h, KIND_KEY, kind);
        // Drapeau Imprimer : la signature et le texte saisi doivent sortir à l'impression.
        b.FPDFAnnot_SetFlags(a.h, 4);
    }
    Ok(name)
}

fn append(a: &Annot, obj: Obj) -> Result<()> {
    if unsafe { a.b.FPDFAnnot_AppendObject(a.h, obj.h) } == 0 {
        unsafe { a.b.FPDFPageObj_Destroy(obj.h) };
        bail!("PDFium a refusé l'objet");
    }
    Ok(())
}

/// Texte posé sur la page (formulaire plat) : une ou plusieurs lignes en Helvetica, le coin haut
/// gauche du texte en (`x`, `y`) depuis le haut. Renvoie l'identifiant du commentaire.
pub fn add_text(doc: &PdfDocument, page: &mut PdfPage, x: f32, y: f32, text: &str, size: f32, rgb: [u8; 3], author: &str) -> Result<String> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    if lines.iter().all(|l| l.is_empty()) {
        bail!("texte vide");
    }
    let b = raw_bindings();
    let size = size.clamp(4.0, 144.0);
    let page_h = page.height().value;
    let top = page_h - y;
    let a = new_stamp(b, page)?;
    let mut objs = Vec::new();
    let (mut l, mut bt, mut r, mut t) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        let h = unsafe { b.FPDFPageObj_NewTextObj(doc.raw_handle(), "Helvetica", size) };
        if h.is_null() {
            bail!("police indisponible");
        }
        let obj = Obj { b, h };
        let w = wide(line);
        unsafe {
            b.FPDFText_SetText(h, w.as_ptr() as _);
            b.FPDFPageObj_SetFillColor(h, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, 255);
            // Ligne de base : hauteur de capitale (≈ 0,8 em) sous le haut, interligne 1,2.
            b.FPDFPageObj_Transform(h, 1.0, 0.0, 0.0, 1.0, x as f64, (top - size * 0.8 - size * 1.2 * i as f32) as f64);
        }
        let (ol, ob, or, ot) = obj.bounds();
        l = l.min(ol);
        bt = bt.min(ob);
        r = r.max(or);
        t = t.max(ot);
        objs.push(obj);
    }
    // Le rectangle d'abord : PDFium fixe la boîte de l'apparence au premier ajout d'objet.
    let pad = 1.0;
    let name = finish_stamp(&a, "text", text, author, (l - pad, bt - pad, r + pad, t + pad))?;
    unsafe { b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderSize", &format!("{size}")) };
    for o in objs {
        append(&a, o)?;
    }
    Ok(name)
}

/// Coche (✓) ou croix (✗) tracée, de `size` points de côté, coin haut gauche en (`x`, `y`).
pub fn add_mark(page: &mut PdfPage, x: f32, y: f32, size: f32, cross: bool, rgb: [u8; 3], author: &str) -> Result<String> {
    let b = raw_bindings();
    let s = size.clamp(4.0, 96.0);
    let page_h = page.height().value;
    let (x0, y1) = (x, page_h - y);
    let y0 = y1 - s;
    let a = new_stamp(b, page)?;
    let strokes: Vec<Vec<(f32, f32)>> = if cross {
        vec![vec![(x0 + s * 0.15, y1 - s * 0.15), (x0 + s * 0.85, y0 + s * 0.15)], vec![(x0 + s * 0.85, y1 - s * 0.15), (x0 + s * 0.15, y0 + s * 0.15)]]
    } else {
        vec![vec![(x0 + s * 0.1, y0 + s * 0.5), (x0 + s * 0.4, y0 + s * 0.15), (x0 + s * 0.9, y1 - s * 0.1)]]
    };
    let name = finish_stamp(&a, if cross { "cross" } else { "check" }, if cross { "✗" } else { "✓" }, author, (x0, y0, x0 + s, y1))?;
    for st in strokes {
        let (sx, sy) = st[0];
        let h = unsafe { b.FPDFPageObj_CreateNewPath(sx, sy) };
        if h.is_null() {
            bail!("tracé impossible");
        }
        unsafe {
            for &(px, py) in &st[1..] {
                b.FPDFPath_LineTo(h, px, py);
            }
            b.FPDFPageObj_SetStrokeColor(h, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, 255);
            b.FPDFPageObj_SetStrokeWidth(h, (s * 0.12).max(1.0));
            b.FPDFPageObj_SetLineCap(h, 1);
            b.FPDFPageObj_SetLineJoin(h, 1);
            // Mode : pas de remplissage (0), contour (1).
            b.FPDFPath_SetDrawMode(h, 0, 1);
        }
        append(&a, Obj { b, h })?;
    }
    Ok(name)
}

/// Signature (ou initiales) : image PNG avec transparence, posée dans le rectangle
/// [x, y, largeur, hauteur] (points depuis le haut).
pub fn add_image(doc: &PdfDocument, page: &mut PdfPage, rect: [f32; 4], png: &[u8], kind: &str, author: &str) -> Result<String> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).context("image illisible")?.to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        bail!("taille d'image refusée");
    }
    let b = raw_bindings();
    let [x, y, rw, rh] = rect;
    let page_h = page.height().value;
    let a = new_stamp(b, page)?;
    let name = finish_stamp(&a, kind, if kind == "initials" { "Initiales" } else { "Signature" }, author, (x, page_h - y - rh, x + rw, page_h - y))?;
    unsafe {
        // FPDFBitmap_BGRA = 4.
        let bmp = b.FPDFBitmap_CreateEx(w as i32, h as i32, 4, std::ptr::null_mut(), 0);
        if bmp.is_null() {
            bail!("mémoire insuffisante");
        }
        let stride = b.FPDFBitmap_GetStride(bmp) as usize;
        let buf = std::slice::from_raw_parts_mut(b.FPDFBitmap_GetBuffer(bmp) as *mut u8, stride * h as usize);
        for (py, row) in img.rows().enumerate() {
            for (px, p) in row.enumerate() {
                let o = py * stride + px * 4;
                buf[o] = p[2];
                buf[o + 1] = p[1];
                buf[o + 2] = p[0];
                buf[o + 3] = p[3];
            }
        }
        let obj = b.FPDFPageObj_NewImageObj(doc.raw_handle());
        if obj.is_null() {
            b.FPDFBitmap_Destroy(bmp);
            bail!("image impossible");
        }
        let ok = b.FPDFImageObj_SetBitmap(std::ptr::null_mut(), 0, obj, bmp);
        b.FPDFBitmap_Destroy(bmp);
        if ok == 0 {
            b.FPDFPageObj_Destroy(obj);
            bail!("image refusée par PDFium");
        }
        // Une image occupe le carré unité : on l'étire au rectangle voulu.
        b.FPDFPageObj_Transform(obj, rw as f64, 0.0, 0.0, rh as f64, x as f64, (page_h - y - rh) as f64);
        append(&a, Obj { b, h: obj })?;
    }
    Ok(name)
}

/* ------------------------------------------------------------------ zone de texte et légende */

/// Largeur d'un texte en Helvetica à la taille donnée (objet de mesure jeté aussitôt).
fn text_width(b: &dyn PdfiumLibraryBindings, doc: &PdfDocument, text: &str, size: f32) -> f32 {
    text_width_in(b, doc, text, size, "Helvetica")
}

fn text_width_in(b: &dyn PdfiumLibraryBindings, doc: &PdfDocument, text: &str, size: f32, font: &str) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    unsafe {
        let h = b.FPDFPageObj_NewTextObj(doc.raw_handle(), font, size);
        if h.is_null() {
            return text.chars().count() as f32 * size * 0.5;
        }
        let w = wide(text);
        b.FPDFText_SetText(h, w.as_ptr() as _);
        let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
        b.FPDFPageObj_GetBounds(h, &mut l, &mut bt, &mut r, &mut t);
        b.FPDFPageObj_Destroy(h);
        (r - l).max(0.0)
    }
}

/// Coupe le texte en lignes qui tiennent dans `width` (mots entiers ; un mot trop long est coupé).
pub fn wrap(b: &dyn PdfiumLibraryBindings, doc: &PdfDocument, text: &str, size: f32, width: f32) -> Vec<String> {
    let mut out = Vec::new();
    for para in text.lines() {
        let mut line = String::new();
        for word in para.split_whitespace() {
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if text_width(b, doc, &candidate, size) <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                out.push(std::mem::take(&mut line));
            }
            if text_width(b, doc, word, size) <= width {
                line = word.to_string();
                continue;
            }
            // Mot plus large que la zone : coupé caractère par caractère.
            let mut piece = String::new();
            for ch in word.chars() {
                let next = format!("{piece}{ch}");
                if !piece.is_empty() && text_width(b, doc, &next, size) > width {
                    out.push(std::mem::take(&mut piece));
                    piece.push(ch);
                } else {
                    piece = next;
                }
            }
            line = piece;
        }
        out.push(line);
    }
    out
}

fn new_path(b: &dyn PdfiumLibraryBindings, pts: &[(f32, f32)], close: bool, stroke: Option<([u8; 3], f32)>, fill: Option<[u8; 3]>) -> Result<FPDF_PAGEOBJECT> {
    unsafe {
        let (x0, y0) = pts[0];
        let h = b.FPDFPageObj_CreateNewPath(x0, y0);
        if h.is_null() {
            bail!("tracé impossible");
        }
        for &(x, y) in &pts[1..] {
            b.FPDFPath_LineTo(h, x, y);
        }
        if close {
            b.FPDFPath_Close(h);
        }
        if let Some((c, w)) = stroke {
            b.FPDFPageObj_SetStrokeColor(h, c[0] as u32, c[1] as u32, c[2] as u32, 255);
            b.FPDFPageObj_SetStrokeWidth(h, w);
            b.FPDFPageObj_SetLineJoin(h, 1);
            b.FPDFPageObj_SetLineCap(h, 1);
        }
        if let Some(c) = fill {
            b.FPDFPageObj_SetFillColor(h, c[0] as u32, c[1] as u32, c[2] as u32, 255);
        }
        // Remplissage : 0 aucun, 1 pair-impair ; contour : oui ou non.
        b.FPDFPath_SetDrawMode(h, if fill.is_some() { 1 } else { 0 }, stroke.is_some() as i32);
        Ok(h)
    }
}

/// Zone de texte encadrée ; avec `anchor`, légende : une flèche relie la zone au point désigné.
/// `rect` : [x, y, largeur, hauteur minimale] depuis le haut ; la hauteur grandit pour tout le
/// texte. `fill` : fond (blanc conseillé pour la lisibilité), sinon transparent.
#[allow(clippy::too_many_arguments)]
pub fn add_textbox(
    doc: &PdfDocument,
    page: &mut PdfPage,
    rect: [f32; 4],
    text: &str,
    size: f32,
    rgb: [u8; 3],
    fill: Option<[u8; 3]>,
    anchor: Option<[f32; 2]>,
    author: &str,
) -> Result<String> {
    if text.trim().is_empty() {
        bail!("texte vide");
    }
    let b = raw_bindings();
    let size = size.clamp(4.0, 144.0);
    let page_h = page.height().value;
    let pad = (size * 0.4).max(3.0);
    let [x, y, w, min_h] = rect;
    let w = w.max(size * 3.0);
    let lines = wrap(b, doc, text, size, w - pad * 2.0);
    let h = min_h.max(lines.len() as f32 * size * 1.2 + pad * 2.0 - size * 0.2);
    // Coordonnées PDF (origine en bas).
    let (l, r, t, bt) = (x, x + w, page_h - y, page_h - y - h);
    let border = 1.0f32;
    let mut objs = Vec::new();
    objs.push(new_path(b, &[(l, bt), (r, bt), (r, t), (l, t)], true, Some((rgb, border)), fill)?);
    let (mut ul, mut ub, mut ur, mut ut) = (l - border, bt - border, r + border, t + border);
    if let Some([ax, ay]) = anchor {
        let ay = page_h - ay;
        // Départ au milieu du côté de la zone le plus proche du point.
        let (sx, sy) = if ax < l || ax > r { (ax.clamp(l, r), (bt + t) / 2.0) } else { ((l + r) / 2.0, ay.clamp(bt, t)) };
        let (dx, dy) = (ax - sx, ay - sy);
        let len = (dx * dx + dy * dy).sqrt();
        if len > 2.0 {
            objs.push(new_path(b, &[(sx, sy), (ax, ay)], false, Some((rgb, border)), None)?);
            let (ux, uy) = (dx / len, dy / len);
            let head = (size * 0.7).max(6.0);
            let (bx, by) = (ax - ux * head, ay - uy * head);
            let (px, py) = (-uy * head * 0.45, ux * head * 0.45);
            objs.push(new_path(b, &[(ax, ay), (bx + px, by + py), (bx - px, by - py)], true, Some((rgb, border)), Some(rgb))?);
            ul = ul.min(ax - head);
            ur = ur.max(ax + head);
            ub = ub.min(ay - head);
            ut = ut.max(ay + head);
        }
    }
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        let hobj = unsafe { b.FPDFPageObj_NewTextObj(doc.raw_handle(), "Helvetica", size) };
        if hobj.is_null() {
            bail!("police indisponible");
        }
        let wtxt = wide(line);
        unsafe {
            b.FPDFText_SetText(hobj, wtxt.as_ptr() as _);
            b.FPDFPageObj_SetFillColor(hobj, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, 255);
            b.FPDFPageObj_Transform(hobj, 1.0, 0.0, 0.0, 1.0, (l + pad) as f64, (t - pad - size * 0.8 - size * 1.2 * i as f32) as f64);
        }
        objs.push(hobj);
    }
    let a = new_stamp(b, page)?;
    let kind = if anchor.is_some() { "callout" } else { "textbox" };
    let name = finish_stamp(&a, kind, text, author, (ul, ub, ur, ut))?;
    unsafe {
        b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderSize", &format!("{size}"));
        b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderBox", &format!("{x} {y} {w} {min_h}"));
        if let Some([ax, ay]) = anchor {
            b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderAnchor", &format!("{ax} {ay}"));
        }
        if fill.is_some() {
            b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderFill", "1");
        }
    }
    for h in objs {
        append(&a, Obj { b, h })?;
    }
    Ok(name)
}

/* ------------------------------------------------------------------ tampons prédéfinis */

/// Tampons prédéfinis : identifiant de l'interface, nom standard PDF (/Name, reconnu par les
/// autres lecteurs), couleur.
pub const PRESETS: [(&str, &str, [u8; 3]); 9] = [
    ("approved", "Approved", [22, 120, 60]),
    ("notApproved", "NotApproved", [190, 30, 45]),
    ("draft", "Draft", [31, 78, 158]),
    ("final", "Final", [22, 120, 60]),
    ("confidential", "Confidential", [190, 30, 45]),
    ("forComment", "ForComment", [31, 78, 158]),
    ("forPublicRelease", "ForPublicRelease", [31, 78, 158]),
    ("notForPublicRelease", "NotForPublicRelease", [190, 30, 45]),
    ("expired", "Expired", [190, 30, 45]),
];

/// Rectangle aux coins arrondis (contour seul).
fn rounded_rect(b: &dyn PdfiumLibraryBindings, l: f32, bt: f32, r: f32, t: f32, radius: f32, rgb: [u8; 3], width: f32) -> Result<FPDF_PAGEOBJECT> {
    let k = 0.5523 * radius; // approximation d'un quart de cercle par une courbe de Bézier
    unsafe {
        let h = b.FPDFPageObj_CreateNewPath(l + radius, bt);
        if h.is_null() {
            bail!("tracé impossible");
        }
        b.FPDFPath_LineTo(h, r - radius, bt);
        b.FPDFPath_BezierTo(h, r - radius + k, bt, r, bt + radius - k, r, bt + radius);
        b.FPDFPath_LineTo(h, r, t - radius);
        b.FPDFPath_BezierTo(h, r, t - radius + k, r - radius + k, t, r - radius, t);
        b.FPDFPath_LineTo(h, l + radius, t);
        b.FPDFPath_BezierTo(h, l + radius - k, t, l, t - radius + k, l, t - radius);
        b.FPDFPath_LineTo(h, l, bt + radius);
        b.FPDFPath_BezierTo(h, l, bt + radius - k, l + radius - k, bt, l + radius, bt);
        b.FPDFPath_Close(h);
        b.FPDFPageObj_SetStrokeColor(h, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, 255);
        b.FPDFPageObj_SetStrokeWidth(h, width);
        b.FPDFPath_SetDrawMode(h, 0, 1);
        Ok(h)
    }
}

/// Tampon prédéfini centré en (`x`, `y`) depuis le haut : `label` (déjà traduit) en capitales,
/// `subtitle` facultatif (nom et date). Renvoie l'identifiant du commentaire.
#[allow(clippy::too_many_arguments)]
pub fn add_preset_stamp(doc: &PdfDocument, page: &mut PdfPage, x: f32, y: f32, preset: &str, label: &str, subtitle: Option<&str>, author: &str) -> Result<String> {
    let Some(&(_, pdf_name, rgb)) = PRESETS.iter().find(|p| p.0 == preset) else { bail!("tampon inconnu : {preset}") };
    let label: String = label.trim().chars().take(40).collect::<String>().to_uppercase();
    if label.is_empty() {
        bail!("tampon sans texte");
    }
    let subtitle = subtitle.map(|s| s.trim().chars().take(80).collect::<String>()).filter(|s| !s.is_empty());
    let b = raw_bindings();
    let page_h = page.height().value;
    let (size, small) = (18.0f32, 8.0f32);
    let pad = 8.0f32;
    let tw = text_width_in(b, doc, &label, size, "Helvetica-Bold");
    let sw = subtitle.as_deref().map(|s| text_width_in(b, doc, s, small, "Helvetica")).unwrap_or(0.0);
    let w = tw.max(sw) + pad * 2.0;
    let h = size + pad * 2.0 + if subtitle.is_some() { small + 3.0 } else { 0.0 };
    let (cx, cy) = (x, page_h - y);
    let (l, bt) = (cx - w / 2.0, cy - h / 2.0);
    let (r, t) = (l + w, bt + h);
    let mut objs = vec![rounded_rect(b, l, bt, r, t, 5.0, rgb, 2.0)?, rounded_rect(b, l + 3.0, bt + 3.0, r - 3.0, t - 3.0, 3.0, rgb, 0.75)?];
    let mut line = |text: &str, font: &str, sz: f32, width: f32, base: f32| -> Result<()> {
        let hobj = unsafe { b.FPDFPageObj_NewTextObj(doc.raw_handle(), font, sz) };
        if hobj.is_null() {
            bail!("police indisponible");
        }
        let wt = wide(text);
        unsafe {
            b.FPDFText_SetText(hobj, wt.as_ptr() as _);
            b.FPDFPageObj_SetFillColor(hobj, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, 255);
            b.FPDFPageObj_Transform(hobj, 1.0, 0.0, 0.0, 1.0, (cx - width / 2.0) as f64, base as f64);
        }
        objs.push(hobj);
        Ok(())
    };
    line(&label, "Helvetica-Bold", size, tw, t - pad - size * 0.8)?;
    if let Some(sub) = subtitle.as_deref() {
        line(sub, "Helvetica", small, sw, bt + pad - 1.0)?;
    }
    let a = new_stamp(b, page)?;
    let contents = match subtitle.as_deref() {
        Some(sub) => format!("{label} — {sub}"),
        None => label.clone(),
    };
    let name = finish_stamp(&a, "preset", &contents, author, (l - 1.0, bt - 1.0, r + 1.0, t + 1.0))?;
    unsafe { b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderPreset", preset) };
    // /Name est un nom PDF ; l'API ne sait écrire que des chaînes : on garde le nom standard
    // dans une clé privée lisible (les autres lecteurs utilisent l'apparence, toujours présente).
    unsafe { b.FPDFAnnot_SetStringValue_str(a.h, "PDFReaderStampName", pdf_name) };
    for hobj in objs {
        append(&a, Obj { b, h: hobj })?;
    }
    Ok(name)
}

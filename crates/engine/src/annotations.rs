//! M2, lot « annotations » : lire, créer, modifier et supprimer les commentaires d'une page.
//!
//! Tout passe par l'API brute de PDFium (`FPDFAnnot_*`) : elle couvre l'opacité (/CA), les
//! tracés d'encre et le retrait d'une apparence, que pdfium-render n'expose pas tous.
//! Coordonnées échangées avec l'interface : points PDF depuis le HAUT à gauche de la page.
//!
//! Apparences : PDFium génère lui-même l'apparence (/AP) des surlignages, soulignés, barrés,
//! ondulés, notes et tracés d'encre au rendu suivant. Après une modification, on retire l'ancienne
//! apparence pour qu'il la régénère (voir `regenerate`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, bail};
use pdfium_render::prelude::*;

// Sous-types PDFium (fpdf_annot.h).
const TEXT: i32 = 1;
const LINK: i32 = 2;
const FREETEXT: i32 = 3;
const LINE: i32 = 4;
const SQUARE: i32 = 5;
const CIRCLE: i32 = 6;
const POLYGON: i32 = 7;
const POLYLINE: i32 = 8;
const HIGHLIGHT: i32 = 9;
const UNDERLINE: i32 = 10;
const SQUIGGLY: i32 = 11;
const STRIKEOUT: i32 = 12;
const STAMP: i32 = 13;
const INK: i32 = 15;
const POPUP: i32 = 16;
const WIDGET: i32 = 20;
const XFAWIDGET: i32 = 21;

/// Drapeau « Imprimer » (/F 4) : sans lui, l'annotation n'est pas imprimée.
const FLAG_PRINT: i32 = 4;
/// Clé privée posée par PDFium sur les apparences qu'il a générées : tant qu'elle vaut `true`,
/// il ne régénère pas.
const PDFIUM_GENERATED: &str = "PDFIUM_HasGeneratedAP";

/// Type de commentaire, tel que l'interface le connaît.
pub fn kind_name(subtype: i32) -> &'static str {
    match subtype {
        TEXT => "note",
        FREETEXT => "freetext",
        LINE => "line",
        SQUARE => "square",
        CIRCLE => "circle",
        POLYGON => "polygon",
        POLYLINE => "polyline",
        HIGHLIGHT => "highlight",
        UNDERLINE => "underline",
        SQUIGGLY => "squiggly",
        STRIKEOUT => "strikeout",
        STAMP => "stamp",
        INK => "ink",
        _ => "other",
    }
}

fn subtype_of(kind: &str) -> Option<i32> {
    Some(match kind {
        "highlight" => HIGHLIGHT,
        "underline" => UNDERLINE,
        "strikeout" => STRIKEOUT,
        "squiggly" => SQUIGGLY,
        _ => return None,
    })
}

/// Un commentaire d'une page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Annot {
    /// Identifiant stable : /NM s'il existe, sinon `#rang` (valable jusqu'à la prochaine
    /// suppression sur la page ; l'interface relit la liste après chaque modification).
    pub id: String,
    pub page: i32,
    pub kind: &'static str,
    /// Boîte englobante [x, y, l, h].
    pub rect: [f32; 4],
    /// Zones couvertes par un surlignage / souligné / barré (une par ligne).
    pub boxes: Vec<[f32; 4]>,
    /// Tracés d'un dessin à main levée.
    pub strokes: Vec<Vec<[f32; 2]>>,
    pub color: Option<[u8; 3]>,
    pub opacity: f32,
    pub width: f32,
    pub contents: String,
    pub author: String,
    /// Dates PDF brutes (« D:20261109183000+01'00' »), converties par l'interface.
    pub modified: Option<String>,
    pub created: Option<String>,
    /// Réponse à un autre commentaire (/IRT).
    pub reply_to: Option<String>,
    pub locked: bool,
    /// Taille du texte d'un tampon « texte » (pour le recréer à l'identique).
    pub font_size: Option<f32>,
}

struct Raw<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    page: FPDF_PAGE,
    annot: FPDF_ANNOTATION,
}

impl Drop for Raw<'_> {
    fn drop(&mut self) {
        unsafe { self.b.FPDFPage_CloseAnnot(self.annot) };
    }
}

impl Raw<'_> {
    fn subtype(&self) -> i32 {
        unsafe { self.b.FPDFAnnot_GetSubtype(self.annot) as i32 }
    }

    fn string(&self, key: &str) -> Option<String> {
        unsafe {
            if self.b.FPDFAnnot_HasKey(self.annot, key) == 0 {
                return None;
            }
            let len = self.b.FPDFAnnot_GetStringValue(self.annot, key, std::ptr::null_mut(), 0);
            if len <= 2 {
                return Some(String::new());
            }
            let mut buf = vec![0u16; (len as usize).div_ceil(2)];
            self.b.FPDFAnnot_GetStringValue(self.annot, key, buf.as_mut_ptr(), len);
            while buf.last() == Some(&0) {
                buf.pop();
            }
            Some(String::from_utf16_lossy(&buf))
        }
    }

    fn set_string(&self, key: &str, value: &str) {
        unsafe {
            self.b.FPDFAnnot_SetStringValue_str(self.annot, key, value);
        }
    }

    fn rect(&self) -> Option<FS_RECTF> {
        let mut r = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
        (unsafe { self.b.FPDFAnnot_GetRect(self.annot, &mut r) } != 0).then_some(r)
    }

    /// Couleur (/C). PDFium refuse de la lire quand une apparence existe : on prend alors la
    /// couleur du premier tracé de l'apparence (remplissage pour un surlignage ou une note,
    /// contour pour un souligné, un barré ou un dessin).
    fn color(&self) -> Option<[u8; 3]> {
        let (mut r, mut g, mut bl, mut a) = (0u32, 0u32, 0u32, 255u32);
        if unsafe { self.b.FPDFAnnot_GetColor(self.annot, 0, &mut r, &mut g, &mut bl, &mut a) } != 0 {
            return Some([r as u8, g as u8, bl as u8]);
        }
        let fill_first = matches!(self.subtype(), HIGHLIGHT | TEXT | SQUARE | CIRCLE);
        let n = unsafe { self.b.FPDFAnnot_GetObjectCount(self.annot) };
        for i in 0..n.min(64) {
            let obj = unsafe { self.b.FPDFAnnot_GetObject(self.annot, i) };
            if obj.is_null() {
                continue;
            }
            let read = |fill: bool| {
                let (mut r, mut g, mut bl, mut a) = (0u32, 0u32, 0u32, 0u32);
                let ok = unsafe {
                    if fill {
                        self.b.FPDFPageObj_GetFillColor(obj, &mut r, &mut g, &mut bl, &mut a)
                    } else {
                        self.b.FPDFPageObj_GetStrokeColor(obj, &mut r, &mut g, &mut bl, &mut a)
                    }
                } != 0;
                (ok && a > 0).then_some([r as u8, g as u8, bl as u8])
            };
            if let Some(c) = read(fill_first).or_else(|| read(!fill_first)) {
                return Some(c);
            }
        }
        None
    }

    fn opacity(&self) -> f32 {
        let mut v: f32 = 1.0;
        if unsafe { self.b.FPDFAnnot_GetNumberValue(self.annot, "CA", &mut v) } != 0 { v.clamp(0.0, 1.0) } else { 1.0 }
    }

    fn set_color(&self, rgb: [u8; 3], opacity: f32) {
        let a = (opacity.clamp(0.05, 1.0) * 255.0).round() as u32;
        unsafe {
            // L'alpha de FPDFAnnot_SetColor devient l'opacité /CA de l'annotation.
            self.b.FPDFAnnot_SetColor(self.annot, 0, rgb[0] as u32, rgb[1] as u32, rgb[2] as u32, a);
        }
    }

    fn border_width(&self) -> f32 {
        let (mut h, mut v, mut w) = (0f32, 0f32, 1f32);
        if unsafe { self.b.FPDFAnnot_GetBorder(self.annot, &mut h, &mut v, &mut w) } != 0 { w } else { 1.0 }
    }
}

fn open_annot<'a>(b: &'a dyn PdfiumLibraryBindings, page: &PdfPage, index: i32) -> Option<Raw<'a>> {
    let h = unsafe { b.FPDFPage_GetAnnot(page.raw_handle(), index) };
    (!h.is_null()).then_some(Raw { b, page: page.raw_handle(), annot: h })
}

fn count(page: &PdfPage) -> i32 {
    unsafe { raw_bindings().FPDFPage_GetAnnotCount(page.raw_handle()) }
}

/// Les annotations que l'on montre comme commentaires : ni liens, ni champs, ni bulles (/Popup).
fn is_comment(subtype: i32) -> bool {
    !matches!(subtype, LINK | POPUP | WIDGET | XFAWIDGET) && subtype > 0
}

fn info(raw: &Raw, index: i32, page_index: i32, page_h: f32) -> Option<Annot> {
    let subtype = raw.subtype();
    if !is_comment(subtype) {
        return None;
    }
    let r = raw.rect()?;
    let (l, b, rt, t) = (r.left.min(r.right), r.bottom.min(r.top), r.left.max(r.right), r.bottom.max(r.top));
    let mut boxes = Vec::new();
    if matches!(subtype, HIGHLIGHT | UNDERLINE | STRIKEOUT | SQUIGGLY) {
        let n = unsafe { raw.b.FPDFAnnot_CountAttachmentPoints(raw.annot) };
        for i in 0..n.min(500) {
            let mut q = FS_QUADPOINTSF { x1: 0.0, y1: 0.0, x2: 0.0, y2: 0.0, x3: 0.0, y3: 0.0, x4: 0.0, y4: 0.0 };
            if unsafe { raw.b.FPDFAnnot_GetAttachmentPoints(raw.annot, i, &mut q) } == 0 {
                continue;
            }
            let xs = [q.x1, q.x2, q.x3, q.x4];
            let ys = [q.y1, q.y2, q.y3, q.y4];
            let (x0, x1) = (xs.iter().cloned().fold(f32::MAX, f32::min), xs.iter().cloned().fold(f32::MIN, f32::max));
            let (y0, y1) = (ys.iter().cloned().fold(f32::MAX, f32::min), ys.iter().cloned().fold(f32::MIN, f32::max));
            boxes.push([x0, page_h - y1, x1 - x0, y1 - y0]);
        }
    }
    let mut strokes = Vec::new();
    if subtype == INK {
        let n = unsafe { raw.b.FPDFAnnot_GetInkListCount(raw.annot) };
        for i in 0..n.min(500) {
            let len = unsafe { raw.b.FPDFAnnot_GetInkListPath(raw.annot, i, std::ptr::null_mut(), 0) };
            if len == 0 || len > 100_000 {
                continue;
            }
            let mut pts = vec![FS_POINTF { x: 0.0, y: 0.0 }; len as usize];
            unsafe { raw.b.FPDFAnnot_GetInkListPath(raw.annot, i, pts.as_mut_ptr(), len) };
            strokes.push(pts.iter().map(|p| [p.x, page_h - p.y]).collect());
        }
    }
    let flags = unsafe { raw.b.FPDFAnnot_GetFlags(raw.annot) };
    let reply_to = {
        let parent = unsafe { raw.b.FPDFAnnot_GetLinkedAnnot(raw.annot, "IRT") };
        if parent.is_null() {
            None
        } else {
            let p = Raw { b: raw.b, page: raw.page, annot: parent };
            Some(p.string("NM").filter(|s| !s.is_empty()).unwrap_or_else(|| "?".into()))
        }
    };
    let id = raw.string("NM").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("#{index}"));
    // Nos tampons « Remplir et signer » portent leur nature dans une clé privée.
    let kind = match (subtype, raw.string(crate::fill::KIND_KEY).as_deref()) {
        (STAMP, Some("text")) => "text",
        (STAMP, Some("check" | "cross")) => "mark",
        (STAMP, Some("signature" | "initials")) => "signature",
        _ => kind_name(subtype),
    };
    Some(Annot {
        id,
        page: page_index,
        kind,
        rect: [l, page_h - t, rt - l, t - b],
        boxes,
        strokes,
        color: raw.color(),
        opacity: raw.opacity(),
        width: raw.border_width(),
        contents: raw.string("Contents").unwrap_or_default(),
        author: raw.string("T").unwrap_or_default(),
        modified: raw.string("M").filter(|s| !s.is_empty()),
        created: raw.string("CreationDate").filter(|s| !s.is_empty()),
        reply_to,
        // Verrouillé (/F bit 8) ou en lecture seule (bit 7).
        locked: flags & (128 | 64) != 0,
        font_size: raw.string("PDFReaderSize").and_then(|s| s.parse().ok()),
    })
}

/// Commentaires d'une page.
pub fn list(page: &PdfPage, page_index: i32) -> Vec<Annot> {
    let b = raw_bindings();
    let page_h = page.height().value;
    (0..count(page).min(5000))
        .filter_map(|i| open_annot(b, page, i).and_then(|raw| info(&raw, i, page_index, page_h)))
        .collect()
}

fn find<'a>(b: &'a dyn PdfiumLibraryBindings, page: &PdfPage, id: &str) -> Option<(i32, Raw<'a>)> {
    if let Some(i) = id.strip_prefix('#').and_then(|n| n.parse::<i32>().ok()) {
        return open_annot(b, page, i).map(|r| (i, r));
    }
    (0..count(page)).find_map(|i| {
        let raw = open_annot(b, page, i)?;
        (raw.string("NM").as_deref() == Some(id)).then_some((i, raw))
    })
}

/// Date PDF en UTC : « D:20261109183000Z ».
pub fn pdf_date_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Jour civil depuis le nombre de jours (algorithme de H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("D:{y:04}{m:02}{d:02}{:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn new_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    format!("pdfreader-{t:x}-{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Champs communs à toute création : nom unique, auteur, dates, drapeau Imprimer.
fn stamp_new(raw: &Raw, author: &str) -> String {
    let name = new_name();
    let now = pdf_date_now();
    raw.set_string("NM", &name);
    raw.set_string("T", author);
    raw.set_string("M", &now);
    raw.set_string("CreationDate", &now);
    unsafe { raw.b.FPDFAnnot_SetFlags(raw.annot, FLAG_PRINT) };
    name
}

fn create<'a>(b: &'a dyn PdfiumLibraryBindings, page: &PdfPage, subtype: i32) -> Result<Raw<'a>> {
    let h = unsafe { b.FPDFPage_CreateAnnot(page.raw_handle(), subtype as _) };
    if h.is_null() {
        bail!("PDFium n'a pas pu créer l'annotation");
    }
    Ok(Raw { b, page: page.raw_handle(), annot: h })
}

fn set_rect(raw: &Raw, l: f32, b: f32, r: f32, t: f32) {
    let rect = FS_RECTF { left: l, bottom: b, right: r, top: t };
    unsafe { raw.b.FPDFAnnot_SetRect(raw.annot, &rect) };
}

/// Retire l'apparence actuelle et l'indicateur de PDFium : il en génère une neuve au prochain
/// rendu, avec la couleur, l'opacité et l'épaisseur à jour.
fn regenerate(raw: &Raw) {
    unsafe { raw.b.FPDFAnnot_SetAP(raw.annot, 0, std::ptr::null()) };
    // FPDFAnnot ne sait pas supprimer une clé : une chaîne vide n'est pas un booléen vrai.
    if unsafe { raw.b.FPDFAnnot_HasKey(raw.annot, PDFIUM_GENERATED) } != 0 {
        raw.set_string(PDFIUM_GENERATED, "");
    }
}

/// Un rendu à petite échelle fait générer les apparences manquantes par PDFium.
fn render_for_ap(page: &PdfPage) -> Result<()> {
    crate::render_page(page, 0.25).map(|_| ())
}

/// Surligne, souligne, barre ou ondule : un rectangle par ligne, en points PDF
/// (gauche, bas, droite, haut ; origine en bas à gauche, comme la sélection convertie).
pub fn add_markup(page: &mut PdfPage, kind: &str, rects: &[[f32; 4]], rgb: [u8; 3], opacity: f32, author: &str) -> Result<String> {
    let Some(subtype) = subtype_of(kind) else { bail!("type de marquage inconnu : {kind}") };
    if rects.is_empty() {
        bail!("sélection vide");
    }
    let b = raw_bindings();
    let name = {
        let raw = create(b, page, subtype)?;
        let (mut l, mut bt, mut r, mut t) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &[x0, y0, x1, y1] in rects {
            // Ordre attendu : haut-gauche, haut-droit, bas-gauche, bas-droit.
            let q = FS_QUADPOINTSF { x1: x0, y1, x2: x1, y2: y1, x3: x0, y3: y0, x4: x1, y4: y0 };
            unsafe { b.FPDFAnnot_AppendAttachmentPoints(raw.annot, &q) };
            l = l.min(x0);
            bt = bt.min(y0);
            r = r.max(x1);
            t = t.max(y1);
        }
        set_rect(&raw, l, bt, r, t);
        raw.set_color(rgb, opacity);
        stamp_new(&raw, author)
    };
    render_for_ap(page)?;
    Ok(name)
}

/// Note (icône de commentaire) dont le coin haut gauche est en (`x`, `y`) depuis le haut.
pub fn add_note(page: &mut PdfPage, x: f32, y: f32, contents: &str, rgb: [u8; 3], author: &str) -> Result<String> {
    let b = raw_bindings();
    let page_h = page.height().value;
    let name = {
        let raw = create(b, page, TEXT)?;
        let top = page_h - y;
        set_rect(&raw, x, top - 20.0, x + 20.0, top);
        raw.set_color(rgb, 1.0);
        raw.set_string("Contents", contents);
        raw.set_string("Name", "Comment");
        stamp_new(&raw, author)
    };
    render_for_ap(page)?;
    Ok(name)
}

/// Dessin à main levée : un ou plusieurs tracés, points depuis le haut à gauche.
pub fn add_ink(page: &mut PdfPage, strokes: &[Vec<[f32; 2]>], rgb: [u8; 3], opacity: f32, width: f32, author: &str) -> Result<String> {
    let strokes: Vec<&Vec<[f32; 2]>> = strokes.iter().filter(|s| !s.is_empty()).collect();
    if strokes.is_empty() {
        bail!("tracé vide");
    }
    let b = raw_bindings();
    let page_h = page.height().value;
    let width = width.clamp(0.25, 48.0);
    let name = {
        let raw = create(b, page, INK)?;
        let (mut l, mut bt, mut r, mut t) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for s in &strokes {
            let pts: Vec<FS_POINTF> = s.iter().take(20_000).map(|p| FS_POINTF { x: p[0], y: page_h - p[1] }).collect();
            for p in &pts {
                l = l.min(p.x);
                r = r.max(p.x);
                bt = bt.min(p.y);
                t = t.max(p.y);
            }
            unsafe { b.FPDFAnnot_AddInkStroke(raw.annot, pts.as_ptr(), pts.len()) };
        }
        let pad = width / 2.0 + 1.0;
        set_rect(&raw, l - pad, bt - pad, r + pad, t + pad);
        unsafe { b.FPDFAnnot_SetBorder(raw.annot, 0.0, 0.0, width) };
        raw.set_color(rgb, opacity);
        stamp_new(&raw, author)
    };
    render_for_ap(page)?;
    Ok(name)
}

/// Modification d'un commentaire existant. Les champs absents ne changent pas.
#[derive(Debug, Default, serde::Deserialize)]
pub struct AnnotPatch {
    pub color: Option<[u8; 3]>,
    pub opacity: Option<f32>,
    pub width: Option<f32>,
    pub contents: Option<String>,
}

pub fn update(page: &mut PdfPage, id: &str, patch: &AnnotPatch) -> Result<()> {
    let b = raw_bindings();
    {
        let Some((_, raw)) = find(b, page, id) else { bail!("commentaire introuvable") };
        if !is_comment(raw.subtype()) {
            bail!("ce n'est pas un commentaire");
        }
        if patch.color.is_some() || patch.opacity.is_some() || patch.width.is_some() {
            // L'apparence d'un tampon (texte, coche, signature, tampon d'un autre logiciel) ne
            // se régénère pas : la retirer l'effacerait.
            if raw.subtype() == STAMP {
                bail!("l'aspect de ce commentaire ne peut pas être modifié");
            }
            // Lire l'état actuel AVANT de retirer l'apparence (la couleur peut venir d'elle).
            let rgb = patch.color.or_else(|| raw.color()).unwrap_or([255, 225, 77]);
            let opacity = patch.opacity.unwrap_or_else(|| raw.opacity());
            // PDFium refuse de changer la couleur tant qu'une apparence existe.
            regenerate(&raw);
            raw.set_color(rgb, opacity);
            if let Some(w) = patch.width {
                unsafe { b.FPDFAnnot_SetBorder(raw.annot, 0.0, 0.0, w.clamp(0.25, 48.0)) };
            }
        }
        if let Some(c) = &patch.contents {
            raw.set_string("Contents", c);
        }
        raw.set_string("M", &pdf_date_now());
    }
    render_for_ap(page)
}

pub fn delete(page: &mut PdfPage, id: &str) -> Result<()> {
    let b = raw_bindings();
    let index = {
        let Some((i, raw)) = find(b, page, id) else { bail!("commentaire introuvable") };
        if !is_comment(raw.subtype()) {
            bail!("ce n'est pas un commentaire");
        }
        i
    };
    // La bulle (/Popup) liée disparaît avec son commentaire : on la retire aussi.
    let popup = {
        let raw = open_annot(b, page, index);
        raw.and_then(|r| {
            let p = unsafe { b.FPDFAnnot_GetLinkedAnnot(r.annot, "Popup") };
            if p.is_null() {
                return None;
            }
            let idx = unsafe { b.FPDFPage_GetAnnotIndex(page.raw_handle(), p) };
            unsafe { b.FPDFPage_CloseAnnot(p) };
            (idx >= 0).then_some(idx)
        })
    };
    if unsafe { b.FPDFPage_RemoveAnnot(page.raw_handle(), index) } == 0 {
        bail!("suppression refusée par PDFium");
    }
    if let Some(p) = popup {
        let p = if p > index { p - 1 } else { p };
        unsafe { b.FPDFPage_RemoveAnnot(page.raw_handle(), p) };
    }
    Ok(())
}

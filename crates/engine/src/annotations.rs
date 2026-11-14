//! M2, lot « annotations » : lire, créer, modifier et supprimer les commentaires d'une page.
//!
//! Tout passe par l'API brute de PDFium (`FPDFAnnot_*`) : elle couvre l'opacité (/CA), les
//! tracés d'encre et le retrait d'une apparence, que pdfium-render n'expose pas tous.
//! Coordonnées échangées avec l'interface : points PDF depuis le HAUT à gauche de la page.
//!
//! Apparences : PDFium génère lui-même l'apparence (/AP) des surlignages, soulignés, barrés,
//! ondulés, notes, rectangles, ellipses et tracés d'encre au rendu suivant. Après une
//! modification, on retire l'ancienne apparence pour qu'il la régénère (voir `regenerate`).
//!
//! M3 : formes, réponses et statuts. PDFium ne sait ni générer l'apparence d'une ligne ou d'un
//! polygone, ni écrire leurs coordonnées (/L, /Vertices) : lignes, flèches, polygones et nuages
//! sont des tracés d'encre marqués de leur nature (clé privée). Il ne sait pas non plus écrire une
//! référence (/IRT) : nos réponses sont reliées à leur commentaire par une clé privée ; les fils et
//! statuts écrits par d'autres logiciels (/IRT, /State) sont lus normalement.

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
#[serde(rename_all = "camelCase")]
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
    /// Zone de texte ou légende : cadre [x, y, largeur, hauteur minimale] et point désigné.
    pub text_box: Option<[f32; 4]>,
    pub anchor: Option<[f32; 2]>,
    /// Zone de texte avec un fond blanc.
    pub filled: bool,
    /// Statut de révision : accepted, rejected, cancelled, completed (absent : aucun).
    pub status: Option<String>,
    /// Coché (« marqué ») dans la liste des commentaires.
    pub marked: bool,
    /// Rectangle ou ellipse rempli.
    pub fill: Option<[u8; 3]>,
}

/// Clés privées de PDFReader.
const REPLY_KEY: &str = "PDFReaderReplyTo";
const STATE_KEY: &str = "PDFReaderState";
const MARKED_KEY: &str = "PDFReaderMarked";
pub const STATUSES: [&str; 4] = ["accepted", "rejected", "cancelled", "completed"];

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
        // Rectangle et ellipse : /C est la couleur du contour (l'intérieur est /IC).
        let fill_first = matches!(self.subtype(), HIGHLIGHT | TEXT);
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

    fn interior(&self) -> Option<[u8; 3]> {
        let (mut r, mut g, mut bl, mut a) = (0u32, 0u32, 0u32, 0u32);
        if unsafe { self.b.FPDFAnnot_GetColor(self.annot, 1, &mut r, &mut g, &mut bl, &mut a) } != 0 {
            return Some([r as u8, g as u8, bl as u8]);
        }
        // Apparence présente : le remplissage du premier tracé rempli.
        let n = unsafe { self.b.FPDFAnnot_GetObjectCount(self.annot) };
        for i in 0..n.min(16) {
            let obj = unsafe { self.b.FPDFAnnot_GetObject(self.annot, i) };
            if obj.is_null() {
                continue;
            }
            let (mut mode, mut stroke) = (0, 0);
            let filled = unsafe { self.b.FPDFPath_GetDrawMode(obj, &mut mode, &mut stroke) } != 0 && mode != 0;
            if filled && unsafe { self.b.FPDFPageObj_GetFillColor(obj, &mut r, &mut g, &mut bl, &mut a) } != 0 && a > 0 {
                return Some([r as u8, g as u8, bl as u8]);
            }
        }
        None
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
            raw.string(REPLY_KEY).filter(|s| !s.is_empty())
        } else {
            let p = Raw { b: raw.b, page: raw.page, annot: parent };
            let idx = unsafe { raw.b.FPDFPage_GetAnnotIndex(raw.page, parent) };
            Some(p.string("NM").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("#{idx}")))
        }
    };
    let id = raw.string("NM").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("#{index}"));
    // Nos tampons « Remplir et signer » portent leur nature dans une clé privée.
    let kind = match (subtype, raw.string(crate::fill::KIND_KEY).as_deref()) {
        (STAMP, Some("text")) => "text",
        (STAMP, Some("textbox")) => "textbox",
        (STAMP, Some("callout")) => "callout",
        (STAMP, Some("check" | "cross")) => "mark",
        (STAMP, Some("signature" | "initials")) => "signature",
        (INK, Some("line")) => "line",
        (INK, Some("arrow")) => "arrow",
        (INK, Some("polygon")) => "polygon",
        (INK, Some("polyline")) => "polyline",
        (INK, Some("cloud")) => "cloud",
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
        text_box: raw.string("PDFReaderBox").and_then(|s| floats::<4>(&s)),
        anchor: raw.string("PDFReaderAnchor").and_then(|s| floats::<2>(&s)),
        filled: raw.string("PDFReaderFill").is_some(),
        status: raw.string(STATE_KEY).filter(|s| STATUSES.contains(&s.as_str())),
        marked: raw.string(MARKED_KEY).as_deref() == Some("1"),
        fill: if matches!(subtype, SQUARE | CIRCLE) { raw.interior() } else { None },
    })
}

/// Statut écrit par un autre logiciel : une réponse portant /State (modèle Review ou Marked).
fn foreign_state(raw: &Raw) -> Option<(String, &'static str)> {
    let state = raw.string("State")?;
    let model = raw.string("StateModel").unwrap_or_default();
    let v = match (model.as_str(), state.as_str()) {
        ("Marked", "Marked") => "marked",
        ("Marked", _) => "unmarked",
        (_, "Accepted") => "accepted",
        (_, "Rejected") => "rejected",
        (_, "Cancelled") => "cancelled",
        (_, "Completed") => "completed",
        _ => "none",
    };
    Some((state, v))
}

fn floats<const N: usize>(s: &str) -> Option<[f32; N]> {
    let v: Vec<f32> = s.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    v.try_into().ok()
}

/// Commentaires d'une page.
pub fn list(page: &PdfPage, page_index: i32) -> Vec<Annot> {
    let b = raw_bindings();
    let page_h = page.height().value;
    let mut out = Vec::new();
    let mut states: Vec<(String, &'static str, String)> = Vec::new();
    for i in 0..count(page).min(5000) {
        let Some(raw) = open_annot(b, page, i) else { continue };
        let Some(a) = info(&raw, i, page_index, page_h) else { continue };
        if let (Some(parent), Some((_, v))) = (a.reply_to.clone(), foreign_state(&raw)) {
            states.push((parent, v, a.modified.clone().unwrap_or_default()));
            continue;
        }
        out.push(a);
    }
    // Le statut le plus récent l'emporte (dates PDF comparables comme des chaînes).
    states.sort_by(|x, y| x.2.cmp(&y.2));
    for (parent, v, _) in states {
        if let Some(a) = out.iter_mut().find(|a| a.id == parent) {
            match v {
                "marked" => a.marked = true,
                "unmarked" => a.marked = false,
                "none" => a.status = None,
                s => a.status = Some(s.to_string()),
            }
        }
    }
    out
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
    add_ink_kind(page, strokes, rgb, opacity, width, author, None)
}

fn add_ink_kind(page: &mut PdfPage, strokes: &[Vec<[f32; 2]>], rgb: [u8; 3], opacity: f32, width: f32, author: &str, kind: Option<&str>) -> Result<String> {
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
        if let Some(k) = kind {
            raw.set_string(crate::fill::KIND_KEY, k);
        }
        stamp_new(&raw, author)
    };
    render_for_ap(page)?;
    Ok(name)
}

/* ------------------------------------------------------------------ formes */

/// Festons d'un nuage le long d'un polygone fermé (points PDF) : un demi-cercle par segment de
/// longueur ~2r, bombé vers l'extérieur.
fn cloud_path(poly: &[[f32; 2]], r: f32) -> Vec<[f32; 2]> {
    let n = poly.len();
    // Sens du polygone (aire signée) : l'extérieur est à droite pour un sens trigonométrique.
    let area: f32 = (0..n).map(|i| {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        a[0] * b[1] - b[0] * a[1]
    }).sum();
    let out_sign = if area > 0.0 { -1.0 } else { 1.0 };
    let mut pts = Vec::new();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 0.5 {
            continue;
        }
        let k = ((len / (2.0 * r)).round() as usize).clamp(1, 400);
        let seg = len / k as f32;
        let (ux, uy) = (dx / len, dy / len);
        // Normale sortante.
        let (nx, ny) = (uy * out_sign, -ux * out_sign);
        for j in 0..k {
            let (sx, sy) = (a[0] + ux * seg * j as f32, a[1] + uy * seg * j as f32);
            let (cx, cy) = (sx + ux * seg / 2.0, sy + uy * seg / 2.0);
            let rr = seg / 2.0;
            for t in 0..=8 {
                // De l'angle « arrière » (-u) à l'angle « avant » (+u) en passant par la normale.
                let th = std::f32::consts::PI * t as f32 / 8.0;
                let (c, s) = (th.cos(), th.sin());
                pts.push([cx - ux * rr * c + nx * rr * s, cy - uy * rr * c + ny * rr * s]);
            }
        }
    }
    if let Some(&first) = pts.first() {
        pts.push(first);
    }
    pts
}

/// Forme dessinée : `points` depuis le haut à gauche de la page. Rectangle et ellipse : deux
/// coins opposés (commentaires standards, remplissage facultatif). Ligne et flèche : départ et
/// arrivée. Polygone, polyligne, nuage : les sommets.
#[allow(clippy::too_many_arguments)]
pub fn add_shape(page: &mut PdfPage, kind: &str, points: &[[f32; 2]], rgb: [u8; 3], opacity: f32, width: f32, fill: Option<[u8; 3]>, author: &str) -> Result<String> {
    let page_h = page.height().value;
    let width = width.clamp(0.25, 48.0);
    let pts: Vec<[f32; 2]> = points.iter().take(2000).copied().collect();
    let need = match kind {
        "square" | "circle" | "line" | "arrow" => 2,
        "polyline" => 2,
        "polygon" | "cloud" => 3,
        _ => bail!("forme inconnue : {kind}"),
    };
    if pts.len() < need {
        bail!("pas assez de points pour cette forme");
    }
    match kind {
        "square" | "circle" => {
            let b = raw_bindings();
            let (x0, x1) = (pts[0][0].min(pts[1][0]), pts[0][0].max(pts[1][0]));
            let (y0, y1) = (pts[0][1].min(pts[1][1]), pts[0][1].max(pts[1][1]));
            if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
                bail!("forme trop petite");
            }
            let name = {
                let raw = create(b, page, if kind == "square" { SQUARE } else { CIRCLE })?;
                set_rect(&raw, x0, page_h - y1, x1, page_h - y0);
                unsafe { b.FPDFAnnot_SetBorder(raw.annot, 0.0, 0.0, width) };
                raw.set_color(rgb, opacity);
                if let Some(f) = fill {
                    let a = (opacity.clamp(0.05, 1.0) * 255.0).round() as u32;
                    unsafe { b.FPDFAnnot_SetColor(raw.annot, 1, f[0] as u32, f[1] as u32, f[2] as u32, a) };
                }
                stamp_new(&raw, author)
            };
            render_for_ap(page)?;
            Ok(name)
        }
        "line" => add_ink_kind(page, &[vec![pts[0], pts[1]]], rgb, opacity, width, author, Some("line")),
        "arrow" => {
            let ([ax, ay], [bx, by]) = (pts[0], pts[1]);
            let (dx, dy) = (bx - ax, by - ay);
            let len = (dx * dx + dy * dy).sqrt();
            if len < 2.0 {
                bail!("flèche trop courte");
            }
            let (ux, uy) = (dx / len, dy / len);
            let head = (width * 4.0 + 6.0).min(len * 0.6);
            let (hx, hy) = (bx - ux * head, by - uy * head);
            let (px, py) = (-uy * head * 0.5, ux * head * 0.5);
            let strokes = vec![vec![[ax, ay], [bx, by]], vec![[hx + px, hy + py], [bx, by], [hx - px, hy - py]]];
            add_ink_kind(page, &strokes, rgb, opacity, width, author, Some("arrow"))
        }
        "polyline" => add_ink_kind(page, &[pts], rgb, opacity, width, author, Some("polyline")),
        "polygon" => {
            let mut closed = pts.clone();
            closed.push(pts[0]);
            add_ink_kind(page, &[closed], rgb, opacity, width, author, Some("polygon"))
        }
        _ => {
            // Nuage : calculé en coordonnées PDF (y vers le haut), puis ramené depuis le haut.
            let poly: Vec<[f32; 2]> = pts.iter().map(|p| [p[0], page_h - p[1]]).collect();
            let r = (width * 3.0).max(6.0);
            let path: Vec<[f32; 2]> = cloud_path(&poly, r).into_iter().map(|p| [p[0], page_h - p[1]]).collect();
            add_ink_kind(page, &[path], rgb, opacity, width, author, Some("cloud"))
        }
    }
}

/* ------------------------------------------------------------------ réponses et statuts */

/// Réponse à un commentaire : une note sans apparence (invisible sur la page, comme dans les
/// autres lecteurs), reliée à son commentaire.
pub fn add_reply(page: &mut PdfPage, parent: &str, contents: &str, author: &str) -> Result<String> {
    if contents.trim().is_empty() {
        bail!("réponse vide");
    }
    let b = raw_bindings();
    let (rect, parent_id) = {
        let Some((_, p)) = find(b, page, parent) else { bail!("commentaire introuvable") };
        let r = p.rect().unwrap_or(FS_RECTF { left: 0.0, top: 20.0, right: 20.0, bottom: 0.0 });
        let id = p.string("NM").filter(|s| !s.is_empty());
        (r, id)
    };
    let Some(parent_id) = parent_id else { bail!("ce commentaire n'a pas d'identifiant : enregistrez puis réessayez") };
    let raw = create(b, page, TEXT)?;
    let (l, t) = (rect.left.min(rect.right), rect.top.max(rect.bottom));
    set_rect(&raw, l, t - 20.0, l + 20.0, t);
    raw.set_string("Contents", contents);
    raw.set_string("Name", "Comment");
    raw.set_string(REPLY_KEY, &parent_id);
    let name = stamp_new(&raw, author);
    // Apparence vide : la réponse ne se dessine pas sur la page.
    let empty: Vec<u16> = vec![0];
    unsafe { b.FPDFAnnot_SetAP(raw.annot, 0, empty.as_ptr()) };
    Ok(name)
}

/// Statut de révision (`Some("")` : aucun) et coche d'un commentaire.
pub fn set_status(page: &mut PdfPage, id: &str, status: Option<&str>, marked: Option<bool>) -> Result<()> {
    let b = raw_bindings();
    let Some((_, raw)) = find(b, page, id) else { bail!("commentaire introuvable") };
    if let Some(s) = status {
        if !s.is_empty() && !STATUSES.contains(&s) {
            bail!("statut inconnu : {s}");
        }
        raw.set_string(STATE_KEY, s);
    }
    if let Some(m) = marked {
        raw.set_string(MARKED_KEY, if m { "1" } else { "" });
    }
    raw.set_string("M", &pdf_date_now());
    Ok(())
}

/// Modification d'un commentaire existant. Les champs absents ne changent pas.
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
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
    // Réponses (et statuts) de ce commentaire : supprimées aussi, en partant de la fin.
    if !id.starts_with('#') {
        let replies: Vec<i32> = (0..count(page))
            .filter(|&i| {
                open_annot(b, page, i).is_some_and(|r| {
                    let linked = unsafe { b.FPDFAnnot_GetLinkedAnnot(r.annot, "IRT") };
                    let by_link = !linked.is_null() && {
                        let p = Raw { b, page: r.page, annot: linked };
                        p.string("NM").as_deref() == Some(id)
                    };
                    by_link || r.string(REPLY_KEY).as_deref() == Some(id)
                })
            })
            .collect();
        for i in replies.into_iter().rev() {
            unsafe { b.FPDFPage_RemoveAnnot(page.raw_handle(), i) };
        }
    }
    Ok(())
}

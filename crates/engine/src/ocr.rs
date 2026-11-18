//! Phase 2, « Reconnaître le texte (OCR) » : la page est rendue en image, le moteur OCR intégré à
//! Windows (Windows.Media.Ocr, hors ligne, langues installées avec Windows) y lit les mots, et
//! chaque mot est ajouté en texte invisible exactement par-dessus. La page garde son aspect mais
//! devient cherchable, sélectionnable et copiable (PDF « cherchable »).
//!
//! Les objets ajoutés portent la marque « PDFReaderOCR » : reconnaître de nouveau remplace
//! l'ancienne couche, et on peut la retirer.

use std::ffi::c_ulong;

use anyhow::{Result, bail};
use pdfium_render::prelude::*;
use serde::Serialize;

use crate::Frame;
use crate::pagetext::{Family, FontCache, TextStyle};

const MARK: &str = "PDFReaderOCR";
const TEXT_OBJECT: i32 = 1;
const INVISIBLE: i32 = 3;

/// Résolution visée pour la reconnaissance (points par pouce).
const OCR_DPI: f32 = 300.0;
/// Plus grand côté accepté par le moteur de Windows, et nombre de pixels au plus.
const MAX_SIDE: f32 = 10_000.0;
const MAX_PIXELS: f32 = 40.0e6;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrLanguage {
    /// Étiquette BCP-47 (« fr-FR »).
    pub tag: String,
    /// Nom dans la langue de Windows.
    pub name: String,
}

/// Mot reconnu, en points de la page affichée depuis le haut à gauche.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Une ligne de mots, dans l'ordre de lecture.
pub type OcrLine = Vec<OcrWord>;

/// Lignes lues par Windows : mots et leur rectangle en pixels de l'image.
type RawLines = Vec<Vec<(String, [f32; 4])>>;

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use windows::core::HSTRING;

    fn init() {
        // L'espace multithread de COM reste en vie pour tout le processus : sinon il disparaît
        // avec le dernier fil qui l'utilise, et les fabriques gardées en cache par `windows`
        // pointeraient vers des objets libérés au prochain appel.
        static MTA: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        MTA.get_or_init(|| {
            let _ = unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() };
        });
        // Déjà initialisé sur ce fil : sans conséquence.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    }

    /// Chaque appel tourne sur un fil à lui, initialisé en multithread : sur un fil déjà
    /// initialisé en appartement unique, attendre le résultat asynchrone bloquerait.
    fn on_mta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
        // Pile large : le moteur de Windows en consomme beaucoup.
        std::thread::Builder::new()
            .stack_size(16 << 20)
            .spawn(move || {
                init();
                f()
            })?
            .join()
        .map_err(|_| anyhow::anyhow!("ocr_crashed"))
    }

    pub fn languages() -> Vec<OcrLanguage> {
        on_mta(|| {
            OcrEngine::AvailableRecognizerLanguages()
                .map(|v| v.into_iter().filter_map(|l| Some(OcrLanguage { tag: l.LanguageTag().ok()?.to_string(), name: l.DisplayName().ok()?.to_string() })).collect())
                .unwrap_or_default()
        })
        .unwrap_or_default()
    }

    fn engine(lang: Option<&str>) -> Result<OcrEngine> {
        let e = match lang {
            Some(tag) if !tag.is_empty() => {
                let l = Language::CreateLanguage(&HSTRING::from(tag))?;
                if !OcrEngine::IsLanguageSupported(&l)? {
                    bail!("ocr_language: {tag}");
                }
                OcrEngine::TryCreateFromLanguage(&l)
            }
            _ => OcrEngine::TryCreateFromUserProfileLanguages(),
        };
        e.map_err(|_| anyhow::anyhow!("ocr_unavailable"))
    }

    /// Mots d'une image BGRA (pixels), lignes dans l'ordre de lecture.
    pub fn recognize(bgra: Vec<u8>, width: u32, height: u32, lang: Option<String>) -> Result<RawLines> {
        on_mta(move || recognize_here(&bgra, width, height, lang.as_deref()))?
    }

    fn recognize_here(bgra: &[u8], width: u32, height: u32, lang: Option<&str>) -> Result<RawLines> {
        let engine = engine(lang)?;
        let buffer = CryptographicBuffer::CreateFromByteArray(bgra)?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width as i32, height as i32)?;
        let result = engine.RecognizeAsync(&bitmap)?.join()?;
        let mut out = Vec::new();
        for line in result.Lines()? {
            let mut words = Vec::new();
            for w in line.Words()? {
                let r = w.BoundingRect()?;
                words.push((w.Text()?.to_string(), [r.X, r.Y, r.Width, r.Height]));
            }
            if !words.is_empty() {
                out.push(words);
            }
        }
        Ok(out)
    }
}

/// Langues que l'OCR de Windows sait lire sur cette machine.
pub fn languages() -> Vec<OcrLanguage> {
    #[cfg(windows)]
    {
        win::languages()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Reconnaît le texte d'une page (telle qu'elle s'affiche). `lang` : étiquette d'une langue
/// installée, ou `None` pour celles du profil Windows.
pub fn recognize_page(page: &PdfPage, lang: Option<&str>) -> Result<Vec<OcrLine>> {
    let frame = Frame::of(page);
    let (w, h) = (frame.width(), frame.height());
    let mut scale = OCR_DPI / 72.0;
    scale = scale.min(MAX_SIDE / w.max(h)).min((MAX_PIXELS / (w * h)).sqrt());
    let mut tile = crate::render_page(page, scale)?;
    // RGBA → BGRA.
    for px in tile.rgba.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    #[cfg(windows)]
    let lines = win::recognize(tile.rgba, tile.width as u32, tile.height as u32, lang.map(str::to_string))?;
    #[cfg(not(windows))]
    let lines: RawLines = {
        let _ = lang;
        bail!("ocr_unavailable")
    };
    Ok(lines
        .into_iter()
        .map(|l| l.into_iter().filter(|(t, _)| !t.trim().is_empty()).map(|(text, r)| OcrWord { text, x: r[0] / scale, y: r[1] / scale, w: r[2] / scale, h: r[3] / scale }).collect::<Vec<_>>())
        .filter(|l| !l.is_empty())
        .collect())
}

fn utf16(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

unsafe fn is_ours(b: &dyn PdfiumLibraryBindings, obj: FPDF_PAGEOBJECT) -> bool {
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
        utf16(&buf) == MARK
    })
}

/// La page contient-elle déjà du texte (hors couche OCR de PDFReader) ? Une page numérisée n'en a
/// pas ; une page déjà passée à l'OCR par un autre logiciel a du texte invisible.
pub fn has_text(page: &PdfPage) -> bool {
    let b = raw_bindings();
    let h = page.raw_handle();
    let tp = unsafe { b.FPDFText_LoadPage(h) };
    let mut found = false;
    let count = unsafe { b.FPDFPage_CountObjects(h) };
    for i in 0..count {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT || unsafe { is_ours(b, obj) } {
            continue;
        }
        let len = unsafe { b.FPDFTextObj_GetText(obj, tp, std::ptr::null_mut(), 0) };
        if len > 4 {
            found = true;
            break;
        }
    }
    if !tp.is_null() {
        unsafe { b.FPDFText_ClosePage(tp) };
    }
    found
}

/// Retire la couche OCR ajoutée par PDFReader ; renvoie le nombre d'objets retirés.
pub fn remove_layer(page: &PdfPage) -> Result<usize> {
    let b = raw_bindings();
    let h = page.raw_handle();
    let mut n = 0;
    for i in (0..unsafe { b.FPDFPage_CountObjects(h) }).rev() {
        let obj = unsafe { b.FPDFPage_GetObject(h, i) };
        if obj.is_null() || unsafe { b.FPDFPageObj_GetType(obj) } != TEXT_OBJECT || !unsafe { is_ours(b, obj) } {
            continue;
        }
        if unsafe { b.FPDFPage_RemoveObject(h, obj) } != 0 {
            unsafe { b.FPDFPageObj_Destroy(obj) };
            n += 1;
        }
    }
    if n > 0 && unsafe { b.FPDFPage_GenerateContent(h) } == 0 {
        bail!("contenu de la page non régénéré");
    }
    Ok(n)
}

/// Écrit les mots reconnus en texte invisible sur la page (remplace une couche précédente) ;
/// renvoie le nombre de mots écrits.
pub fn add_layer(doc: &PdfDocument, page: &PdfPage, fonts: &mut FontCache, lines: &[OcrLine]) -> Result<usize> {
    remove_layer(page)?;
    let b = raw_bindings();
    let frame = Frame::of(page);
    let ph = frame.height();
    let mut n = 0;
    for line in lines {
        // Une taille par ligne (la plus grande hauteur de mot) : la ligne se sélectionne d'un trait.
        let size = line.iter().map(|w| w.h).fold(0.0f32, f32::max).clamp(2.0, 400.0);
        let base = line.iter().map(|w| w.y + w.h).fold(0.0f32, f32::max);
        let last = line.len().saturating_sub(1);
        for (k, w) in line.iter().enumerate() {
            if w.w <= 0.0 {
                continue;
            }
            let style = TextStyle { family: Family::Sans, bold: false, italic: false, size, color: [0, 0, 0] };
            let obj = crate::pagetext::new_text_object(doc, fonts, w.text.trim(), &style)?;
            let (mut l, mut bt, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
            unsafe { b.FPDFPageObj_GetBounds(obj, &mut l, &mut bt, &mut r, &mut t) };
            let natural = (r - l).max(0.01);
            // Mot étiré à la largeur reconnue, posé sur la ligne de base (descente ≈ 0,2 em).
            let sx = (w.w / natural) as f64;
            let baseline = ph - base + size * 0.2;
            unsafe {
                if k < last {
                    // Espace finale : les mots restent séparés au copier-coller.
                    let txt: Vec<u16> = format!("{} ", w.text.trim()).encode_utf16().chain(std::iter::once(0)).collect();
                    b.FPDFText_SetText(obj, txt.as_ptr() as _);
                }
                b.FPDFPageObj_Transform(obj, sx, 0.0, 0.0, 1.0, (w.x - l * sx as f32) as f64, baseline as f64);
                frame.place(obj);
                b.FPDFTextObj_SetTextRenderMode(obj, INVISIBLE as _);
                b.FPDFPageObj_AddMark(obj, MARK);
                b.FPDFPage_InsertObject(page.raw_handle(), obj);
            }
            n += 1;
        }
    }
    if unsafe { b.FPDFPage_GenerateContent(page.raw_handle()) } == 0 {
        bail!("contenu de la page non régénéré");
    }
    Ok(n)
}

//! Impression native sous Windows (S13) : PDFium dessine directement dans le contexte GDI de
//! l'imprimante (`FPDF_RenderPage`), en vectoriel, sans passer par une image.
//!
//! Chaque page est d'abord copiée dans un document temporaire, puis « aplatie » pour
//! l'impression (`FPDFPage_Flatten`) : c'est le seul moyen d'imprimer en vectoriel les champs de
//! formulaire remplis (PDFium ne les dessine sur un contexte GDI qu'une fois fondus dans la page)
//! et cela applique la règle de la norme : seules les annotations marquées « Imprimer » sortent.
//! Le document ouvert n'est jamais modifié.
//!
//! Si l'auteur n'autorise que l'impression en basse qualité, la page est imprimée comme une image
//! à 150 ppp.

use anyhow::{Context, Result, bail};
use pdfium_render::prelude::*;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateDCW, DEVMODE_DUPLEX, DEVMODEW, DIB_RGB_COLORS, DM_COPIES, DM_DUPLEX, DM_IN_BUFFER, DM_ORIENTATION, DM_OUT_BUFFER,
    DeleteDC, GetDeviceCaps, HDC, HORZRES, LOGPIXELSX, LOGPIXELSY, PHYSICALHEIGHT, PHYSICALOFFSETX, PHYSICALOFFSETY, PHYSICALWIDTH, ResetDCW, SRCCOPY, StretchDIBits,
    VERTRES,
};
use windows::Win32::Graphics::Printing::{ClosePrinter, DocumentPropertiesW, EnumPrintersW, GetDefaultPrinterW, OpenPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_HANDLE, PRINTER_INFO_4W};
use windows::Win32::Storage::Xps::{AbortDoc, DC_DUPLEX, DOCINFOW, DeviceCapabilitiesW, EndDoc, EndPage, StartDocW, StartPage};
use windows::core::{HSTRING, PCWSTR, PWSTR};

/// FPDF_PRINTING : rendu pour l'impression (pas de lissage d'écran).
const FPDF_PRINTING: i32 = 0x800;
const FPDF_ANNOT: i32 = 0x01;
/// FPDFPage_Flatten : ne fondre que les annotations marquées « Imprimer ».
const FLAT_PRINT: i32 = 2;
const WIDGET: i32 = 20;
const LOW_QUALITY_DPI: f32 = 150.0;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
    /// L'imprimante sait imprimer en recto verso.
    pub duplex: bool,
}

/// Imprimantes installées (locales et connexions réseau), l'imprimante par défaut en premier.
pub fn printers() -> Vec<PrinterInfo> {
    let default = default_printer();
    let mut out = Vec::new();
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut count);
        if needed == 0 {
            return out;
        }
        // Tampon aligné sur 8 octets : il contient des structures avec des pointeurs.
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, needed as usize);
        if EnumPrintersW(flags, PCWSTR::null(), 4, Some(bytes), &mut needed, &mut count).is_err() {
            return out;
        }
        let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
        for info in infos {
            if info.pPrinterName.is_null() {
                continue;
            }
            let name = info.pPrinterName.to_string().unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let duplex = DeviceCapabilitiesW(&HSTRING::from(&name), PCWSTR::null(), DC_DUPLEX, None, None) == 1;
            out.push(PrinterInfo { is_default: default.as_deref() == Some(name.as_str()), name, duplex });
        }
    }
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// Taille de la feuille par défaut de l'imprimante, en points, en portrait (pour l'aperçu).
pub fn sheet_size(printer: &str) -> Option<[f32; 2]> {
    let name = HSTRING::from(printer);
    let devmode = load_devmode(&name).ok()?;
    unsafe {
        let hdc = CreateDCW(PCWSTR::null(), &name, PCWSTR::null(), Some(devmode.as_ptr() as *const DEVMODEW));
        if hdc.is_invalid() {
            return None;
        }
        let cap = |i| GetDeviceCaps(Some(hdc), i) as f32;
        let (w, h) = (cap(PHYSICALWIDTH) / cap(LOGPIXELSX).max(1.0) * 72.0, cap(PHYSICALHEIGHT) / cap(LOGPIXELSY).max(1.0) * 72.0);
        let _ = DeleteDC(hdc);
        (w > 0.0 && h > 0.0).then_some([w.min(h), w.max(h)])
    }
}

fn default_printer() -> Option<String> {
    unsafe {
        let mut len = 0u32;
        let _ = GetDefaultPrinterW(None, &mut len);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if !GetDefaultPrinterW(Some(PWSTR(buf.as_mut_ptr())), &mut len).as_bool() {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Scale {
    /// Ajuster à la zone imprimable (agrandit ou réduit).
    Fit,
    /// Taille réelle (100 %).
    Actual,
    /// Taille réelle, réduite seulement si la page dépasse.
    Shrink,
    /// Pourcentage choisi (`custom_scale`).
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    /// Selon chaque page : portrait ou paysage.
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Duplex {
    None,
    /// Retourner sur le bord long (comme un livre).
    Long,
    /// Retourner sur le bord court (comme un bloc-notes).
    Short,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub printer: String,
    /// Pages à imprimer, dans l'ordre (index 0).
    pub pages: Vec<i32>,
    pub scale: Scale,
    /// Pourcentage pour `Scale::Custom`.
    #[serde(default = "hundred")]
    pub custom_scale: f32,
    pub orientation: Orientation,
    pub duplex: Duplex,
    #[serde(default = "one")]
    pub copies: u16,
    /// Imprimer les commentaires (surlignages, notes, dessins…). Les champs de formulaire et ce
    /// qui a été posé avec « Remplir et signer » sont toujours imprimés.
    pub comments: bool,
    /// Fichier de sortie, pour les imprimantes « fichier » (tests ; sinon le pilote le demande).
    #[serde(default)]
    pub output_file: Option<String>,
    #[serde(default)]
    pub title: String,
}

fn hundred() -> f32 {
    100.0
}
fn one() -> u16 {
    1
}

/// DEVMODE de l'imprimante (réglages par défaut de l'utilisateur), dans un tampon aligné.
fn load_devmode(printer: &HSTRING) -> Result<Vec<u64>> {
    unsafe {
        let mut h = PRINTER_HANDLE::default();
        OpenPrinterW(printer, &mut h, None).with_context(|| format!("imprimante introuvable : {printer}"))?;
        let size = DocumentPropertiesW(None, h, printer, None, None, 0);
        if size <= 0 {
            let _ = ClosePrinter(h);
            bail!("réglages de l'imprimante illisibles");
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8) + 1];
        let r = DocumentPropertiesW(None, h, printer, Some(buf.as_mut_ptr() as *mut DEVMODEW), None, DM_OUT_BUFFER.0);
        let _ = ClosePrinter(h);
        if r < 0 {
            bail!("réglages de l'imprimante illisibles");
        }
        Ok(buf)
    }
}

/// Fait valider par le pilote les réglages modifiés (il corrige ce qu'il ne sait pas faire).
fn validate_devmode(printer: &HSTRING, buf: &mut [u64]) {
    unsafe {
        let mut h = PRINTER_HANDLE::default();
        if OpenPrinterW(printer, &mut h, None).is_ok() {
            let p = buf.as_mut_ptr() as *mut DEVMODEW;
            DocumentPropertiesW(None, h, printer, Some(p), Some(p as *const DEVMODEW), (DM_IN_BUFFER | DM_OUT_BUFFER).0);
            let _ = ClosePrinter(h);
        }
    }
}

/// Une impression en cours. Les pages sont envoyées une à une (`page`), ce qui permet au thread
/// moteur de continuer à servir l'affichage entre deux pages. Abandonnée (`Drop`) sans `finish`,
/// l'impression est annulée.
pub struct PrintJob {
    hdc: HDC,
    printer: HSTRING,
    devmode: Vec<u64>,
    opts: PrintOptions,
    landscape: Option<bool>,
    finished: bool,
}

// Le contexte GDI n'est utilisé que par le thread moteur, qui possède la tâche.
unsafe impl Send for PrintJob {}

impl PrintJob {
    pub fn start(opts: &PrintOptions) -> Result<Self> {
        if opts.pages.is_empty() {
            bail!("aucune page à imprimer");
        }
        let printer = HSTRING::from(opts.printer.as_str());
        let mut devmode = load_devmode(&printer)?;
        unsafe {
            let dm = &mut *(devmode.as_mut_ptr() as *mut DEVMODEW);
            dm.dmFields |= DM_DUPLEX | DM_COPIES;
            dm.dmDuplex = DEVMODE_DUPLEX(match opts.duplex {
                Duplex::None => 1,
                Duplex::Long => 2,
                Duplex::Short => 3,
            });
            dm.Anonymous1.Anonymous1.dmCopies = opts.copies.clamp(1, 999) as i16;
            match opts.orientation {
                Orientation::Auto => {}
                o => {
                    dm.dmFields |= DM_ORIENTATION;
                    dm.Anonymous1.Anonymous1.dmOrientation = if o == Orientation::Landscape { 2 } else { 1 };
                }
            }
        }
        validate_devmode(&printer, &mut devmode);
        let title = HSTRING::from(if opts.title.is_empty() { "PDFReader" } else { opts.title.as_str() });
        let out = opts.output_file.as_deref().map(HSTRING::from);
        unsafe {
            let hdc = CreateDCW(PCWSTR::null(), &printer, PCWSTR::null(), Some(devmode.as_ptr() as *const DEVMODEW));
            if hdc.is_invalid() {
                bail!("imprimante indisponible : {}", opts.printer);
            }
            let info = DOCINFOW {
                cbSize: std::mem::size_of::<DOCINFOW>() as i32,
                lpszDocName: PCWSTR(title.as_ptr()),
                lpszOutput: out.as_ref().map(|s| PCWSTR(s.as_ptr())).unwrap_or(PCWSTR::null()),
                ..Default::default()
            };
            if StartDocW(hdc, &info) <= 0 {
                let _ = DeleteDC(hdc);
                bail!("l'imprimante a refusé le document (impression annulée ?)");
            }
            let landscape = match opts.orientation {
                Orientation::Auto => None,
                o => Some(o == Orientation::Landscape),
            };
            Ok(Self { hdc, printer, devmode, opts: opts.clone(), landscape, finished: false })
        }
    }

    /// Imprime une page du document. `vector = false` : image à 150 ppp (impression « basse
    /// qualité » seule autorisée par l'auteur).
    pub fn page(&mut self, doc: &PdfDocument, index: i32, vector: bool) -> Result<()> {
        let b = raw_bindings();
        let copy = FlatPage::new(b, doc, index, self.opts.comments)?;
        let (w_pt, h_pt) = unsafe { (b.FPDF_GetPageWidthF(copy.page), b.FPDF_GetPageHeightF(copy.page)) };
        if w_pt <= 0.0 || h_pt <= 0.0 {
            bail!("page {} illisible", index + 1);
        }
        unsafe {
            // Orientation automatique : la feuille suit chaque page.
            if self.opts.orientation == Orientation::Auto {
                let want = w_pt > h_pt;
                if self.landscape != Some(want) {
                    let dm = &mut *(self.devmode.as_mut_ptr() as *mut DEVMODEW);
                    dm.dmFields |= DM_ORIENTATION;
                    dm.Anonymous1.Anonymous1.dmOrientation = if want { 2 } else { 1 };
                    validate_devmode(&self.printer, &mut self.devmode);
                    let hdc = ResetDCW(self.hdc, self.devmode.as_ptr() as *const DEVMODEW);
                    if !hdc.is_invalid() {
                        self.hdc = hdc;
                    }
                    self.landscape = Some(want);
                }
            }
            let hdc = self.hdc;
            let cap = |i| GetDeviceCaps(Some(hdc), i) as f32;
            let (area_w, area_h) = (cap(HORZRES), cap(VERTRES));
            let (dpi_x, dpi_y) = (cap(LOGPIXELSX).max(1.0), cap(LOGPIXELSY).max(1.0));
            let fit = (area_w / w_pt).min(area_h / h_pt);
            // Pixels d'imprimante par point PDF, en x et en y.
            let (kx, ky) = match self.opts.scale {
                Scale::Fit => (fit, fit * dpi_y / dpi_x),
                Scale::Actual => (dpi_x / 72.0, dpi_y / 72.0),
                Scale::Shrink => {
                    let k = fit.min(dpi_x / 72.0);
                    (k, k * dpi_y / dpi_x)
                }
                Scale::Custom => {
                    let p = self.opts.custom_scale.clamp(10.0, 400.0) / 100.0;
                    (dpi_x / 72.0 * p, dpi_y / 72.0 * p)
                }
            };
            let (w, h) = ((w_pt * kx).round() as i32, (h_pt * ky).round() as i32);
            // Centré sur la feuille entière (et non sur la zone imprimable, parfois décentrée).
            let (phys_w, phys_h) = (cap(PHYSICALWIDTH).max(area_w), cap(PHYSICALHEIGHT).max(area_h));
            let x = ((phys_w - w as f32) / 2.0 - cap(PHYSICALOFFSETX)).round() as i32;
            let y = ((phys_h - h as f32) / 2.0 - cap(PHYSICALOFFSETY)).round() as i32;
            if StartPage(hdc) <= 0 {
                bail!("l'imprimante a refusé la page {}", index + 1);
            }
            if vector {
                b.FPDF_RenderPage(hdc, copy.page, x, y, w, h, 0, FPDF_PRINTING);
            } else {
                let bw = (w_pt / 72.0 * LOW_QUALITY_DPI).round().max(1.0) as i32;
                let bh = (h_pt / 72.0 * LOW_QUALITY_DPI).round().max(1.0) as i32;
                // FPDFBitmap_BGRx = 3 : 32 bits par pixel, comme le DIB déclaré plus bas.
                let bmp = b.FPDFBitmap_CreateEx(bw, bh, 3, std::ptr::null_mut(), 0);
                if bmp.is_null() {
                    EndPage(hdc);
                    bail!("mémoire insuffisante");
                }
                b.FPDFBitmap_FillRect(bmp, 0, 0, bw, bh, 0xFFFF_FFFF);
                b.FPDF_RenderPageBitmap(bmp, copy.page, 0, 0, bw, bh, 0, FPDF_PRINTING);
                let bmi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: b.FPDFBitmap_GetStride(bmp) / 4,
                        biHeight: -bh, // de haut en bas
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                StretchDIBits(hdc, x, y, w, h, 0, 0, bw, bh, Some(b.FPDFBitmap_GetBuffer(bmp) as *const _), &bmi, DIB_RGB_COLORS, SRCCOPY);
                b.FPDFBitmap_Destroy(bmp);
            }
            if EndPage(hdc) <= 0 {
                bail!("l'impression de la page {} a échoué", index + 1);
            }
        }
        Ok(())
    }

    /// Termine le document : il part à l'imprimante.
    pub fn finish(mut self) -> Result<()> {
        self.finished = true;
        if unsafe { EndDoc(self.hdc) } <= 0 {
            bail!("l'impression n'a pas pu être terminée");
        }
        Ok(())
    }
}

impl Drop for PrintJob {
    fn drop(&mut self) {
        unsafe {
            if !self.finished {
                AbortDoc(self.hdc);
            }
            let _ = DeleteDC(self.hdc);
        }
    }
}

/// Copie d'une page dans un document temporaire, aplatie pour l'impression.
struct FlatPage<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
}

impl<'a> FlatPage<'a> {
    fn new(b: &'a dyn PdfiumLibraryBindings, src: &PdfDocument, index: i32, comments: bool) -> Result<Self> {
        unsafe {
            let doc = b.FPDF_CreateNewDocument();
            if doc.is_null() {
                bail!("mémoire insuffisante");
            }
            let mut this = Self { b, doc, page: std::ptr::null_mut() };
            if b.FPDF_ImportPages(doc, src.raw_handle(), &(index + 1).to_string(), 0) == 0 {
                bail!("la page {} n'a pas pu être préparée", index + 1);
            }
            this.page = b.FPDF_LoadPage(doc, 0);
            if this.page.is_null() {
                bail!("la page {} n'a pas pu être préparée", index + 1);
            }
            if !comments {
                // Sans les commentaires : on garde les champs et ce qui a été posé avec « Remplir
                // et signer » (texte, coche, signature), qui font partie du document rempli.
                for i in (0..b.FPDFPage_GetAnnotCount(this.page)).rev() {
                    let a = b.FPDFPage_GetAnnot(this.page, i);
                    if a.is_null() {
                        continue;
                    }
                    let keep = b.FPDFAnnot_GetSubtype(a) as i32 == WIDGET || b.FPDFAnnot_HasKey(a, crate::fill::KIND_KEY) != 0;
                    b.FPDFPage_CloseAnnot(a);
                    if !keep {
                        b.FPDFPage_RemoveAnnot(this.page, i);
                    }
                }
            }
            // Un petit rendu fait générer par PDFium les apparences manquantes (surlignage d'un
            // autre logiciel sans /AP, par exemple) : l'aplatissement ne garde que les apparences.
            let tiny = b.FPDFBitmap_CreateEx(16, 16, 3, std::ptr::null_mut(), 0);
            if !tiny.is_null() {
                b.FPDF_RenderPageBitmap(tiny, this.page, 0, 0, 16, 16, 0, FPDF_ANNOT);
                b.FPDFBitmap_Destroy(tiny);
            }
            // 0 : échec ; 1 : fait ; 2 : rien à fondre.
            if b.FPDFPage_Flatten(this.page, FLAT_PRINT) == 0 {
                bail!("la page {} n'a pas pu être préparée", index + 1);
            }
            // La page chargée ne voit pas le contenu ajouté : on la recharge.
            b.FPDF_ClosePage(this.page);
            this.page = b.FPDF_LoadPage(doc, 0);
            if this.page.is_null() {
                bail!("la page {} n'a pas pu être préparée", index + 1);
            }
            Ok(this)
        }
    }
}

impl Drop for FlatPage<'_> {
    fn drop(&mut self) {
        unsafe {
            if !self.page.is_null() {
                self.b.FPDF_ClosePage(self.page);
            }
            self.b.FPDF_CloseDocument(self.doc);
        }
    }
}

/// Imprime d'une traite (outils en ligne de commande et tests).
pub fn print(doc: &PdfDocument, opts: &PrintOptions, vector: bool) -> Result<()> {
    let mut job = PrintJob::start(opts)?;
    for &i in &opts.pages {
        job.page(doc, i, vector)?;
    }
    job.finish()
}

//! Impression native vectorielle sous Windows : PDFium dessine directement dans le contexte GDI
//! de l'imprimante (FPDF_RenderPage), sans passer par une image.

use anyhow::{Result, bail};
use pdfium_render::prelude::*;
use windows::Win32::Graphics::Gdi::{CreateDCW, DeleteDC, GetDeviceCaps, HORZRES, VERTRES};
use windows::Win32::Storage::Xps::{DOCINFOW, EndDoc, EndPage, StartDocW, StartPage};
use windows::core::{HSTRING, PCWSTR};

/// FPDF_ANNOT (1) | FPDF_PRINTING (0x800) : imprime les annotations, mode impression.
const FLAGS: i32 = 0x01 | 0x800;

/// Imprime les pages `pages` (indices 0-based) sur l'imprimante `printer`.
/// `output_file` : pour les imprimantes « fichier » (Microsoft Print to PDF), chemin de sortie.
pub fn print_pages(doc: &PdfDocument, printer: &str, pages: &[i32], output_file: Option<&str>, title: &str) -> Result<()> {
    let b = raw_bindings();
    let printer_w = HSTRING::from(printer);
    let title_w = HSTRING::from(title);
    let out_w = output_file.map(HSTRING::from);
    unsafe {
        let hdc = CreateDCW(PCWSTR::null(), &printer_w, PCWSTR::null(), None);
        if hdc.is_invalid() {
            bail!("imprimante introuvable : {printer}");
        }
        let info = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(title_w.as_ptr()),
            lpszOutput: out_w.as_ref().map(|s| PCWSTR(s.as_ptr())).unwrap_or(PCWSTR::null()),
            ..Default::default()
        };
        if StartDocW(hdc, &info) <= 0 {
            let _ = DeleteDC(hdc);
            bail!("StartDoc a échoué");
        }
        let page_w = GetDeviceCaps(Some(hdc), HORZRES);
        let page_h = GetDeviceCaps(Some(hdc), VERTRES);
        for &i in pages {
            let page = doc.pages().get(i).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            // Ajuster à la feuille en gardant les proportions.
            let (pw, ph) = (page.width().value as f64, page.height().value as f64);
            let k = (page_w as f64 / pw).min(page_h as f64 / ph);
            let (w, h) = ((pw * k) as i32, (ph * k) as i32);
            let (x, y) = ((page_w - w) / 2, (page_h - h) / 2);
            StartPage(hdc);
            b.FPDF_RenderPage(hdc, page.raw_handle(), x, y, w, h, 0, FLAGS);
            EndPage(hdc);
        }
        EndDoc(hdc);
        let _ = DeleteDC(hdc);
    }
    Ok(())
}

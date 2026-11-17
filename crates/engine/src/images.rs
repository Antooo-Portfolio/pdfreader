//! Phase 2, « Créer un PDF depuis des images » : une page par image (PNG, JPEG, WebP, BMP, GIF,
//! TIFF). Un JPEG est intégré tel quel (pas de recompression, pas de perte) sauf s'il doit être
//! redressé (orientation EXIF des photos) ; les autres formats sont intégrés sans perte.

use std::io::Cursor;
use std::os::raw::{c_int, c_uchar, c_ulong, c_void};
use std::path::Path;

use anyhow::{Context, Result, bail};
use image::{ImageDecoder, ImageFormat, ImageReader, metadata::Orientation};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

/// Taille des pages créées pour les images.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageSize {
    /// A4, dans le sens de l'image (portrait ou paysage).
    A4,
    /// Lettre US, dans le sens de l'image.
    Letter,
    /// La taille de l'image, à sa résolution (96 ppp si le fichier n'en indique pas).
    Image,
    /// Taille imposée (points), par exemple celle des pages voisines.
    Fixed { width: f32, height: f32 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePageOptions {
    pub size: PageSize,
    /// Marge autour de l'image (points) ; ignorée pour la taille de l'image.
    pub margin: f32,
}

/// Fichier image accepté (par son extension).
pub fn is_image_path(p: &Path) -> bool {
    let e = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    matches!(e.as_str(), "png" | "jpg" | "jpeg" | "jfif" | "webp" | "bmp" | "gif" | "tif" | "tiff")
}

const MAX_FILE: u64 = 256 << 20;
const MAX_PIXELS: u64 = 100_000_000;

/// Résolution inscrite dans le fichier (JFIF ou pHYs du PNG), en points par pouce.
fn density(bytes: &[u8], fmt: ImageFormat) -> Option<(f32, f32)> {
    match fmt {
        ImageFormat::Jpeg => {
            // Segment APP0 « JFIF\0 » : unité (1 = ppp, 2 = par cm), densités X et Y.
            let i = bytes.windows(5).take(64).position(|w| w == b"JFIF\0")?;
            let d = bytes.get(i + 7..i + 12)?;
            let (x, y) = (u16::from_be_bytes([d[1], d[2]]) as f32, u16::from_be_bytes([d[3], d[4]]) as f32);
            match d[0] {
                1 if x > 1.0 && y > 1.0 => Some((x, y)),
                2 if x > 1.0 && y > 1.0 => Some((x * 2.54, y * 2.54)),
                _ => None,
            }
        }
        ImageFormat::Png => {
            // Bloc pHYs : pixels par unité X et Y, unité 1 = mètre.
            let i = bytes.windows(4).take(4096).position(|w| w == b"pHYs")?;
            let d = bytes.get(i + 4..i + 13)?;
            let x = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) as f32;
            let y = u32::from_be_bytes([d[4], d[5], d[6], d[7]]) as f32;
            (d[8] == 1 && x > 40.0 && y > 40.0).then_some((x * 0.0254, y * 0.0254))
        }
        _ => None,
    }
}

/// Accès de PDFium aux octets du JPEG (lecture par blocs).
unsafe extern "C" fn get_block(param: *mut c_void, position: c_ulong, buf: *mut c_uchar, size: c_ulong) -> c_int {
    let data = unsafe { &*(param as *const Vec<u8>) };
    let (pos, size) = (position as usize, size as usize);
    let Some(src) = data.get(pos..pos.saturating_add(size)) else { return 0 };
    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), buf, size) };
    1
}

/// Ajoute une page à l'index `at` contenant l'image du fichier `path`.
pub fn add_image_page(doc: &PdfDocument, at: i32, path: &Path, opts: &ImagePageOptions) -> Result<()> {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_FILE {
        bail!("image_too_big");
    }
    let bytes = std::fs::read(path).context("image illisible")?;
    let fmt = image::guess_format(&bytes).context("format d'image non reconnu")?;
    if !matches!(fmt, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp | ImageFormat::Gif | ImageFormat::Tiff) {
        bail!("format d'image non pris en charge");
    }
    let mut decoder = ImageReader::with_format(Cursor::new(&bytes), fmt).into_decoder().context("image illisible")?;
    let (pw, ph) = decoder.dimensions();
    if pw == 0 || ph == 0 || pw as u64 * ph as u64 > MAX_PIXELS {
        bail!("image_too_big");
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let turned = matches!(orientation, Orientation::Rotate90 | Orientation::Rotate270 | Orientation::Rotate90FlipH | Orientation::Rotate270FlipH);
    let (iw, ih) = if turned { (ph, pw) } else { (pw, ph) };
    let (dx, dy) = density(&bytes, fmt).unwrap_or((96.0, 96.0));
    let (dx, dy) = if turned { (dy, dx) } else { (dx, dy) };
    // Taille naturelle de l'image, en points.
    let (nw, nh) = (iw as f32 * 72.0 / dx, ih as f32 * 72.0 / dy);

    let landscape = nw > nh;
    let orient = |w: f32, h: f32| if landscape { (h.max(w), h.min(w)) } else { (w.min(h), w.max(h)) };
    let (page_w, page_h, margin) = match opts.size {
        PageSize::A4 => (orient(595.28, 841.89).0, orient(595.28, 841.89).1, opts.margin),
        PageSize::Letter => (orient(612.0, 792.0).0, orient(612.0, 792.0).1, opts.margin),
        PageSize::Fixed { width, height } => (width.clamp(36.0, 14400.0), height.clamp(36.0, 14400.0), opts.margin),
        PageSize::Image => {
            // Bornes des pages PDF (de 0,5 à 200 pouces) : on réduit si besoin, en gardant les proportions.
            let k = (14400.0 / nw.max(nh)).min(1.0);
            ((nw * k).max(36.0), (nh * k).max(36.0), 0.0)
        }
    };
    let margin = margin.clamp(0.0, page_w.min(page_h) / 4.0);
    // Image ajustée dans la page (marges déduites), jamais agrandie, centrée.
    let k = ((page_w - 2.0 * margin) / nw).min((page_h - 2.0 * margin) / nh).clamp(0.0, 1.0);
    let k = if matches!(opts.size, PageSize::Image) { (page_w / nw).min(page_h / nh) } else { k };
    let (w, h) = (nw * k, nh * k);
    let (x, y) = ((page_w - w) / 2.0, (page_h - h) / 2.0);

    let b = raw_bindings();
    let n = doc.pages().len();
    if !(0..=n).contains(&at) {
        bail!("position hors du document");
    }
    unsafe {
        let mut page = b.FPDFPage_New(doc.raw_handle(), at, page_w as f64, page_h as f64);
        if page.is_null() {
            bail!("page refusée par PDFium");
        }
        let obj = b.FPDFPageObj_NewImageObj(doc.raw_handle());
        let ok = if fmt == ImageFormat::Jpeg && orientation == Orientation::NoTransforms {
            // JPEG intégré tel quel.
            let mut access = FPDF_FILEACCESS { m_FileLen: bytes.len() as c_ulong, m_GetBlock: Some(get_block), m_Param: &bytes as *const Vec<u8> as *mut c_void };
            b.FPDFImageObj_LoadJpegFileInline(&mut page, 1, obj, &mut access)
        } else {
            let mut img = image::DynamicImage::from_decoder(decoder).context("image illisible")?;
            img.apply_orientation(orientation);
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let opaque = rgba.pixels().all(|p| p.0[3] == 255);
            // FPDFBitmap_BGR = 2 (image opaque, plus légère), FPDFBitmap_BGRA = 4 (transparence).
            let (format, bpp) = if opaque { (2, 3) } else { (4, 4) };
            let bmp = b.FPDFBitmap_CreateEx(w as i32, h as i32, format, std::ptr::null_mut(), 0);
            if bmp.is_null() {
                b.FPDFPageObj_Destroy(obj);
                b.FPDF_ClosePage(page);
                b.FPDFPage_Delete(doc.raw_handle(), at);
                bail!("mémoire insuffisante");
            }
            let stride = b.FPDFBitmap_GetStride(bmp) as usize;
            let buf = std::slice::from_raw_parts_mut(b.FPDFBitmap_GetBuffer(bmp) as *mut u8, stride * h as usize);
            for (py, row) in rgba.rows().enumerate() {
                for (px, p) in row.enumerate() {
                    let o = py * stride + px * bpp;
                    buf[o] = p[2];
                    buf[o + 1] = p[1];
                    buf[o + 2] = p[0];
                    if bpp == 4 {
                        buf[o + 3] = p[3];
                    }
                }
            }
            let ok = b.FPDFImageObj_SetBitmap(&mut page, 1, obj, bmp);
            b.FPDFBitmap_Destroy(bmp);
            ok
        };
        if ok == 0 {
            b.FPDFPageObj_Destroy(obj);
            b.FPDF_ClosePage(page);
            b.FPDFPage_Delete(doc.raw_handle(), at);
            bail!("image refusée par PDFium");
        }
        // Une image occupe le carré unité : on l'étire au rectangle voulu.
        b.FPDFPageObj_Transform(obj, w as f64, 0.0, 0.0, h as f64, x as f64, y as f64);
        b.FPDFPage_InsertObject(page, obj);
        let generated = b.FPDFPage_GenerateContent(page);
        b.FPDF_ClosePage(page);
        if generated == 0 {
            b.FPDFPage_Delete(doc.raw_handle(), at);
            bail!("page refusée par PDFium");
        }
    }
    Ok(())
}

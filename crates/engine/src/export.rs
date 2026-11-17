//! Phase 2, « Exporter en image » : une page rendue en PNG (sans perte) ou JPEG (qualité réglable)
//! à la résolution choisie, avec ou sans les commentaires et les champs remplis.

use std::io::Write;
use std::path::Path;

use anyhow::{Result, bail};
use image::ImageEncoder;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageKind {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOptions {
    pub format: ImageKind,
    /// Points par pouce (72 = taille réelle à l'écran).
    pub dpi: f32,
    /// Qualité JPEG, de 1 à 100 (ignorée en PNG).
    pub quality: u8,
    /// Commentaires et champs de formulaire remplis inclus dans l'image.
    pub annotations: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub width: u32,
    pub height: u32,
    /// Résolution réellement utilisée (réduite si l'image aurait été démesurée).
    pub dpi: f32,
    pub bytes: u64,
}

/// Plafond de l'image : 100 millions de pixels (400 Mo en mémoire), 30 000 pixels de côté.
const MAX_PIXELS: f64 = 100e6;
const MAX_SIDE: f64 = 30_000.0;

/// Résolution utilisable pour une page de `w` × `h` points, au plus `dpi`.
pub fn capped_dpi(w: f32, h: f32, dpi: f32) -> f32 {
    let dpi = dpi.clamp(18.0, 2400.0) as f64;
    let (w, h) = (w.max(1.0) as f64, h.max(1.0) as f64);
    let px = |d: f64| (w * d / 72.0, h * d / 72.0);
    let (pw, ph) = px(dpi);
    let mut k: f64 = 1.0;
    if pw * ph > MAX_PIXELS {
        k = k.min((MAX_PIXELS / (pw * ph)).sqrt());
    }
    if pw.max(ph) > MAX_SIDE {
        k = k.min(MAX_SIDE / pw.max(ph));
    }
    (dpi * k) as f32
}

/// Rend la page et l'encode ; renvoie l'image encodée, ses dimensions et la résolution utilisée.
pub fn page_image(page: &PdfPage, opts: &ImageOptions) -> Result<(Vec<u8>, u32, u32, f32)> {
    let dpi = capped_dpi(page.width().value, page.height().value, opts.dpi);
    let scale = dpi / 72.0;
    let w = (page.width().value * scale).round().max(1.0) as i32;
    let h = (page.height().value * scale).round().max(1.0) as i32;
    let mut bitmap = PdfBitmap::empty(w, h, PdfBitmapFormat::BGRA).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let config = PdfRenderConfig::new()
        .set_target_size(w, h)
        .set_clear_color(PdfColor::WHITE)
        .render_form_data(opts.annotations)
        .render_annotations(opts.annotations);
    page.render_into_bitmap_with_config(&mut bitmap, &config).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let rgba = bitmap.as_raw_bytes();
    if rgba.len() != (w * h * 4) as usize {
        bail!("rendu inattendu");
    }
    let mut out = Vec::new();
    match opts.format {
        ImageKind::Png => {
            image::codecs::png::PngEncoder::new(&mut out).write_image(&rgba, w as u32, h as u32, image::ExtendedColorType::Rgba8)?;
        }
        ImageKind::Jpeg => {
            // Fond blanc déjà peint : on retire la couche alpha.
            let rgb: Vec<u8> = rgba.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, opts.quality.clamp(1, 100));
            enc.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(dpi.round() as u16));
            enc.encode(&rgb, w as u32, h as u32, image::ExtendedColorType::Rgb8)?;
        }
    }
    Ok((out, w as u32, h as u32, dpi))
}

/// Exporte une page dans `target` (écriture atomique).
pub fn export_page(page: &PdfPage, opts: &ImageOptions, target: &Path) -> Result<ImageResult> {
    let (bytes, width, height, dpi) = page_image(page, opts)?;
    crate::atomic_write(target, |f| {
        f.write_all(&bytes)?;
        Ok(())
    })?;
    Ok(ImageResult { width, height, dpi, bytes: bytes.len() as u64 })
}



//! Phase 2, « Compresser » : réduit la taille d'un PDF.
//! - Images : celles qui dépassent la résolution choisie (à la taille de la plus grande page) sont
//!   réduites et réencodées en JPEG ; un JPEG déjà à la bonne taille n'est réencodé que si le gain
//!   est net. Images laissées telles quelles : masques, couleurs indexées ou CMJN, filtres
//!   particuliers (JBIG2, CCITT, JPEG 2000), plages /Decode, masques de couleur.
//! - Structure (sans perte) : flux compressés, objets inutiles retirés, objets regroupés en flux
//!   d'objets avec une table des références compacte.

use anyhow::{Context, Result};
use image::{DynamicImage, GrayImage, RgbImage};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};

/// Réglage des images ; absent : seule la structure est optimisée (sans perte).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageTarget {
    /// Résolution maximale (points par pouce) à la taille de la plus grande page.
    pub dpi: f32,
    /// Qualité JPEG (1 à 100).
    pub quality: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressOptions {
    pub images: Option<ImageTarget>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressReport {
    pub before: u64,
    pub after: u64,
    pub images: u32,
    pub images_recompressed: u32,
}

/// Images de plus de 60 millions de pixels : laissées telles quelles (mémoire).
const MAX_PIXELS: u64 = 60_000_000;

fn name<'a>(d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    d.get(key).ok().and_then(|o| o.as_name().ok())
}

fn int(d: &Dictionary, key: &[u8]) -> Option<i64> {
    d.get(key).ok().and_then(|o| o.as_i64().ok())
}

/// Nombre de composantes de l'espace de couleur, s'il s'agit de gris ou de RVB.
fn components(doc: &Document, cs: &Object) -> Option<u8> {
    let cs = match cs {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        o => o,
    };
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" | b"G" => Some(1),
            b"DeviceRGB" | b"CalRGB" | b"RGB" => Some(3),
            _ => None,
        },
        Object::Array(a) => match a.first()?.as_name().ok()? {
            b"ICCBased" => {
                let id = a.get(1)?.as_reference().ok()?;
                let n = doc.get_object(id).ok()?.as_stream().ok()?.dict.get(b"N").ok()?.as_i64().ok()?;
                matches!(n, 1 | 3).then_some(n as u8)
            }
            b"CalGray" => Some(1),
            b"CalRGB" => Some(3),
            _ => None,
        },
        _ => None,
    }
}

/// Image d'un flux, si on sait la réécrire sans changer son apparence (hors perte JPEG).
fn decode(doc: &Document, s: &Stream) -> Option<(DynamicImage, bool)> {
    let d = &s.dict;
    if name(d, b"Subtype") != Some(b"Image") {
        return None;
    }
    if d.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()) == Some(true) || d.has(b"Decode") || matches!(d.get(b"Mask"), Ok(Object::Array(_))) {
        return None;
    }
    if int(d, b"BitsPerComponent") != Some(8) {
        return None;
    }
    let n = components(doc, d.get(b"ColorSpace").ok()?)?;
    let (w, h) = (int(d, b"Width")? as u64, int(d, b"Height")? as u64);
    if w == 0 || h == 0 || w * h > MAX_PIXELS {
        return None;
    }
    let filters: Vec<&[u8]> = match d.get(b"Filter") {
        Err(_) => vec![],
        Ok(Object::Name(f)) => vec![f.as_slice()],
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_name().ok()).collect(),
        _ => return None,
    };
    match filters.as_slice() {
        [b"DCTDecode"] => {
            let img = image::load_from_memory_with_format(&s.content, image::ImageFormat::Jpeg).ok()?;
            let ok = match n {
                1 => img.color().channel_count() == 1,
                _ => img.color().channel_count() == 3,
            };
            (ok && img.width() as u64 == w && img.height() as u64 == h).then_some((img, true))
        }
        [] | [b"FlateDecode"] => {
            let len = (w * h * n as u64) as usize;
            let raw = s.decompressed_content_with_limit(len + 16).ok()?;
            if raw.len() < len {
                return None;
            }
            let raw = raw[..len].to_vec();
            let img = if n == 1 { DynamicImage::ImageLuma8(GrayImage::from_raw(w as u32, h as u32, raw)?) } else { DynamicImage::ImageRgb8(RgbImage::from_raw(w as u32, h as u32, raw)?) };
            Some((img, false))
        }
        _ => None,
    }
}

fn jpeg(img: &DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    match img {
        DynamicImage::ImageLuma8(g) => enc.encode(g, g.width(), g.height(), image::ExtendedColorType::L8).ok()?,
        other => {
            let rgb = other.to_rgb8();
            enc.encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).ok()?
        }
    }
    Some(out)
}

/// Réécrit une image si c'est utile ; renvoie vrai si elle a été remplacée.
fn recompress(doc: &Document, s: &Stream, max_side: u32, quality: u8) -> Option<Stream> {
    let (img, was_jpeg) = decode(doc, s)?;
    let side = img.width().max(img.height());
    let scale = (max_side as f64 / side as f64).min(1.0);
    // Image sans perte à la bonne taille (souvent du texte ou un schéma) : on n'y touche pas.
    if scale >= 1.0 && !was_jpeg {
        return None;
    }
    let img = if scale < 1.0 {
        let (w, h) = (((img.width() as f64 * scale).round() as u32).max(1), ((img.height() as f64 * scale).round() as u32).max(1));
        img.resize_exact(w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let data = jpeg(&img, quality)?;
    // Un JPEG laissé à sa taille n'est remplacé que pour un gain net (30 %), le reste pour 5 %.
    let limit = if scale >= 1.0 { s.content.len() * 7 / 10 } else { s.content.len() * 95 / 100 };
    if data.len() >= limit {
        return None;
    }
    let mut dict = s.dict.clone();
    dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    dict.remove(b"DecodeParms");
    dict.set("Width", img.width() as i64);
    dict.set("Height", img.height() as i64);
    dict.set("BitsPerComponent", 8);
    let mut out = Stream::new(dict, data);
    out.allows_compression = false;
    Some(out)
}

/// Compresse un PDF en clair (`longest_page` : plus grand côté de page, en points).
pub fn compress(plain: &[u8], opts: &CompressOptions, longest_page: f32) -> Result<(Vec<u8>, CompressReport)> {
    let mut doc = Document::load_mem(plain).context("lecture du document")?;
    if doc.is_encrypted() {
        anyhow::bail!("encrypted");
    }
    let mut report = CompressReport { before: plain.len() as u64, ..Default::default() };
    let ids: Vec<ObjectId> = doc.objects.iter().filter(|(_, o)| matches!(o, Object::Stream(s) if name(&s.dict, b"Subtype") == Some(b"Image"))).map(|(id, _)| *id).collect();
    report.images = ids.len() as u32;
    if let Some(t) = opts.images {
        let max_side = ((longest_page.max(72.0) / 72.0) * t.dpi.clamp(36.0, 1200.0)).round() as u32;
        for id in ids {
            let Ok(Object::Stream(s)) = doc.get_object(id) else { continue };
            if let Some(new) = recompress(&doc, s, max_side, t.quality) {
                doc.objects.insert(id, Object::Stream(new));
                report.images_recompressed += 1;
            }
        }
    }
    // Sans perte : flux non compressés compressés, objets que plus rien ne référence retirés.
    doc.compress();
    doc.prune_objects();
    let mut out = Vec::new();
    doc.save_with_options(&mut out, lopdf::SaveOptions::builder().use_object_streams(true).use_xref_streams(true).compression_level(9).build())
        .context("écriture du document compressé")?;
    report.after = out.len() as u64;
    Ok((out, report))
}

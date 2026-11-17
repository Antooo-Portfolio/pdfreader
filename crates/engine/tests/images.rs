//! Phase 2, « Créer un PDF depuis des images » : taille de page selon la résolution du fichier,
//! A4 dans le sens de l'image, image jamais agrandie et centrée, JPEG intégré sans recompression,
//! photo redressée selon son orientation EXIF, transparence sur fond blanc, taille imposée.

mod common;

use std::path::Path;

use image::{ImageEncoder, Rgb, RgbImage, Rgba, RgbaImage};
use pdfreader_engine as eng;
use pdfreader_engine::images::{ImagePageOptions, PageSize, add_image_page};

/// Image moitié rouge (à gauche), moitié bleue.
fn halves(w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, _| if x < w / 2 { Rgb([220, 0, 0]) } else { Rgb([0, 0, 220]) })
}

fn jpeg(path: &Path, img: &RgbImage, dpi: Option<u16>, orientation: Option<u16>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
    if let Some(d) = dpi {
        enc.set_pixel_density(image::codecs::jpeg::PixelDensity::dpi(d));
    }
    if let Some(o) = orientation {
        // TIFF minimal : une entrée Orientation (0x0112), type SHORT.
        let mut exif = b"II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00".to_vec();
        exif.extend_from_slice(&o.to_le_bytes());
        exif.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        enc.set_exif_metadata(exif).unwrap();
    }
    enc.write_image(img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
    std::fs::write(path, &out).unwrap();
    out
}

/// Couleur dominante du rendu au point (fx, fy) de la page (fractions de la largeur et de la hauteur).
fn color_at(page: &pdfium_render::prelude::PdfPage, fx: f32, fy: f32) -> [u8; 3] {
    let t = eng::render_page(page, 1.0).unwrap();
    let (x, y) = (((t.width as f32) * fx) as usize, ((t.height as f32) * fy) as usize);
    let o = (y * t.width as usize + x) * 4;
    [t.rgba[o], t.rgba[o + 1], t.rgba[o + 2]]
}

fn opts(size: PageSize) -> ImagePageOptions {
    ImagePageOptions { size, margin: 0.0 }
}

#[test]
fn pdf_from_images() {
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-images-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = pdfium.create_new_pdf().unwrap();

    // JPEG 400 × 200 à 300 ppp : page de 96 × 48 points (taille de l'image), rouge à gauche.
    let small = dir.join("petit.jpg");
    let small_bytes = jpeg(&small, &halves(400, 200), Some(300), None);
    add_image_page(&doc, 0, &small, &opts(PageSize::Image)).unwrap();
    let p = doc.pages().get(0).unwrap();
    assert_eq!((p.width().value.round(), p.height().value.round()), (96.0, 48.0));
    let left = color_at(&p, 0.25, 0.5);
    let right = color_at(&p, 0.75, 0.5);
    assert!(left[0] > 150 && left[2] < 80, "rouge à gauche : {left:?}");
    assert!(right[2] > 150 && right[0] < 80, "bleu à droite : {right:?}");
    drop(p);

    // Grande photo à 96 ppp en A4 : page paysage (sens de l'image), image réduite à la largeur.
    let big = dir.join("grand.jpg");
    jpeg(&big, &halves(3000, 1500), None, None);
    add_image_page(&doc, 1, &big, &opts(PageSize::A4)).unwrap();
    let p = doc.pages().get(1).unwrap();
    assert_eq!((p.width().value.round(), p.height().value.round()), (842.0, 595.0));
    // Le haut de la page (au-dessus de l'image centrée, haute de 421 points) reste blanc.
    assert_eq!(color_at(&p, 0.5, 0.05), [255, 255, 255]);
    assert!(color_at(&p, 0.1, 0.5)[0] > 150);
    drop(p);

    // Petite image en A4 : jamais agrandie, centrée.
    add_image_page(&doc, 2, &small, &opts(PageSize::A4)).unwrap();
    let p = doc.pages().get(2).unwrap();
    assert_eq!(color_at(&p, 0.1, 0.5), [255, 255, 255], "pas agrandie");
    assert!(color_at(&p, 0.48, 0.5)[0] > 150, "centrée");
    drop(p);

    // Photo prise téléphone tourné (EXIF orientation 6) : redressée, portrait, rouge en haut.
    let turned = dir.join("photo.jpg");
    jpeg(&turned, &halves(400, 200), Some(300), Some(6));
    add_image_page(&doc, 3, &turned, &opts(PageSize::Image)).unwrap();
    let p = doc.pages().get(3).unwrap();
    assert_eq!((p.width().value.round(), p.height().value.round()), (48.0, 96.0));
    let top = color_at(&p, 0.5, 0.25);
    let bottom = color_at(&p, 0.5, 0.75);
    assert!(top[0] > 150 && top[2] < 80, "rouge en haut : {top:?}");
    assert!(bottom[2] > 150, "bleu en bas : {bottom:?}");
    drop(p);

    // PNG transparent : la partie transparente reste blanche ; taille imposée.
    let png = dir.join("calque.png");
    let img = RgbaImage::from_fn(100, 100, |x, _| if x < 50 { Rgba([0, 160, 0, 255]) } else { Rgba([0, 0, 0, 0]) });
    img.save(&png).unwrap();
    add_image_page(&doc, 4, &png, &opts(PageSize::Fixed { width: 200.0, height: 300.0 })).unwrap();
    let p = doc.pages().get(4).unwrap();
    assert_eq!((p.width().value, p.height().value), (200.0, 300.0));
    assert!(color_at(&p, 0.4, 0.5)[1] > 120, "partie verte");
    assert_eq!(color_at(&p, 0.6, 0.5), [255, 255, 255], "transparent sur fond blanc");
    drop(p);

    // Fichier qui n'est pas une image : refusé, le document est intact.
    let bad = dir.join("faux.png");
    std::fs::write(&bad, b"pas une image").unwrap();
    assert!(add_image_page(&doc, 0, &bad, &opts(PageSize::A4)).is_err());
    assert_eq!(doc.pages().len(), 5);

    // Enregistré et relu ; le JPEG est intégré tel quel (ses octets se retrouvent dans le PDF).
    let out = dir.join("images.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    assert_eq!(back.pages().len(), 5);
    let pdf = std::fs::read(&out).unwrap();
    assert!(pdf.windows(small_bytes.len()).any(|w| w == small_bytes.as_slice()), "JPEG non recompressé");
    assert!(eng::images::is_image_path(&small) && !eng::images::is_image_path(&out));

    drop((doc, back));
    let _ = std::fs::remove_dir_all(&dir);
}

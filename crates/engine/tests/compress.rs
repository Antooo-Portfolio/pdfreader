//! Phase 2, « Compresser » : photos lourdes réduites à la résolution choisie (taille de la plus
//! grande page) et réencodées en JPEG ; petite image sans perte laissée intacte ; mode sans perte
//! qui ne touche pas aux images ; document toujours lisible ; document chiffré refusé.

mod common;

use image::{ImageEncoder, Rgb, RgbImage};
use pdfreader_engine as eng;
use pdfreader_engine::compress::{CompressOptions, ImageTarget, compress};
use pdfreader_engine::images::{ImagePageOptions, PageSize, add_image_page};

/// Photo factice : dégradé et bruit (se compresse mal, comme une vraie photo).
fn photo(w: u32, h: u32, seed: u32) -> RgbImage {
    let mut s = seed;
    RgbImage::from_fn(w, h, |x, y| {
        s = s.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let n = ((s >> 16) & 31) as i32 - 16;
        let r = (x * 255 / w) as i32 + n;
        let g = (y * 255 / h) as i32 + n;
        Rgb([r.clamp(0, 255) as u8, g.clamp(0, 255) as u8, 128])
    })
}

/// Images du document : (filtre, largeur, hauteur).
fn images(pdf: &[u8]) -> Vec<(String, i64, i64)> {
    let d = lopdf::Document::load_mem(pdf).unwrap();
    let mut v: Vec<_> = d
        .objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .filter(|s| s.dict.get(b"Subtype").ok().and_then(|o| o.as_name().ok()) == Some(b"Image"))
        .map(|s| {
            let f = s.dict.get(b"Filter").ok().and_then(|o| o.as_name().ok()).map(|n| String::from_utf8_lossy(n).to_string()).unwrap_or_default();
            (f, s.dict.get(b"Width").unwrap().as_i64().unwrap(), s.dict.get(b"Height").unwrap().as_i64().unwrap())
        })
        .collect();
    v.sort_by_key(|i| -(i.1 * i.2));
    v
}

#[test]
fn compress_pdf() {
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-compress-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Une photo JPEG très haute qualité, une grande image sans perte, un petit schéma sans perte.
    let jpg = dir.join("photo.jpg");
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 97).write_image(&photo(3000, 4000, 1), 3000, 4000, image::ExtendedColorType::Rgb8).unwrap();
    std::fs::write(&jpg, &bytes).unwrap();
    let big_png = dir.join("grande.png");
    photo(2400, 3200, 2).save(&big_png).unwrap();
    let small = dir.join("schema.png");
    RgbImage::from_fn(300, 300, |x, y| if (x / 30 + y / 30) % 2 == 0 { Rgb([0, 0, 0]) } else { Rgb([255, 255, 255]) }).save(&small).unwrap();
    let doc = pdfium.create_new_pdf().unwrap();
    let a4 = ImagePageOptions { size: PageSize::A4, margin: 0.0 };
    for (i, p) in [&jpg, &big_png, &small].iter().enumerate() {
        add_image_page(&doc, i as i32, p, &a4).unwrap();
    }
    let src = dir.join("lourd.pdf");
    eng::save(&doc, &src, false).unwrap();
    drop(doc);
    let plain = std::fs::read(&src).unwrap();

    // Standard : 150 ppp sur une page A4 (842 points) → 1754 pixels au plus.
    let std_opts = CompressOptions { images: Some(ImageTarget { dpi: 150.0, quality: 75 }) };
    let (out, report) = compress(&plain, &std_opts, 842.0).unwrap();
    eprintln!("compression : {} → {} octets, {} images réécrites sur {}", report.before, report.after, report.images_recompressed, report.images);
    assert!(report.after < report.before / 4, "{report:?}");
    assert_eq!((report.images, report.images_recompressed), (3, 2));
    let imgs = images(&out);
    assert!(imgs[0].1.max(imgs[0].2) <= 1754 && imgs[1].1.max(imgs[1].2) <= 1754, "{imgs:?}");
    assert!(imgs.iter().any(|i| i == &("FlateDecode".to_string(), 300, 300)), "petit schéma intact : {imgs:?}");
    // Toujours lisible, mêmes pages, même apparence générale (dégradé : rouge à droite).
    let f = dir.join("compresse.pdf");
    std::fs::write(&f, &out).unwrap();
    let back = eng::open_typed(&pdfium, &f, None).unwrap();
    assert_eq!(back.pages().len(), 3);
    let t = eng::render_page(&back.pages().get(0).unwrap(), 0.25).unwrap();
    let px = |x: usize, y: usize| t.rgba[(y * t.width as usize + x) * 4];
    assert!(px(t.width as usize * 9 / 10, t.height as usize / 2) > px(t.width as usize / 10, t.height as usize / 2) + 100, "dégradé conservé");

    // Écran (96 ppp) : encore plus léger que le réglage standard.
    let (screen, _) = compress(&plain, &CompressOptions { images: Some(ImageTarget { dpi: 96.0, quality: 60 }) }, 842.0).unwrap();
    assert!(screen.len() < out.len());

    // Sans perte : images inchangées, document pas plus lourd.
    let (lossless, r2) = compress(&plain, &CompressOptions { images: None }, 842.0).unwrap();
    assert_eq!(r2.images_recompressed, 0);
    assert_eq!(images(&lossless), images(&plain));
    assert!(lossless.len() <= plain.len());
    if let Some(text) = common::corpus("02-texte-1000p.pdf") {
        let t = std::fs::read(text).unwrap();
        let (l, _) = compress(&t, &CompressOptions { images: None }, 842.0).unwrap();
        eprintln!("1000 pages de texte, sans perte : {} → {} octets", t.len(), l.len());
        assert!(l.len() <= t.len());
    }

    // Document chiffré : refusé (la protection serait perdue).
    if let Some(locked) = common::corpus("09-chiffre-aes256.pdf") {
        assert!(compress(&std::fs::read(locked).unwrap(), &std_opts, 842.0).is_err());
    }

    drop(back);
    let _ = std::fs::remove_dir_all(&dir);
}

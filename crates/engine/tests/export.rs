//! Phase 2, « Exporter en image » : PNG et JPEG aux bonnes dimensions, JPEG plus léger, page
//! pivotée exportée dans son sens d'affichage, commentaires inclus ou non, résolution plafonnée pour
//! une page géante.

mod common;

use pdfreader_engine as eng;
use pdfreader_engine::export::{ImageKind, ImageOptions, capped_dpi, export_page, page_image};

fn opts(format: ImageKind, dpi: f32, annotations: bool) -> ImageOptions {
    ImageOptions { format, dpi, quality: 85, annotations }
}

#[test]
fn export_images() {
    let (Some(src), Some(mixed)) = (common::corpus("01-texte-10p.pdf"), common::corpus("07-tailles-mixtes-rotation.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-export-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let page = doc.pages().get(0).unwrap();

    // PNG à 72 ppp : une image de la taille de la page en points, avec du texte (pas toute blanche).
    let png_path = dir.join("p1.png");
    let r = export_page(&page, &opts(ImageKind::Png, 72.0, true), &png_path).unwrap();
    assert_eq!((r.width, r.height), (595, 842));
    let img = image::open(&png_path).unwrap().to_rgba8();
    assert_eq!(img.dimensions(), (595, 842));
    assert!(img.pixels().any(|p| p.0[0] < 100), "du texte noir est rendu");
    assert!(img.pixels().all(|p| p.0[3] == 255), "fond opaque");

    // JPEG à 150 ppp : dimensions proportionnelles, fichier plus léger qu'un PNG à la même résolution.
    let (jpg, w, h, dpi) = page_image(&page, &opts(ImageKind::Jpeg, 150.0, true)).unwrap();
    assert_eq!((w, h, dpi), (1240, 1754, 150.0));
    let (png150, ..) = page_image(&page, &opts(ImageKind::Png, 150.0, true)).unwrap();
    assert!(jpg.len() < png150.len() / 2, "JPEG {} contre PNG {}", jpg.len(), png150.len());
    let decoded = image::load_from_memory(&jpg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (1240, 1754));

    // Commentaires : inclus ou non selon l'option.
    let mut p2 = doc.pages().get(1).unwrap();
    eng::highlight_first(&mut p2, "page", "Test", (255, 0, 0)).unwrap();
    let (with, ..) = page_image(&p2, &opts(ImageKind::Png, 72.0, true)).unwrap();
    let (without, ..) = page_image(&p2, &opts(ImageKind::Png, 72.0, false)).unwrap();
    let red = |b: &[u8]| image::load_from_memory(b).unwrap().to_rgba8().pixels().filter(|p| p.0[0] > 200 && p.0[1] < 120 && p.0[2] < 120).count();
    assert!(red(&with) > 50, "surlignage rouge visible");
    assert_eq!(red(&without), 0, "sans les commentaires");

    // Page pivotée : exportée dans son sens d'affichage.
    let m = eng::open_typed(&pdfium, &mixed, None).unwrap();
    for i in 0..m.pages().len() {
        let pg = m.pages().get(i).unwrap();
        let (_, w, h, _) = page_image(&pg, &opts(ImageKind::Png, 36.0, true)).unwrap();
        assert_eq!(w > h, pg.width().value > pg.height().value, "page {i}");
    }

    // Page géante (A0 à 2400 ppp) : résolution réduite sous les plafonds.
    let d = capped_dpi(2384.0, 3370.0, 2400.0);
    let (pw, ph) = (2384.0 * d / 72.0, 3370.0 * d / 72.0);
    assert!(pw * ph <= 100.5e6 && pw.max(ph) <= 30_000.0, "{d} ppp → {pw}×{ph}");
    assert_eq!(capped_dpi(595.0, 842.0, 300.0), 300.0);

    drop((page, p2, doc, m));
    let _ = std::fs::remove_dir_all(&dir);
}

//! Phase 2, « Organiser les pages » : rotation enregistrée, déplacement, suppression (vraiment
//! retirée du fichier à l'enregistrement complet), page blanche, insertion depuis un autre PDF,
//! extraction, découpage, combinaison, signets en attente qui suivent leurs pages, document chiffré
//! qui le reste.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::pages;

/// Numéro écrit sur la page (« Texte simple — page N »), ou 0 pour une page sans ce texte.
fn label(doc: &PdfDocument, i: i32) -> i32 {
    // Couche de texte de l'application (text().all() rogne le texte d'une page pivotée).
    let lines = eng::text_layer(&doc.pages().get(i).unwrap()).unwrap();
    let t: String = lines.iter().flatten().flat_map(|w| w.t.chars()).filter(|c| !c.is_whitespace()).collect();
    t.split("—page").nth(1).map(|s| s.chars().take_while(char::is_ascii_digit).collect::<String>()).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn labels(doc: &PdfDocument) -> Vec<i32> {
    (0..doc.pages().len()).map(|i| label(doc, i)).collect()
}

fn rotation(doc: &PdfDocument, i: i32) -> i32 {
    unsafe { raw_bindings().FPDFPage_GetRotation(doc.pages().get(i).unwrap().raw_handle()) }
}

/// Objets /Type /Page présents dans le fichier (y compris ceux qui ne sont plus référencés).
fn page_objects(path: &std::path::Path) -> usize {
    let d = lopdf::Document::load(path).unwrap();
    d.objects.values().filter(|o| o.as_dict().ok().and_then(|d| d.get(b"Type").ok()).and_then(|t| t.as_name().ok()) == Some(b"Page")).count()
}

#[test]
fn organize_pages() {
    let (Some(src), Some(mixed), Some(locked)) = (common::corpus("01-texte-10p.pdf"), common::corpus("07-tailles-mixtes-rotation.pdf"), common::corpus("09-chiffre-aes256.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-pages-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    assert_eq!(labels(&doc), (1..=10).collect::<Vec<_>>());

    // Rotation enregistrée : un quart de tour horaire sur les pages 1 et 3, puis antihoraire sur la 3.
    pages::rotate(&doc, &[0, 2], 1).unwrap();
    pages::rotate(&doc, &[2], -1).unwrap();
    assert_eq!((rotation(&doc, 0), rotation(&doc, 2)), (1, 0));

    // Déplacement des pages 8 et 9 avant la page 2.
    let map = pages::move_pages(&doc, &[8, 7], 1).unwrap();
    assert_eq!(labels(&doc), vec![1, 8, 9, 2, 3, 4, 5, 6, 7, 10]);
    assert_eq!(map[7], Some(1));
    assert_eq!(map[1], Some(3));
    // Vers la fin.
    pages::move_pages(&doc, &[0], 10).unwrap();
    assert_eq!(labels(&doc), vec![8, 9, 2, 3, 4, 5, 6, 7, 10, 1]);
    assert_eq!(rotation(&doc, 9), 1, "la rotation suit la page");

    // Signets en attente : suivent leurs pages ; celui d'une page supprimée perd sa destination.
    let mut outline = vec![
        eng::outline::OutlineItem { title: "Huit".into(), page: 0, top: None, uri: None, children: vec![] },
        eng::outline::OutlineItem { title: "Neuf".into(), page: 1, top: None, uri: None, children: vec![] },
    ];
    let map = pages::delete(&doc, &[1, 3]).unwrap();
    pages::remap_outline(&mut outline, &map);
    assert_eq!(labels(&doc), vec![8, 2, 4, 5, 6, 7, 10, 1]);
    assert_eq!((outline[0].page, outline[1].page), (0, -1));
    assert!(pages::delete(&doc, &(0..8).collect::<Vec<_>>()).is_err(), "il doit rester une page");

    // Page blanche A4 en tête, puis les deux premières pages d'un autre PDF à la fin.
    let map = pages::insert_blank(&doc, 0, 595.0, 842.0).unwrap();
    assert_eq!(map[0], Some(1));
    let other = eng::open_typed(&pdfium, &mixed, None).unwrap();
    let (_, added) = pages::insert_from(&doc, &other, Some(&[0, 1]), doc.pages().len()).unwrap();
    assert_eq!(added, 2);
    assert_eq!(doc.pages().len(), 11);
    assert_eq!(label(&doc, 0), 0);
    assert_eq!(doc.pages().get(10).unwrap().width().value.round(), other.pages().get(1).unwrap().width().value.round());

    // Enregistrement complet : les pages supprimées ne restent pas dans le fichier.
    let out = dir.join("organise.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    assert_eq!(&labels(&back)[1..9], &[8, 2, 4, 5, 6, 7, 10, 1]);
    assert_eq!(rotation(&back, 8), 1);
    assert_eq!(page_objects(&out), 11);
    // En incrémental, l'ancienne version (et les pages supprimées) resterait dans le fichier.
    let inc = dir.join("incremental.pdf");
    std::fs::copy(&src, &inc).unwrap();
    let doc2 = eng::open_typed(&pdfium, &inc, None).unwrap();
    pages::delete(&doc2, &[0]).unwrap();
    let inc2 = dir.join("incremental2.pdf");
    eng::save(&doc2, &inc2, true).unwrap();
    assert!(std::fs::read(&inc2).unwrap().starts_with(&std::fs::read(&inc).unwrap()), "l'ancienne version reste lisible en tête du fichier");

    // Extraction des pages 3 et 5 (dans l'ordre actuel) vers un nouveau fichier.
    let ext = dir.join("extrait.pdf");
    pages::extract(&pdfium, &back, &[3, 2], &ext).unwrap();
    let e = eng::open_typed(&pdfium, &ext, None).unwrap();
    assert_eq!(labels(&e), vec![2, 4]);

    // Découpage et combinaison.
    assert_eq!(pages::split_ranges(10, 3), vec![(0, 2), (3, 5), (6, 8), (9, 9)]);
    assert_eq!(pages::split_ranges(2, 5), vec![(0, 1)]);
    let a = eng::open_typed(&pdfium, &src, None).unwrap();
    let comb = dir.join("combine.pdf");
    let n = pages::combine(&pdfium, &[&a, &other], &comb).unwrap();
    assert_eq!(n, 10 + other.pages().len());
    let c = eng::open_typed(&pdfium, &comb, None).unwrap();
    assert_eq!(c.pages().len(), n);
    assert_eq!(&labels(&c)[..10], &(1..=10).collect::<Vec<_>>()[..]);

    // Document chiffré : reste chiffré après un enregistrement complet.
    let l = eng::open_typed(&pdfium, &locked, Some("test1234")).unwrap();
    assert!(eng::permissions(&l).assemble);
    pages::delete(&l, &[0]).unwrap();
    let lout = dir.join("chiffre.pdf");
    eng::save(&l, &lout, false).unwrap();
    drop(l);
    assert!(matches!(eng::open_typed(&pdfium, &lout, None), Err(eng::OpenError::PasswordRequired)));
    let l2 = eng::open_typed(&pdfium, &lout, Some("test1234")).unwrap();
    assert_eq!(labels(&l2), (2..=10).collect::<Vec<_>>());

    drop((doc, doc2, back, e, a, c, other, l2));
    let _ = std::fs::remove_dir_all(&dir);
}

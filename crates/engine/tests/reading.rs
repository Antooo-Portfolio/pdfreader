//! Tests du lot « lecture » (M2) : liens, signets, recherche, droits, sur un PDF fabriqué ici.
//! Nécessite pdfium.dll dans vendor/pdfium-win-x64/bin (comme le reste du moteur).

use std::path::Path;

use pdfreader_engine as eng;

/// PDF de 3 pages : page 1 avec du texte, un lien vers la page 3 (destination /XYZ) et un lien
/// web ; signets imbriqués (Partie A > Section A.1, Partie B).
fn sample_pdf() -> Vec<u8> {
    let content = b"BT /F1 24 Tf 72 700 Td (Bonjour contrat) Tj ET BT /F1 12 Tf 72 650 Td (contrat suivant) Tj ET".to_vec();
    let objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> /Annots [8 0 R 13 0 R] >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] >>".to_vec(),
        [format!("<< /Length {} >>\nstream\n", content.len()).into_bytes(), content, b"\nendstream".to_vec()].concat(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        b"<< /Type /Annot /Subtype /Link /Rect [72 690 300 720] /Border [0 0 0] /Dest [5 0 R /XYZ 0 500 null] >>".to_vec(),
        b"<< /Type /Outlines /First 10 0 R /Last 12 0 R /Count 3 >>".to_vec(),
        b"<< /Title (Partie A) /Parent 9 0 R /Next 12 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [4 0 R /Fit] >>".to_vec(),
        b"<< /Title (Section A.1) /Parent 10 0 R /Dest [5 0 R /XYZ 0 400 null] >>".to_vec(),
        b"<< /Title (Partie B) /Parent 9 0 R /Prev 10 0 R /A << /S /URI /URI (https://example.org/) >> >>".to_vec(),
        b"<< /Type /Annot /Subtype /Link /Rect [72 640 200 660] /Border [0 0 0] /A << /S /URI /URI (https://example.org/doc) >> >>".to_vec(),
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(o);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

fn pdfium() -> pdfium_render::prelude::Pdfium {
    eng::load_pdfium(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/pdfium-win-x64/bin")).expect("pdfium.dll")
}

#[test]
fn links_bookmarks_search_permissions() {
    let pdfium = pdfium();
    let doc = pdfium.load_pdf_from_byte_vec(sample_pdf(), None).expect("PDF de test");

    // Droits : document non chiffré, tout est permis.
    let p = eng::permissions(&doc);
    assert!(p.print && p.copy && p.annotate && p.modify);

    // Liens de la page 1 : un vers la page 3 (index 2) à 500 pt du bas, soit 112 pt du haut
    // (page 3 en paysage : 612 pt de haut), un vers une adresse web.
    let page = doc.pages().get(0).unwrap();
    let links = eng::page_links(&doc, &page);
    assert_eq!(links.len(), 2, "{links:?}");
    let goto = links.iter().find(|l| matches!(l.action, eng::LinkAction::Goto { .. })).expect("lien interne");
    match &goto.action {
        eng::LinkAction::Goto { page, top } => {
            assert_eq!(*page, 2);
            assert!((top.unwrap() - 112.0).abs() < 0.5, "{top:?}");
        }
        _ => unreachable!(),
    }
    // Zone du lien interne : [72 690 300 720] en PDF → y = 792 - 720 = 72 depuis le haut.
    assert!((goto.x - 72.0).abs() < 0.5 && (goto.y - 72.0).abs() < 0.5 && (goto.w - 228.0).abs() < 0.5 && (goto.h - 30.0).abs() < 0.5, "{goto:?}");
    assert!(links.iter().any(|l| matches!(&l.action, eng::LinkAction::Uri { uri } if uri == "https://example.org/doc")));

    // Signets imbriqués.
    let bm = eng::bookmarks(&doc);
    assert_eq!(bm.len(), 2, "{bm:?}");
    assert_eq!(bm[0].title, "Partie A");
    assert!(matches!(bm[0].action, eng::LinkAction::Goto { page: 1, .. }));
    assert_eq!(bm[0].children.len(), 1);
    assert_eq!(bm[0].children[0].title, "Section A.1");
    assert!(matches!(bm[0].children[0].action, eng::LinkAction::Goto { page: 2, top: Some(t) } if (t - 212.0).abs() < 0.5));
    assert!(matches!(&bm[1].action, eng::LinkAction::Uri { uri } if uri == "https://example.org/"));

    // Recherche : deux « contrat » sur la page 1, aucun texte sur les pages 2 et 3.
    let r = eng::search(&doc, 0, 3, "contrat", false, false).unwrap();
    assert_eq!(r.pages_with_text, 1);
    assert_eq!(r.pages.len(), 1);
    assert_eq!(r.pages[0].hits.len(), 2);
    let [x, y, w, h] = r.pages[0].hits[0][0];
    assert!(x > 72.0 && y > 60.0 && y < 100.0 && w > 10.0 && h > 5.0, "{:?}", r.pages[0].hits[0]);
    // Casse et mot entier.
    assert_eq!(eng::search(&doc, 0, 3, "CONTRAT", true, false).unwrap().pages.len(), 0);
    assert_eq!(eng::search(&doc, 0, 3, "contra", false, true).unwrap().pages.len(), 0);
    assert_eq!(eng::search(&doc, 0, 3, "contra", false, false).unwrap().pages[0].hits.len(), 2);
}

#[test]
fn encrypted_permissions_are_read() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/generated/09-chiffre-aes256.pdf");
    if !path.exists() {
        eprintln!("corpus absent : test ignoré");
        return;
    }
    let pdfium = pdfium();
    let doc = eng::open_typed(&pdfium, &path, Some("test1234")).expect("ouverture");
    let p = eng::permissions(&doc);
    assert!(p.print && !p.print_high_quality && !p.copy, "{p:?}");
}

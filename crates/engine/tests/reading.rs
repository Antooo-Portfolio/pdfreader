//! Tests du lot « lecture » (M2) : liens, signets, recherche, droits, sur un PDF fabriqué ici.
//! Nécessite pdfium.dll dans vendor/pdfium-win-x64/bin (comme le reste du moteur).

use std::path::Path;

use pdfreader_engine as eng;

mod common;
use common::pdfium;

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

/// Texte japonais (HeiseiMin-W3) et chinois (STSong-Light) non embarqués : une police installée
/// de la bonne écriture prend le relais (constat 5 du spike M0 : le japonais était invisible).
#[test]
fn cjk_fonts_not_embedded_are_drawn() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/generated/05-cjk-non-embarque.pdf");
    if !p.exists() {
        eprintln!("corpus absent : test ignoré");
        return;
    }
    let pdfium = pdfium();
    let doc = eng::open_typed(&pdfium, &p, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let t = eng::render_page(&page, 1.0).unwrap();
    // Pixels sombres dans une bande horizontale (en points depuis le haut).
    let dark = |y0: i32, y1: i32| {
        let mut n = 0;
        for y in y0..y1 {
            for x in 50..500 {
                let i = ((y * t.width + x) * 4) as usize;
                if t.rgba[i] < 128 {
                    n += 1;
                }
            }
        }
        n
    };
    let (ja, zh, latin) = (dark(62, 84), dark(102, 124), dark(146, 164));
    eprintln!("pixels sombres : japonais {ja}, chinois {zh}, latin {latin}");
    assert!(latin > 200, "la ligne latine sert de témoin");
    assert!(ja > 400, "le japonais doit s'afficher ({ja})");
    assert!(zh > 400, "le chinois doit s'afficher ({zh})");
}

#[test]
fn document_properties() {
    // Corpus : titre et auteur posés par reportlab ; Courier non embarquée.
    let (Some(text), Some(courier), Some(enc)) = (common::corpus("01-texte-10p.pdf"), common::corpus("03-courier-non-embarquee.pdf"), common::corpus("09-chiffre-aes256.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = pdfium();
    let doc = eng::open_typed(&pdfium, &text, None).expect("ouverture");
    let p = eng::properties::properties(&doc, &text);
    assert_eq!(p.author, "Corpus PDFReader");
    assert!(!p.title.is_empty(), "titre lu");
    assert!(p.producer.to_lowercase().contains("reportlab"), "producteur : {}", p.producer);
    assert!(p.created.starts_with("D:"), "date brute : {}", p.created);
    assert_eq!(p.page_count, 10);
    assert!(p.version.as_deref().is_some_and(|v| v.starts_with("1.")), "version : {:?}", p.version);
    assert!(p.file_size > 1000);
    assert_eq!(p.security_revision, None);
    assert!(!p.fonts.is_empty(), "polices lues");
    assert_eq!(p.fonts_pages, 10);
    drop(doc);

    let doc = eng::open_typed(&pdfium, &courier, None).expect("ouverture");
    let p = eng::properties::properties(&doc, &courier);
    let c = p.fonts.iter().find(|f| f.name.contains("Courier")).expect("Courier listée");
    assert!(!c.embedded, "Courier non embarquée");
    drop(doc);

    let doc = eng::open_typed(&pdfium, &enc, Some("test1234")).expect("ouverture avec le mot de passe");
    let p = eng::properties::properties(&doc, &enc);
    assert_eq!(p.security_revision, Some(6), "AES-256 (R6)");
}

#[test]
fn attachments_snippets_and_internet_mark() {
    let (Some(att), Some(text)) = (common::corpus("12-pieces-jointes.pdf"), common::corpus("01-texte-10p.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = pdfium();
    let doc = eng::open_typed(&pdfium, &att, None).expect("ouverture");
    let list = eng::navigation::attachments(&doc);
    let names: Vec<&str> = list.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names.len(), 3, "{names:?}");
    assert!(names.contains(&"danger.exe"), "nom piégé ramené à un nom simple : {names:?}");
    assert!(names.iter().all(|n| !n.contains('\\') &&!n.contains('/') && !n.contains("..")));
    let notes = list.iter().find(|a| a.name == "notes.txt").expect("notes.txt");
    let bytes = eng::navigation::attachment_bytes(&doc, notes.index).expect("contenu");
    assert_eq!(String::from_utf8_lossy(&bytes), "Notes de réunion\n");
    assert_eq!(notes.size, bytes.len());
    let annexe = list.iter().find(|a| a.name == "annexe.pdf").expect("annexe.pdf");
    assert!(eng::navigation::attachment_bytes(&doc, annexe.index).unwrap().starts_with(b"%PDF"));
    drop(doc);
    assert_eq!(eng::navigation::safe_file_name("..\\..\\a<b>.exe. "), "a_b_.exe");
    assert_eq!(eng::navigation::safe_file_name(".."), "piece-jointe");

    // Extraits : le mot trouvé et son contexte, sur plusieurs pages.
    let doc = eng::open_typed(&pdfium, &text, None).expect("ouverture");
    let r = eng::navigation::search_snippets(&doc, 0, 10, "contrat", false, false, 0).expect("recherche");
    assert!(r.hits.len() > 3, "résultats : {}", r.hits.len());
    let h = &r.hits[0];
    assert_eq!(h.matched.to_lowercase(), "contrat");
    assert!(!h.before.is_empty() || !h.after.is_empty(), "contexte");
    assert!(!h.rects.is_empty() && h.rects[0][2] > 1.0);
    assert!(r.hits.iter().map(|h| h.page).collect::<std::collections::HashSet<_>>().len() > 1, "plusieurs pages");
    let capped = eng::navigation::search_snippets(&doc, 0, 10, "e", false, false, eng::navigation::MAX_SNIPPET_HITS - 2).expect("recherche");
    assert!(capped.truncated && capped.hits.len() == 2, "plafond global");
    drop(doc);

    // Marque du Web (flux NTFS Zone.Identifier).
    let dir = std::env::temp_dir().join(format!("pdfreader-motw-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("venu-du-web.pdf");
    std::fs::copy(&text, &f).unwrap();
    assert!(!eng::navigation::from_internet(&f));
    let mut ads = f.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    if std::fs::write(Path::new(&ads), "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.org/\r\n").is_ok() {
        assert!(eng::navigation::from_internet(&f), "zone 3 reconnue");
    } else {
        eprintln!("flux NTFS indisponible ici : vérification de la marque ignorée");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn outline_write_and_reload() {
    use eng::outline::{OutlineItem, write};
    let (Some(text), Some(enc)) = (common::corpus("01-texte-10p.pdf"), common::corpus("09-chiffre-aes256.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-outline-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("signets.pdf");
    // Comme dans l'application : PDFium enregistre d'abord (mise à jour incrémentale).
    let heights: Vec<f32> = {
        let doc = eng::open_typed(&pdfium, &text, None).unwrap();
        eng::save(&doc, &path, true).unwrap();
        doc.pages().iter().map(|p| p.height().value).collect()
    };
    let items = vec![
        OutlineItem { title: "Introduction".into(), page: 0, top: None, uri: None, children: vec![] },
        OutlineItem {
            title: "Chapitre é — « deux »".into(),
            page: 3,
            top: Some(100.0),
            uri: None,
            children: vec![OutlineItem { title: "Section 2.1".into(), page: 4, top: Some(0.0), uri: None, children: vec![] }],
        },
        OutlineItem { title: "Annexe".into(), page: 9, top: None, uri: None, children: vec![] },
        OutlineItem { title: "Site".into(), page: -1, top: None, uri: Some("https://example.org/".into()), children: vec![] },
    ];
    write(&path, &items, &heights).unwrap();
    {
        let doc = eng::open_typed(&pdfium, &path, None).expect("le fichier reste lisible");
        assert_eq!(doc.pages().len(), 10);
        let b = eng::bookmarks(&doc);
        let titles: Vec<&str> = b.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, ["Introduction", "Chapitre é — « deux »", "Annexe", "Site"]);
        assert!(matches!(&b[3].action, eng::LinkAction::Uri { uri } if uri == "https://example.org/"), "{:?}", b[3].action);
        assert_eq!(b[1].children.len(), 1);
        assert_eq!(b[1].children[0].title, "Section 2.1");
        match &b[1].action {
            eng::LinkAction::Goto { page, top } => {
                assert_eq!(*page, 3);
                assert!((top.unwrap() - 100.0).abs() < 0.5, "ordonnée : {top:?}");
            }
            other => panic!("action inattendue : {other:?}"),
        }
        match &b[2].action {
            eng::LinkAction::Goto { page, .. } => assert_eq!(*page, 9),
            other => panic!("action inattendue : {other:?}"),
        }
    }
    // Remplacer puis vider.
    write(&path, &items[..1], &heights).unwrap();
    assert_eq!(eng::bookmarks(&eng::open_typed(&pdfium, &path, None).unwrap()).len(), 1);
    write(&path, &[], &heights).unwrap();
    assert!(eng::bookmarks(&eng::open_typed(&pdfium, &path, None).unwrap()).is_empty());
    // Un enregistrement PDFium par-dessus reste possible (la chaîne des mises à jour tient).
    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let again = dir.join("signets-2.pdf");
        eng::save(&doc, &again, true).unwrap();
        assert_eq!(eng::open_typed(&pdfium, &again, None).unwrap().pages().len(), 10);
    }
    // Document chiffré : refusé, fichier intact.
    let enc_copy = dir.join("chiffre.pdf");
    std::fs::copy(&enc, &enc_copy).unwrap();
    let before = std::fs::read(&enc_copy).unwrap();
    let err = write(&enc_copy, &items, &[792.0; 10]).unwrap_err().to_string();
    assert!(err.contains("encrypted") || err.contains("lecture"), "{err}");
    assert_eq!(std::fs::read(&enc_copy).unwrap(), before);
    let _ = std::fs::remove_dir_all(&dir);
}

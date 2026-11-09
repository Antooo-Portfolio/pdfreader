//! Tests du lot « annotations » (M2) : création, lecture, modification de l'apparence,
//! suppression, puis enregistrement incrémental et relecture.

use std::path::Path;

use pdfreader_engine as eng;
use pdfreader_engine::annotations as an;

fn pdfium() -> pdfium_render::prelude::Pdfium {
    eng::load_pdfium(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/pdfium-win-x64/bin")).expect("pdfium.dll")
}

fn blank_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>",
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 4\n0000000000 65535 f \n").as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes());
    out
}

/// Couleur du pixel (x, y) en points depuis le haut, rendu à 1 px par point.
fn pixel(page: &pdfium_render::prelude::PdfPage, x: f32, y: f32) -> [u8; 3] {
    let t = eng::render_page(page, 1.0).unwrap();
    let i = ((y as i32 * t.width + x as i32) * 4) as usize;
    [t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]]
}

#[test]
fn create_update_delete_save_reload() {
    let pdfium = pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-annot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.pdf");
    std::fs::write(&path, blank_pdf()).unwrap();

    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let mut page = doc.pages().get(0).unwrap();
        // Souligné rouge à 50 % sur une ligne (PDF : gauche, bas, droite, haut).
        let u = an::add_markup(&mut page, "underline", &[[100.0, 700.0, 300.0, 720.0]], [220, 0, 0], 0.5, "Camille").unwrap();
        // Surlignage bleu, puis note et tracé.
        let h = an::add_markup(&mut page, "highlight", &[[100.0, 600.0, 300.0, 640.0]], [0, 0, 255], 1.0, "Camille").unwrap();
        let n = an::add_note(&mut page, 400.0, 100.0, "À revoir", [255, 200, 0], "Camille").unwrap();
        let k = an::add_ink(&mut page, &[vec![[100.0, 400.0], [200.0, 450.0], [300.0, 400.0]]], [0, 128, 0], 1.0, 3.0, "Camille").unwrap();

        let list = an::list(&page, 0);
        assert_eq!(list.len(), 4, "{list:#?}");
        let ul = list.iter().find(|a| a.id == u).unwrap();
        assert_eq!(ul.kind, "underline");
        assert_eq!(ul.color, Some([220, 0, 0]));
        assert!((ul.opacity - 0.5).abs() < 0.01);
        assert_eq!(ul.author, "Camille");
        assert!(ul.created.as_deref().unwrap().starts_with("D:20"));
        // Zone en points depuis le haut : 800 - 720 = 80.
        assert!((ul.boxes[0][1] - 80.0).abs() < 0.5 && (ul.boxes[0][2] - 200.0).abs() < 0.5, "{:?}", ul.boxes);
        let note = list.iter().find(|a| a.id == n).unwrap();
        assert_eq!((note.kind, note.contents.as_str()), ("note", "À revoir"));
        assert!((note.rect[0] - 400.0).abs() < 0.5 && (note.rect[1] - 100.0).abs() < 0.5, "{:?}", note.rect);
        let ink = list.iter().find(|a| a.id == k).unwrap();
        assert_eq!(ink.strokes.len(), 1);
        assert_eq!(ink.strokes[0].len(), 3);
        assert!((ink.strokes[0][1][1] - 450.0).abs() < 0.5);
        assert!((ink.width - 3.0).abs() < 0.01);

        // Le surlignage s'affiche en bleu (fusion « produit » sur blanc), au centre de sa zone :
        // y = 800 - 620 = 180.
        let before = pixel(&page, 200.0, 180.0);
        assert!(before[2] > 200 && before[0] < 80, "surlignage bleu attendu : {before:?}");
        // Passage au vert : l'apparence doit être régénérée.
        an::update(&mut page, &h, &an::AnnotPatch { color: Some([0, 200, 0]), ..Default::default() }).unwrap();
        let after = pixel(&page, 200.0, 180.0);
        assert!(after[1] > 150 && after[2] < 80, "surlignage vert attendu après modification : {after:?}");
        an::update(&mut page, &n, &an::AnnotPatch { contents: Some("Corrigé".into()), ..Default::default() }).unwrap();

        // Le tracé s'affiche (apparence générée par PDFium) : vert au milieu du premier segment.
        let ink_px = pixel(&page, 150.0, 425.0);
        assert!(ink_px[1] > 90 && ink_px[0] < 80 && ink_px[2] < 80, "tracé vert attendu : {ink_px:?}");
        // La note s'affiche aussi (icône jaune) : pas un pixel blanc dans son carré.
        let note_px = pixel(&page, 410.0, 106.0);
        assert!(note_px != [255, 255, 255], "icône de note attendue : {note_px:?}");

        // Suppression du tracé.
        an::delete(&mut page, &k).unwrap();
        assert_eq!(an::list(&page, 0).len(), 3);
        eng::save(&doc, &path, true).unwrap();
    }

    // Relecture du fichier enregistré.
    let doc = eng::open_typed(&pdfium, &path, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let list = an::list(&page, 0);
    assert_eq!(list.len(), 3, "{list:#?}");
    assert!(list.iter().any(|a| a.kind == "note" && a.contents == "Corrigé"));
    assert!(list.iter().any(|a| a.kind == "highlight" && a.color == Some([0, 200, 0])));
    let px = pixel(&page, 200.0, 180.0);
    assert!(px[1] > 150 && px[2] < 80, "vert après relecture : {px:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

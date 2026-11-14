//! Tests du lot « annotations » (M2) : création, lecture, modification de l'apparence,
//! suppression, puis enregistrement incrémental et relecture.


use pdfreader_engine as eng;
use pdfreader_engine::annotations as an;

mod common;
use common::pdfium;

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

/// M3 : formes (rectangle rempli, ellipse, ligne, flèche, polygone, polyligne, nuage), tampon
/// prédéfini, réponses et statuts ; tout survit à l'enregistrement et à la relecture.
#[test]
fn shapes_stamps_replies_status() {
    let pdfium = pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-shapes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("formes.pdf");
    let saved = dir.join("formes-2.pdf");
    std::fs::write(&path, blank_pdf()).unwrap();
    let (red, blue, yellow) = ([200, 0, 0], [0, 0, 200], [255, 230, 0]);
    let (note_id, reply_id, square_id);
    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let mut page = doc.pages().get(0).unwrap();
        square_id = an::add_shape(&mut page, "square", &[[100.0, 100.0], [200.0, 160.0]], red, 1.0, 3.0, Some(yellow), "Camille").unwrap();
        an::add_shape(&mut page, "circle", &[[300.0, 100.0], [400.0, 180.0]], blue, 1.0, 2.0, None, "Camille").unwrap();
        an::add_shape(&mut page, "line", &[[100.0, 250.0], [300.0, 250.0]], red, 1.0, 4.0, None, "Camille").unwrap();
        an::add_shape(&mut page, "arrow", &[[100.0, 300.0], [300.0, 300.0]], blue, 1.0, 2.0, None, "Camille").unwrap();
        an::add_shape(&mut page, "polygon", &[[100.0, 400.0], [200.0, 360.0], [250.0, 450.0]], red, 1.0, 2.0, None, "Camille").unwrap();
        an::add_shape(&mut page, "polyline", &[[300.0, 400.0], [350.0, 360.0], [400.0, 420.0]], red, 1.0, 2.0, None, "Camille").unwrap();
        an::add_shape(&mut page, "cloud", &[[100.0, 500.0], [300.0, 500.0], [300.0, 600.0], [100.0, 600.0]], blue, 1.0, 2.0, None, "Camille").unwrap();
        assert!(an::add_shape(&mut page, "polygon", &[[1.0, 1.0], [2.0, 2.0]], red, 1.0, 1.0, None, "x").is_err(), "polygone à deux points refusé");
        assert!(an::add_shape(&mut page, "star", &[[1.0, 1.0], [9.0, 9.0]], red, 1.0, 1.0, None, "x").is_err(), "forme inconnue refusée");
        eng::fill::add_preset_stamp(&doc, &mut page, 450.0, 700.0, "approved", "Approuvé", Some("Camille · 14 novembre 2026"), "Camille").unwrap();
        assert!(eng::fill::add_preset_stamp(&doc, &mut page, 450.0, 700.0, "nope", "X", None, "Camille").is_err());
        note_id = an::add_note(&mut page, 500.0, 50.0, "Question", [255, 200, 0], "Camille").unwrap();
        reply_id = an::add_reply(&mut page, &note_id, "Réponse de Dominique", "Dominique").unwrap();
        an::set_status(&mut page, &note_id, Some("accepted"), Some(true)).unwrap();
        assert!(an::set_status(&mut page, &note_id, Some("bizarre"), None).is_err());

        // Rendu : contour rouge et intérieur jaune du rectangle, trait de la ligne, nuage dessiné.
        let border = pixel(&page, 101.0, 130.0);
        let inside = pixel(&page, 150.0, 130.0);
        let line = pixel(&page, 200.0, 250.0);
        assert!(border[0] > 150 && border[1] < 80, "contour du rectangle : {border:?}");
        assert!(inside[0] > 200 && inside[1] > 180 && inside[2] < 100, "intérieur jaune : {inside:?}");
        assert!(line[0] > 150 && line[2] < 80, "ligne rouge : {line:?}");
        let cloud_inked = (100..300).step_by(4).any(|x| pixel(&page, x as f32, 496.0)[2] > 120);
        assert!(cloud_inked, "festons du nuage au-dessus du bord haut");
        // La réponse ne se dessine pas : rien au-dessus de la note hormis son icône.
        eng::save(&doc, &saved, true).unwrap();
    }
    let doc = eng::open_typed(&pdfium, &saved, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let list = an::list(&page, 0);
    let kinds: Vec<&str> = list.iter().map(|a| a.kind).collect();
    for k in ["square", "circle", "line", "arrow", "polygon", "polyline", "cloud", "stamp", "note"] {
        assert!(kinds.contains(&k), "{k} absent de {kinds:?}");
    }
    let sq = list.iter().find(|a| a.id == square_id).unwrap();
    assert_eq!(sq.fill, Some(yellow));
    assert_eq!(sq.color, Some(red), "couleur du contour, pas du remplissage");
    assert_eq!(list.iter().find(|a| a.kind == "circle").unwrap().color, Some(blue));
    assert!((sq.width - 3.0).abs() < 0.01);
    let stamp = list.iter().find(|a| a.kind == "stamp").unwrap();
    assert!(stamp.contents.starts_with("APPROUVÉ"), "{}", stamp.contents);
    let note = list.iter().find(|a| a.id == note_id).unwrap();
    assert_eq!(note.status.as_deref(), Some("accepted"));
    assert!(note.marked);
    let reply = list.iter().find(|a| a.id == reply_id).unwrap();
    assert_eq!(reply.reply_to.as_deref(), Some(note_id.as_str()));
    assert_eq!(reply.author, "Dominique");
    drop(page);

    // Supprimer le commentaire emporte sa réponse.
    let mut page = doc.pages().get(0).unwrap();
    an::delete(&mut page, &note_id).unwrap();
    let after = an::list(&page, 0);
    assert!(after.iter().all(|a| a.id != reply_id && a.id != note_id), "réponse supprimée avec son commentaire");
    let _ = std::fs::remove_dir_all(&dir);
}

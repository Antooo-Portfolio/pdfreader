//! Tests du lot « formulaires et signature » (M2) : saisie AcroForm par le moteur interactif,
//! tampons texte / coche / signature, enregistrement et relecture.

use std::path::Path;

use pdfreader_engine as eng;
use pdfreader_engine::fill::{self, FieldInput};

mod common;
use common::{pdfium, corpus};

fn tmp(name: &str, from: &Path) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pdfreader-fill-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::copy(from, &p).unwrap();
    p
}

fn pixel(page: &pdfium_render::prelude::PdfPage, x: f32, y: f32) -> [u8; 3] {
    let t = eng::render_page(page, 1.0).unwrap();
    let i = ((y as i32 * t.width + x as i32) * 4) as usize;
    [t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]]
}

#[test]
fn acroform_fill_save_reload() {
    let Some(src) = corpus("08-formulaire-acroform.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let path = tmp("form.pdf", &src);
    let pdfium = pdfium();
    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let page = doc.pages().get(0).unwrap();
        let fields = fill::fields(&doc, &page, 0);
        let by = |n: &str| fields.iter().find(|f| f.name == n).unwrap_or_else(|| panic!("champ {n} absent : {fields:#?}"));
        assert_eq!(by("nom").kind, "text");
        assert!(by("commentaire").multiline);
        assert_eq!(by("accepte").kind, "checkbox");
        assert!(!by("accepte").checked);
        let radios: Vec<_> = fields.iter().filter(|f| f.name == "formule").collect();
        assert_eq!(radios.len(), 2);
        assert!(radios[0].checked && !radios[1].checked);
        let pays = by("pays");
        assert_eq!(pays.kind, "combo");
        assert_eq!(pays.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["France", "Belgique", "Suisse", "Canada"]);
        assert_eq!(by("nom").label, "Nom");

        fill::set_field(&doc, &page, by("nom").index, &FieldInput::Text { value: "Élodie Martin".into() }).unwrap();
        fill::set_field(&doc, &page, by("commentaire").index, &FieldInput::Text { value: "Ligne 1\nLigne 2".into() }).unwrap();
        fill::set_field(&doc, &page, by("accepte").index, &FieldInput::Checked { checked: true }).unwrap();
        fill::set_field(&doc, &page, radios[1].index, &FieldInput::Checked { checked: true }).unwrap();
        fill::set_field(&doc, &page, pays.index, &FieldInput::Choice { index: 2 }).unwrap();

        let after = fill::fields(&doc, &page, 0);
        let by = |n: &str| after.iter().find(|f| f.name == n).unwrap();
        assert_eq!(by("nom").value, "Élodie Martin");
        assert!(by("commentaire").value.contains("Ligne 2"), "{:?}", by("commentaire").value);
        assert!(by("accepte").checked);
        let radios: Vec<_> = after.iter().filter(|f| f.name == "formule").collect();
        assert!(!radios[0].checked && radios[1].checked, "{radios:#?}");
        assert_eq!(by("pays").value, "Suisse");
        eng::save(&doc, &path, true).unwrap();
    }
    let doc = eng::open_typed(&pdfium, &path, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let f = fill::fields(&doc, &page, 0);
    let by = |n: &str| f.iter().find(|x| x.name == n).unwrap();
    assert_eq!(by("nom").value, "Élodie Martin");
    assert!(by("accepte").checked);
    assert_eq!(by("pays").value, "Suisse");
    assert!(f.iter().filter(|x| x.name == "formule").nth(1).unwrap().checked);
}

#[test]
fn stamps_text_mark_signature() {
    let Some(src) = corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let path = tmp("stamps.pdf", &src);
    let pdfium = pdfium();
    // Signature : trait noir de 4 px sur fond transparent, 200 × 60.
    let mut img = image::RgbaImage::new(200, 60);
    for x in 10..190 {
        for y in 28..32 {
            img.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
    }
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let mut page = doc.pages().get(0).unwrap();
        let t = fill::add_text(&doc, &mut page, 300.0, 700.0, "Élodie Martin\n12 rue des Lilas", 14.0, [0, 0, 160], "Élodie").unwrap();
        let c = fill::add_mark(&mut page, 300.0, 760.0, 16.0, false, [0, 0, 0], "Élodie").unwrap();
        // Signature posée sur une zone blanche à droite (x 400..500).
        let s = fill::add_image(&doc, &mut page, [400.0, 600.0, 100.0, 30.0], &png, "signature", "Élodie").unwrap();
        let list = eng::annotations::list(&page, 0);
        let kinds: Vec<_> = list.iter().map(|a| (a.id.clone(), a.kind)).collect();
        assert!(kinds.contains(&(t.clone(), "text")), "{kinds:?}");
        assert!(kinds.contains(&(c.clone(), "mark")), "{kinds:?}");
        assert!(kinds.contains(&(s.clone(), "signature")), "{kinds:?}");
        let text = list.iter().find(|a| a.id == t).unwrap();
        assert_eq!(text.contents, "Élodie Martin\n12 rue des Lilas");
        // Le texte occupe deux lignes à partir de y = 700 (depuis le haut).
        assert!((text.rect[1] - 700.0).abs() < 4.0 && text.rect[3] > 25.0 && text.rect[3] < 40.0, "{:?}", text.rect);
        // Rendu : le trait de la signature est noir (milieu de l'image), le fond reste blanc
        // (transparence conservée) juste au-dessus du trait.
        let ink = pixel(&page, 450.0, 615.0);
        let around = pixel(&page, 450.0, 603.0);
        assert!(ink[0] < 60, "trait de signature attendu : {ink:?}");
        assert!(around[0] > 240 && around[2] > 240, "fond transparent attendu : {around:?}");
        // Texte bleu foncé quelque part dans sa première ligne.
        let t0 = eng::render_page(&page, 1.0).unwrap();
        let blue = (300..420).flat_map(|x| (702..716).map(move |y| (x, y))).any(|(x, y)| {
            let i = ((y * t0.width + x) * 4) as usize;
            t0.rgba[i + 2] > 100 && t0.rgba[i] < 60
        });
        assert!(blue, "texte bleu attendu");
        eng::save(&doc, &path, true).unwrap();
    }
    let doc = eng::open_typed(&pdfium, &path, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let list = eng::annotations::list(&page, 0);
    assert_eq!(list.iter().filter(|a| matches!(a.kind, "text" | "mark" | "signature")).count(), 3, "{list:#?}");
    assert!(pixel(&page, 450.0, 615.0)[0] < 60, "signature après relecture");
}

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

#[test]
fn textbox_and_callout() {
    let Some(src) = corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let path = tmp("textbox.pdf", &src);
    let pdfium = pdfium();
    {
        let doc = eng::open_typed(&pdfium, &path, None).unwrap();
        let mut page = doc.pages().get(1).unwrap();
        // Texte long dans une zone étroite : renvoyé à la ligne, la zone grandit.
        let long = "Merci de relire ce paragraphe et de confirmer les montants avant vendredi.";
        let tb = fill::add_textbox(&doc, &mut page, [300.0, 60.0, 150.0, 20.0], long, 10.0, [200, 0, 0], Some([255, 255, 255]), None, "Élodie").unwrap();
        let co = fill::add_textbox(&doc, &mut page, [380.0, 700.0, 140.0, 20.0], "Signature ici", 11.0, [0, 0, 200], None, Some([200.0, 780.0]), "Élodie").unwrap();
        let list = eng::annotations::list(&page, 1);
        let a = list.iter().find(|x| x.id == tb).unwrap();
        assert_eq!(a.kind, "textbox");
        assert_eq!(a.contents, long);
        assert!(a.filled);
        assert_eq!(a.text_box, Some([300.0, 60.0, 150.0, 20.0]));
        // Plusieurs lignes : plus haute que la hauteur minimale demandée.
        assert!(a.rect[3] > 40.0, "zone agrandie attendue : {:?}", a.rect);
        let c = list.iter().find(|x| x.id == co).unwrap();
        assert_eq!(c.kind, "callout");
        assert_eq!(c.anchor, Some([200.0, 780.0]));
        // Le rectangle de la légende englobe le point désigné.
        assert!(c.rect[0] <= 195.0 && c.rect[1] + c.rect[3] >= 784.0, "{:?}", c.rect);

        let t = eng::render_page(&page, 1.0).unwrap();
        let px = |x: i32, y: i32| {
            let i = ((y * t.width + x) * 4) as usize;
            [t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]]
        };
        // Cadre rouge (bord gauche de la zone) et fond blanc par-dessus le texte de la page.
        // Le trait d'un point est lissé sur deux colonnes de pixels.
        let red = (60..90).filter(|&y| (298..=301).any(|x| { let p = px(x, y); p[0] > 150 && p[1] < 140 && p[2] < 140 })).count();
        assert!(red > 10, "cadre rouge attendu ({red})");
        let inside = (302..448).flat_map(|x| (62..90).map(move |y| (x, y))).filter(|&(x, y)| { let p = px(x, y); p[0] > 150 && p[1] < 90 }).count();
        assert!(inside > 30, "texte rouge dans la zone ({inside})");
        // Pointe de la flèche (bleue) au point désigné.
        let tip = (196..206).flat_map(|x| (774..786).map(move |y| (x, y))).filter(|&(x, y)| { let p = px(x, y); p[2] > 150 && p[0] < 90 }).count();
        assert!(tip > 5, "pointe de flèche attendue ({tip})");
        eng::save(&doc, &path, true).unwrap();
    }
    let doc = eng::open_typed(&pdfium, &path, None).unwrap();
    let page = doc.pages().get(1).unwrap();
    let list = eng::annotations::list(&page, 1);
    assert_eq!(list.iter().filter(|a| a.kind == "textbox" || a.kind == "callout").count(), 2);
}

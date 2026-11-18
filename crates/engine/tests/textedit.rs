//! Phase 2, « Modifier le texte » : lignes de texte retrouvées (police, taille, couleur), texte
//! modifié avec la police d'origine quand elle a les glyphes voulus, police proche sinon (police
//! intégrée en sous-ensemble), couleur et place conservées, modification refusée sur une page
//! changée entre-temps, ligne effacée, résultat relu après enregistrement.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::pagetext::FontCache;
use pdfreader_engine::textedit::{edit, lines};

fn words(page: &PdfPage) -> String {
    eng::text_layer(page).unwrap().iter().flatten().map(|w| w.t.clone()).collect()
}

/// Pixels foncés (texte) dans un rectangle (points depuis le haut).
fn ink(page: &PdfPage, r: [f32; 4]) -> usize {
    let t = eng::render_page(page, 1.0).unwrap();
    let mut n = 0;
    for y in r[1] as usize..(r[1] + r[3]) as usize {
        for x in r[0] as usize..(r[0] + r[2]) as usize {
            let o = (y * t.width as usize + x) * 4;
            if o + 2 < t.rgba.len() && t.rgba[o] < 160 && t.rgba[o + 1] < 160 {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn edit_existing_text() {
    let (Some(sub), Some(std_pdf)) = (common::corpus("14-police-integree.pdf"), common::corpus("01-texte-10p.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-textedit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut fonts = FontCache::new();

    // Police intégrée en sous-ensemble.
    let doc = eng::open_typed(&pdfium, &sub, None).unwrap();
    let mut page = doc.pages().get(0).unwrap();
    let ls = lines(&page, 0);
    let texts: Vec<&str> = ls.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, vec!["Bonjour le monde", "Une ligne simple avec peu de lettres.", "Texte bleu à modifier."], "{texts:?}");
    let title = &ls[0];
    assert_eq!((title.font.as_str(), title.size, title.embedded), ("ArialMT", 20.0, true));
    assert!((title.rect[1] - 62.0).abs() < 8.0, "{:?}", title.rect);
    assert_eq!(ls[2].color, [26, 77, 179]);

    // Lettres déjà présentes : la police d'origine est gardée.
    let r = edit(&doc, &mut page, &mut fonts, &title.objects, &title.text, "Bonjour monde").unwrap();
    assert!(r.kept_font);
    assert!(words(&page).contains("Bonjourmonde") || words(&page).contains("Bonjour monde"));
    assert!(fonts.is_empty());

    // Lettres absentes du sous-ensemble (z, è, k, w) : police proche, texte bien dessiné.
    let ls = lines(&page, 0);
    let second = ls.iter().find(|l| l.text.starts_with("Une ligne")).unwrap().clone();
    let r = edit(&doc, &mut page, &mut fonts, &second.objects, &second.text, "Zèbre et kiwi").unwrap();
    assert!(!r.kept_font);
    let ls = lines(&page, 0);
    let changed = ls.iter().find(|l| l.text == "Zèbre et kiwi").expect("ligne modifiée relue");
    assert!((changed.rect[1] - second.rect[1]).abs() < 4.0 && (changed.rect[0] - second.rect[0]).abs() < 2.0, "même place");
    assert!((changed.size - 12.0).abs() < 0.1);
    assert!(ink(&page, changed.rect) > 40, "texte dessiné");

    // Couleur conservée avec la police proche.
    let blue = ls.iter().find(|l| l.text.starts_with("Texte bleu")).unwrap().clone();
    edit(&doc, &mut page, &mut fonts, &blue.objects, &blue.text, "Texte bleu modifié, éèê").unwrap();
    let ls = lines(&page, 0);
    let b2 = ls.iter().find(|l| l.text == "Texte bleu modifié, éèê").expect("ligne bleue relue");
    assert_eq!(b2.color, [26, 77, 179]);

    // Page changée entre-temps : refus.
    assert!(edit(&doc, &mut page, &mut fonts, &blue.objects, &blue.text, "x").is_err());

    // Ligne effacée.
    let t = ls.iter().find(|l| l.text == "Bonjour monde").unwrap().clone();
    edit(&doc, &mut page, &mut fonts, &t.objects, &t.text, "").unwrap();
    assert!(!lines(&page, 0).iter().any(|l| l.text == "Bonjour monde"));
    drop(page);

    // Enregistré et relu.
    let out = dir.join("modifie.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    let texts: Vec<String> = lines(&back.pages().get(0).unwrap(), 0).into_iter().map(|l| l.text).collect();
    assert_eq!(texts, vec!["Zèbre et kiwi".to_string(), "Texte bleu modifié, éèê".to_string()]);

    // Police standard (non intégrée) : toujours gardée.
    let d2 = eng::open_typed(&pdfium, &std_pdf, None).unwrap();
    let mut p2 = d2.pages().get(0).unwrap();
    let title = lines(&p2, 0).into_iter().find(|l| l.text.starts_with("Texte simple")).unwrap();
    assert_eq!(title.font, "Helvetica-Bold");
    assert!(title.bold);
    let before = lines(&p2, 0).len();
    let r = edit(&d2, &mut p2, &mut fonts, &title.objects, &title.text, "Titre changé — page 1").unwrap();
    assert!(r.kept_font);
    assert!(lines(&p2, 0).iter().any(|l| l.text == "Titre changé — page 1"));
    assert_eq!(lines(&p2, 0).len(), before, "les autres lignes ne bougent pas");

    drop((p2, d2, back, doc));
    let _ = std::fs::remove_dir_all(&dir);
}

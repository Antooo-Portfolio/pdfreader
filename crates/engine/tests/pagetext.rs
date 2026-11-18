//! Phase 2, « Ajouter du texte » : bloc écrit dans le contenu de la page (texte sélectionnable et
//! cherchable, rendu en couleur), retrouvé après enregistrement, modifié, déplacé, supprimé ;
//! texte d'origine intact ; police TrueType intégrée une seule fois pour le cyrillique et le grec.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::pagetext::{Family, FontCache, TextStyle, delete, list, set};

fn words(page: &PdfPage) -> String {
    eng::text_layer(page).unwrap().iter().flatten().map(|w| w.t.clone()).collect()
}

fn red_pixels(page: &PdfPage) -> usize {
    let t = eng::render_page(page, 1.0).unwrap();
    t.rgba.as_chunks::<4>().0.iter().filter(|p| p[0] > 180 && p[1] < 80 && p[2] < 80).count()
}

#[test]
fn text_in_page_content() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-pagetext-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let mut fonts = FontCache::new();
    let red = TextStyle { family: Family::Sans, bold: true, italic: false, size: 14.0, color: [220, 0, 0] };

    let mut page = doc.pages().get(0).unwrap();
    let before = words(&page);
    assert_eq!(red_pixels(&page), 0);
    let id = set(&doc, &mut page, &mut fonts, None, 300.0, 700.0, "Bonjour à tous\nDeuxième ligne — 12 €", &red).unwrap().unwrap();
    let blocks = list(&page, 0);
    assert_eq!(blocks.len(), 1);
    let b = &blocks[0];
    assert_eq!((b.id.as_str(), b.text.as_str(), b.x, b.y), (id.as_str(), "Bonjour à tous\nDeuxième ligne — 12 €", 300.0, 700.0));
    assert_eq!(b.style, red);
    assert!((b.rect[0] - 300.0).abs() < 3.0 && (b.rect[1] - 700.0).abs() < 6.0 && b.rect[3] > 25.0, "{:?}", b.rect);
    // Du vrai texte : présent dans la couche de texte (sélection, recherche), rendu en rouge.
    let after = words(&page);
    assert!(after.contains("Bonjour") && after.contains("Deuxième"), "{after}");
    assert!(after.contains("Textesimple") || after.contains("Texte simple"), "texte d'origine intact");
    assert!(after.len() > before.len());
    assert!(red_pixels(&page) > 100);
    assert!(fonts.is_empty(), "polices standard : rien d'intégré");

    // Modification : autre texte, autre place, autre police.
    let serif = TextStyle { family: Family::Serif, bold: false, italic: true, size: 20.0, color: [0, 0, 160] };
    set(&doc, &mut page, &mut fonts, Some(&id), 60.0, 40.0, "Modifié", &serif).unwrap();
    let blocks = list(&page, 0);
    assert_eq!(blocks.len(), 1);
    assert_eq!((blocks[0].text.as_str(), blocks[0].x, blocks[0].y, blocks[0].style.family), ("Modifié", 60.0, 40.0, Family::Serif));
    let w = words(&page);
    assert!(w.contains("Modifié") && !w.contains("Bonjour"));

    // Cyrillique et grec : police TrueType intégrée, une seule fois pour deux blocs.
    let sans = TextStyle { family: Family::Sans, bold: false, italic: false, size: 12.0, color: [0, 0, 0] };
    let cyr = set(&doc, &mut page, &mut fonts, None, 60.0, 760.0, "Привет, Ελλάδα, Łódź", &sans).unwrap().unwrap();
    set(&doc, &mut page, &mut fonts, None, 60.0, 780.0, "Добрый день", &sans).unwrap();
    assert_eq!(fonts.len(), 1, "une seule intégration");
    let w = words(&page);
    assert!(w.contains("Привет") && w.contains("Ελλάδα") && w.contains("Łódź"), "{w}");
    assert_eq!(list(&page, 0).len(), 3);
    drop(page);

    // Enregistré et relu : les blocs sont retrouvés (texte, style, position).
    let out = dir.join("texte.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    let mut p = back.pages().get(0).unwrap();
    let blocks = list(&p, 0);
    assert_eq!(blocks.len(), 3);
    assert!(blocks.iter().any(|b| b.text == "Привет, Ελλάδα, Łódź" && b.style == sans));
    assert!(blocks.iter().any(|b| b.text == "Modifié" && b.style == serif));
    assert!(words(&p).contains("Texte simple — page 1") || words(&p).contains("Textesimple"), "texte d'origine intact après enregistrement");

    // Suppression.
    let mut fonts2 = FontCache::new();
    delete(&mut p, &cyr).unwrap();
    assert_eq!(list(&p, 0).len(), 2);
    assert!(!words(&p).contains("Привет"));
    assert!(delete(&mut p, &cyr).is_err(), "déjà supprimé");
    // Texte vide : le bloc disparaît.
    let modified = list(&p, 0).into_iter().find(|b| b.text == "Modifié").unwrap();
    set(&back, &mut p, &mut fonts2, Some(&modified.id), 0.0, 0.0, "   ", &serif).unwrap();
    assert_eq!(list(&p, 0).len(), 1);

    drop((p, back, doc));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Déplacer un bloc dans un document rouvert depuis le fichier : le rendu (page rechargée, comme
/// pour une tuile) montre le texte à la nouvelle place.
#[test]
fn moved_text_is_rendered_at_new_place() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else { return };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-pagetext-move-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let red = TextStyle { family: Family::Sans, bold: true, italic: false, size: 30.0, color: [230, 0, 0] };
    let red_at = |doc: &PdfDocument, x: f32, y: f32| {
        let p = doc.pages().get(0).unwrap();
        let t = eng::render_page(&p, 1.0).unwrap();
        let (x0, y0) = (x as usize, y as usize);
        let mut n = 0;
        for yy in y0..y0 + 30 {
            for xx in x0..x0 + 200 {
                let o = (yy * t.width as usize + xx) * 4;
                if t.rgba[o] > 180 && t.rgba[o + 1] < 80 && t.rgba[o + 2] < 80 {
                    n += 1;
                }
            }
        }
        n
    };
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let mut fonts = FontCache::new();
    let id = {
        let mut p = doc.pages().get(0).unwrap();
        set(&doc, &mut p, &mut fonts, None, 100.0, 300.0, "ROUGE", &red).unwrap().unwrap()
    };
    let saved = dir.join("a.pdf");
    eng::save(&doc, &saved, true).unwrap();
    drop(doc);
    let doc = eng::open_typed(&pdfium, &saved, None).unwrap();
    assert!(red_at(&doc, 100.0, 300.0) > 50, "texte rendu à la première place");
    {
        let mut p = doc.pages().get(0).unwrap();
        let mut f2 = FontCache::new();
        set(&doc, &mut p, &mut f2, Some(&id), 100.0, 500.0, "ROUGE", &red).unwrap();
    }
    let at_new = red_at(&doc, 100.0, 500.0);
    let at_old = red_at(&doc, 100.0, 300.0);
    eprintln!("après déplacement : {at_new} pixels rouges à la nouvelle place, {at_old} à l'ancienne");
    assert!(at_new > 50 && at_old == 0);
    drop(doc);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Même enchaînement que l'application : écrire, enregistrer (incrémental), rouvrir, rendre une
/// tuile, déplacer, rendre la même tuile.
#[test]
fn tile_after_move_following_save() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else { return };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-pagetext-tile-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let st = TextStyle { family: Family::Sans, bold: true, italic: false, size: 12.0, color: [0, 0, 0] };
    let work = dir.join("w.pdf");
    std::fs::copy(&src, &work).unwrap();
    let doc = eng::open_typed(&pdfium, &work, None).unwrap();
    let mut fonts = FontCache::new();
    let id = {
        let mut p = doc.pages().get(0).unwrap();
        set(&doc, &mut p, &mut fonts, None, 310.0, 650.0, "Texte modifié", &st).unwrap().unwrap()
    };
    eng::save(&doc, &work.with_extension("tmp"), true).unwrap();
    std::fs::rename(work.with_extension("tmp"), &work).unwrap();
    let doc2 = eng::open_typed(&pdfium, &work, None).unwrap();
    drop(doc);
    let tile = |d: &PdfDocument| {
        let p = d.pages().get(0).unwrap();
        eng::tile_webp(&eng::render_tile(&p, 1.9693, 512, 1024, 512).unwrap()).unwrap()
    };
    let before = tile(&doc2);
    {
        let mut p = doc2.pages().get(0).unwrap();
        let mut f2 = FontCache::new();
        set(&doc2, &mut p, &mut f2, Some(&id), 340.0, 670.0, "Texte modifié", &st).unwrap();
    }
    let after = tile(&doc2);
    eprintln!("tuile avant {} octets, après {} octets, identiques : {}", before.len(), after.len(), before == after);
    assert_ne!(before, after, "la tuile doit changer après le déplacement");
    drop(doc2);
    let _ = std::fs::remove_dir_all(&dir);
}

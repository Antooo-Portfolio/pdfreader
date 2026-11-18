//! Phase 2, « Reconnaître le texte (OCR) » : page numérisée sans texte, mots lus par l'OCR de
//! Windows, couche de texte invisible posée sur l'encre (aspect inchangé), recherche, relecture
//! après enregistrement, nouvelle reconnaissance qui remplace l'ancienne, retrait.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::ocr::{add_layer, has_text, languages, recognize_page, remove_layer};
use pdfreader_engine::pagetext::FontCache;

fn words(page: &PdfPage) -> Vec<eng::TextWord> {
    eng::text_layer(page).unwrap().into_iter().flatten().collect()
}

#[test]
fn ocr_makes_scans_searchable() {
    let (Some(scan), Some(text)) = (common::corpus("06-scan-sans-texte.pdf"), common::corpus("01-texte-10p.pdf")) else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let langs = languages();
    if langs.is_empty() {
        eprintln!("aucune langue OCR installée dans Windows : test ignoré");
        return;
    }
    let lang = langs.iter().find(|l| l.tag.starts_with("fr")).unwrap_or(&langs[0]).tag.clone();
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-ocr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Une page de texte en a déjà ; la page numérisée n'en a pas.
    let t = eng::open_typed(&pdfium, &text, None).unwrap();
    assert!(has_text(&t.pages().get(0).unwrap()));
    let doc = eng::open_typed(&pdfium, &scan, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    assert!(!has_text(&page));
    assert!(words(&page).is_empty());
    let before = eng::render_page(&page, 1.0).unwrap();

    // Reconnaissance : une trentaine de lignes de mots.
    let t0 = std::time::Instant::now();
    let lines = recognize_page(&page, Some(&lang)).unwrap();
    let total: usize = lines.iter().map(|l| l.len()).sum();
    eprintln!("OCR ({lang}) : {} lignes, {total} mots en {:?}", lines.len(), t0.elapsed());
    assert!(lines.len() >= 25 && total >= 200, "{} lignes, {total} mots", lines.len());
    let sample: Vec<&str> = lines[0].iter().map(|w| w.text.as_str()).collect();
    eprintln!("première ligne : {sample:?}");

    // Couche invisible : l'aspect ne change pas, le texte devient lisible et cherchable.
    let mut fonts = FontCache::new();
    let n = add_layer(&doc, &page, &mut fonts, &lines).unwrap();
    assert_eq!(n, total);
    assert!(!has_text(&page), "la couche OCR de PDFReader ne compte pas comme texte d'origine");
    let after = eng::render_page(&page, 1.0).unwrap();
    assert_eq!(before.rgba, after.rgba, "aspect inchangé");
    let ws = words(&page);
    assert!(ws.len() >= total * 9 / 10, "{} mots lus pour {total} reconnus", ws.len());

    // Les mots sont posés sur l'encre : presque toute l'encre tombe dans une boîte de mot.
    let w = after.width as usize;
    let (mut ink, mut covered) = (0usize, 0usize);
    for y in (0..after.height as usize).step_by(2) {
        for x in (0..w).step_by(2) {
            let o = (y * w + x) * 4;
            if after.rgba[o] < 100 {
                ink += 1;
                if ws.iter().any(|b| x as f32 + 0.5 >= b.x - 1.5 && x as f32 + 0.5 <= b.x + b.w + 1.5 && y as f32 + 0.5 >= b.y - 1.5 && y as f32 + 0.5 <= b.y + b.h + 1.5) {
                    covered += 1;
                }
            }
        }
    }
    assert!(ink > 2000 && covered as f32 / ink as f32 > 0.9, "{covered}/{ink} pixels d'encre dans les mots");

    // Recherche d'un mot reconnu (assez long pour être sans ambiguïté).
    let probe = lines.iter().flatten().map(|w| w.text.trim_matches(|c: char| !c.is_alphanumeric())).find(|t| t.chars().count() >= 7).expect("mot long").to_string();
    let found = eng::reading::search(&doc, 0, 1, &probe, false, false).unwrap();
    assert!(!found.pages.is_empty() && !found.pages[0].hits.is_empty(), "« {probe} » introuvable");
    drop(page);

    // Enregistré et relu ; reconnaître de nouveau remplace la couche ; retrait.
    let out = dir.join("cherchable.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    let p = back.pages().get(0).unwrap();
    assert!(words(&p).len() >= total * 9 / 10);
    let n2 = add_layer(&back, &p, &mut FontCache::new(), &lines).unwrap();
    assert_eq!(n2, total);
    assert!(words(&p).len() <= ws.len() + 5, "pas de doublon après une nouvelle reconnaissance");
    assert_eq!(remove_layer(&p).unwrap(), total);
    assert!(words(&p).is_empty());
    drop((p, back, doc, t));
    let _ = std::fs::remove_dir_all(&dir);
}

//! Phase 2, « Filigrane, en-têtes et pieds de page » : filigrane transparent au centre, en-tête et
//! pied de page aux bons coins (page pivotée comprise), numéros remplis page par page, réglage
//! relu, nouvelle application qui remplace l'ancienne, retrait complet, texte d'origine intact.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::pagetext::FontCache;
use pdfreader_engine::stamps::{Band, StampConfig, Watermark, apply, current, remove};

fn words(page: &PdfPage) -> Vec<eng::TextWord> {
    eng::text_layer(page).unwrap().into_iter().flatten().collect()
}

fn joined(page: &PdfPage) -> String {
    words(page).iter().map(|w| w.t.clone()).collect()
}

/// Caractères de la page, triés : l'ordre de lecture et le découpage en mots peuvent changer
/// quand le contenu est régénéré.
fn bag(page: &PdfPage) -> Vec<char> {
    let mut v: Vec<char> = words(page).iter().flat_map(|w| w.t.chars()).filter(|c| !c.is_whitespace()).collect();
    v.sort();
    v
}

/// Mot (début) et sa boîte, dans la page affichée.
fn find(page: &PdfPage, start: &str) -> Option<eng::TextWord> {
    words(page).into_iter().find(|w| w.t.trim_end().starts_with(start))
}

fn config() -> StampConfig {
    StampConfig {
        watermark: Some(Watermark { text: "CONFIDENTIEL".into(), size: 60.0, color: [200, 30, 30], opacity: 0.3, diagonal: true }),
        header: Band { left: "{fichier}".into(), center: String::new(), right: "{date}".into() },
        footer: Band { left: String::new(), center: "Page {page} sur {pages}".into(), right: String::new() },
        size: 10.0,
        color: [0, 0, 0],
        margin: 30.0,
        pages: vec![],
        first_number: 1,
    }
}

#[test]
fn watermark_headers_and_numbers() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-stamps-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let total = doc.pages().len();
    let mut fonts = FontCache::new();
    let original: Vec<Vec<char>> = (0..total).map(|i| bag(&doc.pages().get(i).unwrap())).collect();
    // Page 2 pivotée d'un quart de tour : le texte doit rester droit, en haut et en bas de l'affichage.
    eng::pages::rotate(&doc, &[1], 1).unwrap();

    assert!(current(&doc).is_none());
    let n = apply(&doc, &mut fonts, &config(), "rapport.pdf", "18/11/2026").unwrap();
    assert_eq!(n, total as usize);
    if let Ok(out) = std::env::var("PDFREADER_STAMPS_OUT") {
        eng::save(&doc, std::path::Path::new(&out), false).unwrap();
        let o = eng::export::ImageOptions { format: eng::export::ImageKind::Png, dpi: 60.0, quality: 90, annotations: true };
        for i in [0, 1] {
            eng::export::export_page(&doc.pages().get(i).unwrap(), &o, std::path::Path::new(&format!("{out}.{i}.png"))).unwrap();
        }
    }
    let c = current(&doc).expect("réglage relu");
    assert_eq!(c, config());

    {
        let i = 0;
        let page = doc.pages().get(i).unwrap();
        let (w, h) = (page.width().value, page.height().value);
        let foot = words(&page).into_iter().find(|x| x.t.starts_with("Page") && x.y > h / 2.0).expect("pied de page");
        assert!(foot.y > h - 60.0 && foot.y < h - 20.0, "pied en bas (page {i}) : {foot:?} h={h}");
        let fx = foot.x;
        assert!(fx > w * 0.3 && fx < w * 0.5, "pied centré (page {i}) : {foot:?} w={w}");
        let file = find(&page, "rapport.pdf").expect("nom du fichier");
        assert!(file.y < 50.0 && file.x < 40.0 && file.x > 25.0, "en-tête à gauche (page {i}) : {file:?}");
        let date = find(&page, "18/11/2026").expect("date");
        assert!(date.y < 50.0 && (date.x + date.w) > w - 35.0 && (date.x + date.w) < w - 25.0, "date à droite (page {i}) : {date:?}");
        // Le filigrane couvre le centre de la page, en diagonale (boîte à peu près carrée).
        // Le texte en diagonale est lu en morceaux : on prend la boîte qui les englobe.
        let parts: Vec<_> = words(&page).into_iter().filter(|x| x.h > 50.0).collect();
        assert_eq!(parts.iter().map(|x| x.t.trim()).collect::<String>(), "CONFIDENTIEL", "filigrane (page {i})");
        let (x0, y0) = parts.iter().fold((f32::MAX, f32::MAX), |(a, b), x| (a.min(x.x), b.min(x.y)));
        let (x1, y1) = parts.iter().fold((0f32, 0f32), |(a, b), x| (a.max(x.x + x.w), b.max(x.y + x.h)));
        let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        assert!((cx - w / 2.0).abs() < 20.0 && (cy - h / 2.0).abs() < 20.0, "filigrane centré (page {i}) : {x0} {y0} {x1} {y1}");
        assert!(y1 - y0 > 200.0 && ((x1 - x0) / (y1 - y0) - 1.0).abs() < 0.2, "filigrane en diagonale (page {i})");
    }
    // Page pivotée : vérifiée sur l'image affichée (en-tête et pied droits, aux bons endroits).
    {
        let page = doc.pages().get(1).unwrap();
        let (w, h) = (page.width().value, page.height().value);
        assert!(w > h, "page affichée en paysage");
        let t = eng::render_page(&page, 1.0).unwrap();
        // Boîte de l'encre foncée dans une zone (pixels = points à l'échelle 1).
        let ink = |x0: f32, y0: f32, x1: f32, y1: f32| {
            let (mut a, mut b, mut c, mut d) = (u32::MAX, u32::MAX, 0, 0);
            for y in y0 as u32..y1 as u32 {
                for x in x0 as u32..x1 as u32 {
                    let o = ((y * t.width as u32 + x) * 4) as usize;
                    if t.rgba[o] < 110 && t.rgba[o + 1] < 110 && t.rgba[o + 2] < 110 {
                        (a, b, c, d) = (a.min(x), b.min(y), c.max(x), d.max(y));
                    }
                }
            }
            (a <= c).then_some((a as f32, b as f32, c as f32, d as f32))
        };
        let (a, b, c, d) = ink(0.0, 0.0, 200.0, 50.0).expect("en-tête gauche dessiné");
        assert!((a - 30.0).abs() < 3.0 && d < 45.0 && (c - a) > 3.0 * (d - b), "en-tête gauche droit : {a} {b} {c} {d}");
        let (_, _, c, d) = ink(w - 200.0, 0.0, w, 50.0).expect("date dessinée");
        assert!((c - (w - 30.0)).abs() < 3.0 && d < 45.0, "date à droite : {c} {d}");
        let (a, b, c, d) = ink(w / 2.0 - 150.0, h - 60.0, w / 2.0 + 150.0, h).expect("pied dessiné");
        assert!(((a + c) / 2.0 - w / 2.0).abs() < 3.0 && d < h - 25.0 && b > h - 50.0 && (c - a) > 3.0 * (d - b), "pied centré et droit : {a} {b} {c} {d}");
    }
    // Numéros remplis page par page.
    let all = joined(&doc.pages().get(4).unwrap());
    assert!(all.contains(&format!("Page 5 sur {total}")) || all.contains(&format!("Page 5 sur{total}")), "{all}");
    // Transparence : le rouge du filigrane est pâle, pas plein.
    let tile = eng::render_page(&doc.pages().get(0).unwrap(), 1.0).unwrap();
    let px = tile.rgba.as_chunks::<4>().0;
    assert!(px.iter().any(|p| p[0] > 230 && p[1] > 150 && p[1] < 225 && (p[1] as i32 - p[2] as i32).abs() < 12), "rouge pâle");
    assert!(!px.iter().any(|p| p[0] > 180 && p[1] < 60 && p[2] < 60), "pas de rouge plein");

    // Nouvelle application : remplace l'ancienne (pages 1 à 3, numérotées à partir de 10, sans filigrane).
    let mut c2 = config();
    c2.watermark = None;
    c2.header = Band::default();
    c2.footer = Band { left: String::new(), center: String::new(), right: "{page}/{pages}".into() };
    c2.pages = vec![0, 1, 2];
    c2.first_number = 10;
    assert_eq!(apply(&doc, &mut fonts, &c2, "rapport.pdf", "18/11/2026").unwrap(), 3);
    let p0 = joined(&doc.pages().get(0).unwrap());
    assert!(!p0.contains("CONFIDENTIEL") && !p0.contains("rapport.pdf") && p0.contains("10/12"), "{p0}");
    assert!(joined(&doc.pages().get(2).unwrap()).contains("12/12"));
    assert_eq!(bag(&doc.pages().get(5).unwrap()), original[5], "pages hors sélection rendues à l'origine");
    assert!(apply(&doc, &mut fonts, &StampConfig { watermark: None, header: Band::default(), footer: Band::default(), ..config() }, "", "").is_err());

    // Enregistré, relu, puis tout retiré.
    let out = dir.join("filigrane.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    assert_eq!(current(&back).map(|c| c.first_number), Some(10));
    assert_eq!(remove(&back).unwrap(), 3);
    assert!(current(&back).is_none());
    for i in 0..total {
        assert_eq!(bag(&back.pages().get(i).unwrap()), original[i as usize], "page {i} rendue à l'origine");
    }
    drop((back, doc));
    let _ = std::fs::remove_dir_all(&dir);
}

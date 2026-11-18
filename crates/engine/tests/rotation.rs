//! Pages pivotées (/Rotate) : toutes les positions échangées avec l'interface sont celles de la
//! page affichée. Pour chaque quart de tour : couche de texte posée sur l'encre du rendu,
//! recherche et lignes à modifier sur les mêmes mots, forme, dessin et surlignage relus où on les
//! a posés et dessinés là, texte de « Remplir et signer » et texte écrit dans la page droits à
//! l'écran et retrouvés à leur place, destination de signet aller-retour.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::pagetext::{Family, FontCache, TextStyle};

struct Ink {
    w: usize,
    rgba: Vec<u8>,
}

impl Ink {
    fn of(page: &PdfPage) -> Ink {
        let t = eng::render_page(page, 1.0).unwrap();
        Ink { w: t.width as usize, rgba: t.rgba }
    }
    fn px(&self, x: usize, y: usize) -> Option<[u8; 3]> {
        let o = (y * self.w + x) * 4;
        (x < self.w && o + 2 < self.rgba.len()).then(|| [self.rgba[o], self.rgba[o + 1], self.rgba[o + 2]])
    }
    /// Boîte (gauche, haut, droite, bas) des pixels qui vérifient `f` dans une zone [x, y, l, h].
    fn bbox(&self, r: [f32; 4], f: impl Fn([u8; 3]) -> bool) -> Option<[f32; 4]> {
        let (mut a, mut b, mut c, mut d) = (usize::MAX, usize::MAX, 0, 0);
        for y in r[1].max(0.0) as usize..(r[1] + r[3]).max(0.0) as usize {
            for x in r[0].max(0.0) as usize..(r[0] + r[2]).max(0.0) as usize {
                if self.px(x, y).is_some_and(&f) {
                    (a, b, c, d) = (a.min(x), b.min(y), c.max(x), d.max(y));
                }
            }
        }
        (a <= c).then_some([a as f32, b as f32, c as f32 + 1.0, d as f32 + 1.0])
    }
}

fn dark(p: [u8; 3]) -> bool {
    p[0] < 110 && p[1] < 110 && p[2] < 110
}

fn inside(r: [f32; 4], x: f32, y: f32, pad: f32) -> bool {
    x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad
}

fn close(a: [f32; 4], b: [f32; 4], tol: f32) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() <= tol)
}

#[test]
fn rotated_pages_use_displayed_coordinates() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-rotation-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let mut fonts = FontCache::new();
    for rot in 0..4 {
        // Page `rot` pivotée de `rot` quarts de tour (la page 0 reste droite : témoin).
        let index = rot;
        if rot > 0 {
            eng::pages::rotate(&doc, &[index], rot).unwrap();
        }
        let mut page = doc.pages().get(index).unwrap();
        let frame = eng::Frame::of(&page);
        assert_eq!(frame.rot, rot);
        let (w, h) = (frame.width(), frame.height());
        assert!((w - page.width().value).abs() < 0.5 && (h - page.height().value).abs() < 0.5);

        // 1. Couche de texte : presque toute l'encre du rendu tombe dans une boîte de mot.
        let words: Vec<eng::TextWord> = eng::text_layer(&page).unwrap().into_iter().flatten().collect();
        let boxes: Vec<[f32; 4]> = words.iter().map(|w| [w.x, w.y, w.w, w.h]).collect();
        let ink = Ink::of(&page);
        let (mut total, mut covered) = (0usize, 0usize);
        for y in (0..h as usize).step_by(2) {
            for x in (0..w as usize).step_by(2) {
                if ink.px(x, y).is_some_and(dark) {
                    total += 1;
                    if boxes.iter().any(|b| inside(*b, x as f32 + 0.5, y as f32 + 0.5, 1.5)) {
                        covered += 1;
                    }
                }
            }
        }
        assert!(total > 1000 && covered as f32 / total as f32 > 0.95, "quart {rot} : {covered}/{total} pixels d'encre dans les mots");
        let title = words.iter().find(|w| w.t.starts_with("Texte")).expect("mot « Texte »").clone();
        let title_box = [title.x, title.y, title.w, title.h];

        // 2. Recherche et lignes à modifier : sur le même mot.
        let found = eng::reading::search(&doc, index, 1, "Texte simple", false, false).unwrap();
        let hit = found.pages[0].hits[0][0];
        assert!(inside(hit, title.x + title.w / 2.0, title.y + title.h / 2.0, 1.0), "quart {rot} : recherche {hit:?} / mot {title_box:?}");
        let lines = eng::textedit::lines(&page, index);
        let line = lines.iter().find(|l| l.text.starts_with("Texte simple")).unwrap_or_else(|| panic!("quart {rot} : ligne de titre ({} lignes)", lines.len()));
        assert!(inside(line.rect, title.x + title.w / 2.0, title.y + title.h / 2.0, 1.0), "quart {rot} : ligne {:?}", line.rect);

        // 3. Rectangle (commentaire) : relu où on l'a posé, dessiné là.
        let (x0, y0) = (w * 0.6, h * 0.55);
        eng::annotations::add_shape(&mut page, "square", &[[x0, y0], [x0 + 80.0, y0 + 40.0]], [0, 0, 255], 1.0, 2.0, None, "test").unwrap();
        let annots = eng::annotations::list(&page, index);
        let sq = annots.iter().find(|a| a.kind == "square").expect("rectangle relu");
        assert!(close(sq.rect, [x0, y0, 80.0, 40.0], 3.0), "quart {rot} : rectangle {:?}", sq.rect);
        let ink = Ink::of(&page);
        let blue = ink.bbox([x0 - 10.0, y0 - 10.0, 100.0, 60.0], |p| p[2] > 180 && p[0] < 80 && p[1] < 80).expect("rectangle dessiné");
        assert!(close(blue, [x0 - 1.0, y0 - 1.0, x0 + 81.0, y0 + 41.0], 3.0), "quart {rot} : rectangle dessiné {blue:?}");

        // 4. Dessin à main levée : points relus tels quels.
        let stroke = vec![[w * 0.2, h * 0.8], [w * 0.3, h * 0.85], [w * 0.4, h * 0.8]];
        eng::annotations::add_ink(&mut page, std::slice::from_ref(&stroke), [0, 160, 0], 1.0, 2.0, "test").unwrap();
        let back = eng::annotations::list(&page, index).into_iter().find(|a| a.kind == "ink").expect("dessin relu");
        assert!(back.strokes[0].iter().zip(&stroke).all(|(a, b)| (a[0] - b[0]).abs() < 0.5 && (a[1] - b[1]).abs() < 0.5), "quart {rot} : {:?}", back.strokes);

        // 5. Surlignage d'un mot (rectangle de la page affichée, origine en bas, comme l'interface).
        let r = [title.x, h - title.y - title.h, title.x + title.w, h - title.y];
        eng::annotations::add_markup(&mut page, "highlight", &[r], [255, 220, 0], 1.0, "test").unwrap();
        let hl = eng::annotations::list(&page, index).into_iter().find(|a| a.kind == "highlight").expect("surlignage relu");
        assert!(close(hl.boxes[0], title_box, 1.0), "quart {rot} : surlignage {:?} / {title_box:?}", hl.boxes);
        let ink = Ink::of(&page);
        let yellow = ink.bbox([title.x - 5.0, title.y - 5.0, title.w + 10.0, title.h + 10.0], |p| p[0] > 200 && p[1] > 180 && p[2] < 120);
        assert!(yellow.is_some_and(|y| (y[2] - y[0]) * (y[3] - y[1]) > title.w * title.h * 0.5), "quart {rot} : surlignage dessiné {yellow:?}");

        // 6. Texte de « Remplir et signer » : relu à sa place, droit à l'écran (plus large que haut).
        let (tx, ty) = (w * 0.1, h * 0.62);
        eng::fill::add_text(&doc, &mut page, tx, ty, "Bonjour Camille", 14.0, [200, 0, 0], "test").unwrap();
        let t = eng::annotations::list(&page, index).into_iter().find(|a| a.kind == "text").expect("texte relu");
        assert!((t.rect[0] - tx).abs() < 3.0 && (t.rect[1] - ty).abs() < 3.0 && t.rect[2] > 3.0 * t.rect[3], "quart {rot} : texte {:?}", t.rect);
        let ink = Ink::of(&page);
        let red = ink.bbox([tx - 5.0, ty - 5.0, 160.0, 30.0], |p| p[0] > 150 && p[1] < 80 && p[2] < 80).expect("texte dessiné");
        assert!((red[0] - tx).abs() < 4.0 && (red[2] - red[0]) > 3.0 * (red[3] - red[1]), "quart {rot} : texte dessiné {red:?}");

        // 7. Texte écrit dans la page : droit à l'écran, relu par la couche de texte à sa place.
        let style = TextStyle { family: Family::Sans, bold: false, italic: false, size: 16.0, color: [0, 120, 0] };
        let (px, py) = (w * 0.55, h * 0.08);
        eng::pagetext::set(&doc, &mut page, &mut fonts, None, px, py, "Ajouté ici", &style).unwrap();
        let blk = &eng::pagetext::list(&page, index)[0];
        assert!((blk.rect[0] - px).abs() < 3.0 && (blk.rect[1] - py).abs() < 6.0 && blk.rect[2] > 3.0 * blk.rect[3], "quart {rot} : bloc {:?}", blk.rect);
        let added = eng::text_layer(&page).unwrap().into_iter().flatten().find(|w| w.t.starts_with("Ajouté")).unwrap_or_else(|| panic!("quart {rot} : texte ajouté lu ; {:?}", eng::text_layer(&page).unwrap().into_iter().flatten().filter(|w| w.t.contains("jout") || w.t.starts_with('A') || w.t.contains("ici")).collect::<Vec<_>>()));
        assert!((added.x - px).abs() < 3.0 && (added.y - py).abs() < 6.0 && added.w > added.h, "quart {rot} : {added:?}");

        // 8. Destination de signet : le haut visé revient tel quel.
        let (l, tp) = frame.dest_of_top(h * 0.4);
        assert!((frame.top_of_dest(l, tp).unwrap() - h * 0.4).abs() < 0.01);
    }

    // Enregistré puis relu : les commentaires restent à leur place sur la page pivotée.
    let out = dir.join("pivote.pdf");
    eng::save(&doc, &out, false).unwrap();
    let back = eng::open_typed(&pdfium, &out, None).unwrap();
    let p = back.pages().get(1).unwrap();
    let f = eng::Frame::of(&p);
    let sq = eng::annotations::list(&p, 1).into_iter().find(|a| a.kind == "square").unwrap();
    assert!(close(sq.rect, [f.width() * 0.6, f.height() * 0.55, 80.0, 40.0], 3.0), "relu : {:?}", sq.rect);
    drop((p, back, doc));
    let _ = std::fs::remove_dir_all(&dir);
}

//! Tests de l'impression (S13) vers « Microsoft Print to PDF » : le fichier imprimé est rouvert
//! et vérifié au pixel. Ignorés si cette imprimante ou le corpus manquent.
#![cfg(windows)]

use std::path::{Path, PathBuf};

use pdfreader_engine as eng;
use pdfreader_engine::fill::{self, FieldInput};
use pdfreader_engine::print_win::{self, Duplex, Orientation, PrintOptions, Scale};

mod common;
use common::pdfium;

const PRINTER: &str = "Microsoft Print to PDF";

fn ready(name: &str) -> Option<PathBuf> {
    if !print_win::printers().iter().any(|p| p.name == PRINTER) {
        eprintln!("imprimante « {PRINTER} » absente : test ignoré");
        return None;
    }
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/generated").join(name);
    if !p.exists() {
        eprintln!("corpus absent : test ignoré");
        return None;
    }
    Some(p)
}

fn tmp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pdfreader-print-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn opts(out: &Path, pages: Vec<i32>, comments: bool) -> PrintOptions {
    let _ = std::fs::remove_file(out);
    PrintOptions {
        printer: PRINTER.into(),
        pages,
        scale: Scale::Fit,
        custom_scale: 100.0,
        orientation: Orientation::Auto,
        duplex: Duplex::None,
        copies: 1,
        comments,
        output_file: Some(out.to_str().unwrap().into()),
        title: "Test d'impression".into(),
    }
}

/// Le spouleur écrit le fichier après coup : on attend qu'il soit complet (taille stable).
fn wait_file(p: &Path) {
    let mut last = 0;
    for _ in 0..150 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        if len > 0 && len == last && std::fs::File::options().write(true).open(p).is_ok() {
            return;
        }
        last = len;
    }
    panic!("le fichier imprimé n'est pas arrivé : {}", p.display());
}

struct Shot {
    w: i32,
    h: i32,
    rgba: Vec<u8>,
}

impl Shot {
    /// Rend une page du fichier imprimé à 72 ppp ; coordonnées en fraction de la page.
    fn of(pdfium: &pdfium_render::prelude::Pdfium, path: &Path, page: i32) -> (Self, i32) {
        let doc = eng::open_typed(pdfium, path, None).expect("fichier imprimé lisible");
        let n = doc.pages().len();
        let p = doc.pages().get(page).unwrap();
        let t = eng::render_page(&p, 1.0).unwrap();
        (Self { w: t.width, h: t.height, rgba: t.rgba }, n)
    }
    fn count(&self, x0: f32, y0: f32, x1: f32, y1: f32, f: impl Fn(u8, u8, u8) -> bool) -> usize {
        let (xa, xb) = ((x0 * self.w as f32) as i32, (x1 * self.w as f32) as i32);
        let (ya, yb) = ((y0 * self.h as f32) as i32, (y1 * self.h as f32) as i32);
        let mut n = 0;
        for y in ya.max(0)..yb.min(self.h) {
            for x in xa.max(0)..xb.min(self.w) {
                let i = ((y * self.w + x) * 4) as usize;
                if f(self.rgba[i], self.rgba[i + 1], self.rgba[i + 2]) {
                    n += 1;
                }
            }
        }
        n
    }
}

const DARK: fn(u8, u8, u8) -> bool = |r, g, b| r < 110 && g < 110 && b < 110;
const GREEN: fn(u8, u8, u8) -> bool = |r, g, b| g > 90 && r < 90 && b < 90;

#[test]
fn printers_are_listed() {
    let list = print_win::printers();
    eprintln!("imprimantes : {list:?}");
    // Une seule imprimante par défaut, placée en tête.
    assert!(list.iter().filter(|p| p.is_default).count() <= 1);
    if let Some(i) = list.iter().position(|p| p.is_default) {
        assert_eq!(i, 0);
    }
}

#[test]
fn filled_form_fields_are_printed() {
    let Some(src) = ready("08-formulaire-acroform.pdf") else { return };
    let pdfium = pdfium();
    let dir = tmp_dir();
    let doc = eng::open_typed(&pdfium, &src, None).unwrap();
    let page = doc.pages().get(0).unwrap();
    let empty = dir.join("form-empty.pdf");
    print_win::print(&doc, &opts(&empty, vec![0], true), true).unwrap();
    wait_file(&empty);

    let fields = fill::fields(&doc, &page, 0);
    let by = |n: &str| fields.iter().find(|f| f.name == n).unwrap();
    fill::set_field(&doc, &page, by("nom").index, &FieldInput::Text { value: "Élodie Martin".into() }).unwrap();
    fill::set_field(&doc, &page, by("accepte").index, &FieldInput::Checked { checked: true }).unwrap();
    let filled = dir.join("form-filled.pdf");
    // Sans les commentaires : les champs remplis doivent s'imprimer quand même.
    print_win::print(&doc, &opts(&filled, vec![0], false), true).unwrap();
    wait_file(&filled);

    // Champ « nom » : x 140..440 pt sur 595, à 110..130 pt du haut sur 842 (page A4). Zone prise
    // large, car le format de feuille de l'imprimante peut différer.
    let zone = (0.20, 0.11, 0.76, 0.17);
    let (a, n) = Shot::of(&pdfium, &empty, 0);
    let (b, _) = Shot::of(&pdfium, &filled, 0);
    assert_eq!(n, 1);
    let (before, after) = (a.count(zone.0, zone.1, zone.2, zone.3, DARK), b.count(zone.0, zone.1, zone.2, zone.3, DARK));
    eprintln!("champ nom : {before} pixels sombres vide, {after} rempli");
    assert!(after > before + 40, "le texte du champ rempli doit être imprimé ({before} → {after})");
    // Case cochée : x 140..156, à 250..266 pt du haut.
    let case = (0.22, 0.29, 0.28, 0.33);
    let (c0, c1) = (a.count(case.0, case.1, case.2, case.3, DARK), b.count(case.0, case.1, case.2, case.3, DARK));
    eprintln!("case : {c0} → {c1}");
    assert!(c1 > c0 + 5, "la coche doit être imprimée ({c0} → {c1})");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn comments_option_page_range_and_orientation() {
    let Some(src) = ready("01-texte-10p.pdf") else { return };
    let Some(mixed) = ready("07-tailles-mixtes-rotation.pdf") else { return };
    let pdfium = pdfium();
    let dir = tmp_dir();
    {
        let doc = eng::open_typed(&pdfium, &src, None).unwrap();
        // Trait vert épais dans la marge du bas de la page 3, et signature « posée » (tampon).
        let mut page = doc.pages().get(2).unwrap();
        eng::annotations::add_ink(&mut page, &[vec![[100.0, 815.0], [500.0, 815.0]]], [0, 160, 0], 1.0, 8.0, "Test").unwrap();
        fill::add_mark(&mut page, 520.0, 20.0, 30.0, true, [0, 0, 0], "Test").unwrap();
        drop(page);

        let with = dir.join("with.pdf");
        print_win::print(&doc, &opts(&with, vec![2, 0], true), true).unwrap();
        wait_file(&with);
        let without = dir.join("without.pdf");
        print_win::print(&doc, &opts(&without, vec![2], false), true).unwrap();
        wait_file(&without);

        let (a, n) = Shot::of(&pdfium, &with, 0);
        assert_eq!(n, 2, "deux pages demandées (3 puis 1)");
        let green = a.count(0.1, 0.94, 0.9, 1.0, GREEN);
        assert!(green > 200, "le dessin doit être imprimé avec les commentaires ({green})");
        let (b, n) = Shot::of(&pdfium, &without, 0);
        assert_eq!(n, 1);
        assert_eq!(b.count(0.1, 0.94, 0.9, 1.0, GREEN), 0, "le dessin ne doit pas être imprimé sans les commentaires");
        // La croix posée avec « Remplir et signer » s'imprime dans les deux cas (coin haut droit).
        let cross = (0.85, 0.0, 0.95, 0.08);
        assert!(a.count(cross.0, cross.1, cross.2, cross.3, DARK) > 20);
        assert!(b.count(cross.0, cross.1, cross.2, cross.3, DARK) > 20, "la croix doit rester sans les commentaires");
        // La page imprimée contient bien le texte de la page (zone du corps).
        assert!(b.count(0.08, 0.12, 0.92, 0.9, DARK) > 2000);
        // Impression « basse qualité » (image à 150 ppp) : même page, même contenu.
        let low = dir.join("low.pdf");
        print_win::print(&doc, &opts(&low, vec![2], true), false).unwrap();
        wait_file(&low);
        let (c, _) = Shot::of(&pdfium, &low, 0);
        let (dark, green) = (c.count(0.08, 0.12, 0.92, 0.9, DARK), c.count(0.1, 0.94, 0.9, 1.0, GREEN));
        eprintln!("image : {dark} sombres, {green} verts, page {}x{}, fichier {} octets", c.w, c.h, std::fs::metadata(&low).unwrap().len());
        assert!(dark > 2000 && green > 200, "impression en image ({dark} sombres, {green} verts)");
        // Même géométrie qu'en vectoriel : la croix reste en haut à droite.
        assert!(c.count(cross.0, cross.1, cross.2, cross.3, DARK) > 20, "croix en mode image");
    }
    // Orientation automatique : une page paysage sort sur une feuille paysage.
    let doc = eng::open_typed(&pdfium, &mixed, None).unwrap();
    let sizes: Vec<(f32, f32)> = doc.pages().iter().map(|p| (p.width().value, p.height().value)).collect();
    let Some(land) = sizes.iter().position(|(w, h)| w > h) else {
        eprintln!("pas de page paysage dans le corpus");
        return;
    };
    let Some(port) = sizes.iter().position(|(w, h)| h > w) else { return };
    let out = dir.join("orient.pdf");
    print_win::print(&doc, &opts(&out, vec![port as i32, land as i32, port as i32], true), true).unwrap();
    wait_file(&out);
    let printed = eng::open_typed(&pdfium, &out, None).unwrap();
    let got: Vec<bool> = printed.pages().iter().map(|p| p.width().value > p.height().value).collect();
    assert_eq!(got, [false, true, false], "portrait, paysage, portrait");
    drop(printed);
    let _ = std::fs::remove_dir_all(&dir);
}

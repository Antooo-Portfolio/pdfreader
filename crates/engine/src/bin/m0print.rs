//! Critère 7 du spike M0 : impression vectorielle native vers « Microsoft Print to PDF ».
//!
//!     cargo run --release -p pdfreader-engine --bin m0print

use std::path::Path;

use anyhow::Result;
use pdfium_render::prelude::*;
use pdfreader_engine::*;

fn main() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
    let pdfium = load_pdfium(&root.join("vendor/pdfium-win-x64/bin"))?;
    let src = root.join("target/m0-out/annote-incremental.pdf");
    let out = root.join("target/m0-out/impression-vectorielle.pdf");
    let _ = std::fs::remove_file(&out);
    let (doc, _) = open_document(&pdfium, &src, None)?;
    let t = std::time::Instant::now();
    let opts = print_win::PrintOptions {
        printer: "Microsoft Print to PDF".into(),
        pages: vec![0, 1],
        scale: print_win::Scale::Fit,
        custom_scale: 100.0,
        orientation: print_win::Orientation::Auto,
        duplex: print_win::Duplex::None,
        copies: 1,
        comments: true,
        output_file: Some(out.to_str().unwrap().into()),
        title: "Spike M0".into(),
    };
    print_win::print(&doc, &opts, true)?;
    // Le spouleur écrit le fichier de façon asynchrone.
    for _ in 0..100 {
        if out.exists() && std::fs::metadata(&out)?.len() > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    println!("impression envoyée en {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
    drop(doc);
    let (printed, _) = open_document(&pdfium, &out, None)?;
    let page = printed.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let text = page.text().map(|t| t.all()).unwrap_or_default();
    let images = page.objects().iter().filter(|o| o.object_type() == PdfPageObjectType::Image).count();
    let texts = page.objects().iter().filter(|o| o.object_type() == PdfPageObjectType::Text).count();
    println!(
        "sortie : {} octets, {} pages · objets texte p1 : {texts} · objets image p1 : {images} · texte extractible : {}",
        std::fs::metadata(&out)?.len(),
        printed.pages().len(),
        text.chars().take(60).collect::<String>().replace('\n', " ")
    );
    Ok(())
}

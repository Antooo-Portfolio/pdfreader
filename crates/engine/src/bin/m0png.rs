//! Outil du spike : rend la page 1 d'un PDF en PNG.  m0png <entrée.pdf> <sortie.png> [échelle]
use anyhow::Result;
use pdfreader_engine::*;
fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
    let pdfium = load_pdfium(&root.join("vendor/pdfium-win-x64/bin"))?;
    let (doc, _) = open_document(&pdfium, std::path::Path::new(&a[1]), None)?;
    let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let t = render_page(&page, a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1.0))?;
    image::save_buffer(&a[2], &t.rgba, t.width as u32, t.height as u32, image::ColorType::Rgba8)?;
    Ok(())
}

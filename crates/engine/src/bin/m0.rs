//! Banc d'essai du spike M0 : mesure et vérifie les critères 1 à 6 de replica/architecture.md
//! (le critère 2 « affichage dans la WebView » est mesuré à part, dans la coquille Tauri).
//!
//!     cargo run --release -p pdfreader-engine --bin m0

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use pdfium_render::prelude::*;
use pdfreader_engine::*;

const PASSWORD: &str = "test1234";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").canonicalize().unwrap()
}

fn mb(b: u64) -> f64 {
    b as f64 / 1024.0 / 1024.0
}

fn save_png(tile: &Tile, path: &Path) -> Result<()> {
    image::save_buffer(path, &tile.rgba, tile.width as u32, tile.height as u32, image::ColorType::Rgba8)?;
    Ok(())
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn main() -> Result<()> {
    let root = root();
    let corpus = root.join("corpus").join("generated");
    let out = root.join("target").join("m0-out");
    std::fs::create_dir_all(&out)?;
    let pdfium = load_pdfium(&root.join("vendor").join("pdfium-win-x64").join("bin"))?;
    let mem0 = process_memory();
    println!("PDFium chargé. Mémoire de base : {:.0} Mo\n", mb(mem0));

    // ------------------------------------------------------------------ critère 1 : rendu
    println!("== 1. Rendu de chaque PDF du corpus (page 1 à 150 %, PNG dans target/m0-out)");
    let mut files: Vec<_> = std::fs::read_dir(&corpus)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    files.sort();
    for f in &files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let pw = name.contains("chiffre").then_some(PASSWORD);
        let t = Instant::now();
        match open_document(&pdfium, f, pw) {
            Ok((doc, stats)) => {
                let open_ms = t.elapsed().as_secs_f64() * 1000.0;
                let pages = doc.pages().len();
                let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
                let t2 = Instant::now();
                let tile = render_page(&page, 1.5)?;
                let render_ms = t2.elapsed().as_secs_f64() * 1000.0;
                save_png(&tile, &out.join(format!("{}.png", name.trim_end_matches(".pdf"))))?;
                let has_text = page.text().map(|t| !t.all().trim().is_empty()).unwrap_or(false);
                println!(
                    "  OK  {name:<36} {pages:>5} p.  ouverture {open_ms:>7.1} ms  rendu p1 {render_ms:>6.1} ms  lu {:>8.2} Mo en {:>5} lectures  texte {}",
                    mb(stats.bytes()),
                    stats.calls(),
                    if has_text { "oui" } else { "non" }
                );
            }
            Err(e) => println!("  ÉCHEC {name}: {e}"),
        }
    }

    // ------------------------------------------------------------------ critère 2 (moteur) : tuiles
    println!("\n== 2. Tuiles 512 px sur le PDF de 1 000 pages (échelle 2,0 = 144 ppp)");
    {
        let path = corpus.join("02-texte-1000p.pdf");
        let t = Instant::now();
        let (doc, stats) = open_document(&pdfium, &path, None)?;
        let open_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let p500 = doc.pages().get(499).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let first = render_tile(&p500, 2.0, 0, 0, 512)?;
        let first_ms = t.elapsed().as_secs_f64() * 1000.0;
        save_png(&first, &out.join("tuile-p500.png"))?;
        let mut times = Vec::new();
        for i in 0..120 {
            let page = doc.pages().get((i * 7 % 1000) as i32).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let (x, y) = ((i % 3) * 512, (i % 4) * 512);
            let t = Instant::now();
            let _ = render_tile(&page, 2.0, x as i32, y as i32, 512)?;
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        println!(
            "  ouverture {open_ms:.1} ms (lu {:.2} Mo) · page 500, 1re tuile {first_ms:.1} ms · 120 tuiles : médiane {:.1} ms, p95 {:.1} ms, max {:.1} ms · mémoire {:.0} Mo",
            mb(stats.bytes()),
            percentile(&mut times.clone(), 0.5),
            percentile(&mut times.clone(), 0.95),
            percentile(&mut times, 1.0),
            mb(process_memory())
        );
    }

    // ------------------------------------------------------------------ critère 3 : gros fichier
    println!("\n== 3. Gros fichier (lecture par blocs)");
    {
        let path = corpus.join("11-gros-fichier.pdf");
        let size = std::fs::metadata(&path)?.len();
        let before = process_memory();
        let t = Instant::now();
        let (doc, stats) = open_document(&pdfium, &path, None)?;
        let open_ms = t.elapsed().as_secs_f64() * 1000.0;
        let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let t = Instant::now();
        render_page(&page, 1.5)?;
        let render_ms = t.elapsed().as_secs_f64() * 1000.0;
        let attachments = doc.attachments().len();
        println!(
            "  taille {:.2} Go · ouverture {open_ms:.1} ms · rendu p1 {render_ms:.1} ms · lu {:.2} Mo ({} lectures) · pièces jointes {attachments} · mémoire +{:.0} Mo",
            size as f64 / 1024f64.powi(3),
            mb(stats.bytes()),
            stats.calls(),
            mb(process_memory().saturating_sub(before))
        );
    }

    // ------------------------------------------------------------------ critère 4 : annotations
    println!("\n== 4. Surlignage + note, sauvegarde incrémentale");
    let annotated = out.join("annote-incremental.pdf");
    {
        let src = corpus.join("01-texte-10p.pdf");
        let (doc, _) = open_document(&pdfium, &src, None)?;
        {
            let mut page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let rect = highlight_first(&mut page, "contrat", "Camille D.", (255, 225, 77))?;
            add_note(&mut page, 500.0, 700.0, "Clause à reformuler.", "Camille D.")?;
            // Un rendu avec les annotations fait générer leurs apparences (/AP) par PDFium.
            render_page(&page, 0.25)?;
            println!("  surlignage posé sur {:?}", (rect.left().value, rect.bottom().value, rect.right().value, rect.top().value));
        }
        save(&doc, &annotated, true)?;
        drop(doc);
        let original = std::fs::read(&src)?;
        let saved = std::fs::read(&annotated)?;
        let prefix_ok = saved.len() > original.len() && saved[..original.len()] == original[..];
        let (re, _) = open_document(&pdfium, &annotated, None)?;
        let page = re.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let kinds: Vec<_> = page.annotations().iter().map(|a| format!("{:?}", a.annotation_type())).collect();
        save_png(&render_page(&page, 1.5)?, &out.join("annote-incremental.png"))?;
        println!(
            "  {} → {} octets (+{}) · original intact en tête : {} · annotations relues : {:?}",
            original.len(),
            saved.len(),
            saved.len() - original.len(),
            if prefix_ok { "oui" } else { "NON" },
            kinds
        );
    }

    // ------------------------------------------------------------------ critère 5 : chiffré
    println!("\n== 5. PDF chiffré AES-256 : ouvrir, annoter, réenregistrer");
    {
        let src = corpus.join("09-chiffre-aes256.pdf");
        let without = open_document(&pdfium, &src, None).is_err();
        let wrong = open_document(&pdfium, &src, Some("mauvais")).is_err();
        let (doc, _) = open_document(&pdfium, &src, Some(PASSWORD))?;
        let perms = doc.permissions();
        println!(
            "  sans mot de passe refusé : {without} · mauvais refusé : {wrong} · version sécurité {:?} · impression haute qualité permise : {:?} · copie permise : {:?}",
            perms.security_handler_revision(),
            perms.can_print_high_quality(),
            perms.can_extract_text_and_graphics()
        );
        {
            let mut page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            highlight_first(&mut page, "contrat", "Camille D.", (141, 227, 154))?;
            render_page(&page, 0.25)?;
        }
        let dst = out.join("chiffre-annote.pdf");
        save(&doc, &dst, true)?;
        drop(doc);
        let still_locked = open_document(&pdfium, &dst, None).is_err();
        let (re, _) = open_document(&pdfium, &dst, Some(PASSWORD))?;
        let n = re.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?.annotations().len();
        println!("  réenregistré : toujours chiffré (refus sans mot de passe) : {still_locked} · annotations relues avec le mot de passe : {n}");
    }

    // ------------------------------------------------------------------ critère 6 : formulaire
    println!("\n== 6. Formulaire AcroForm : remplir, enregistrer, relire");
    {
        let src = corpus.join("08-formulaire-acroform.pdf");
        let (doc, _) = open_document(&pdfium, &src, None)?;
        println!("  type de formulaire : {:?}", doc.form().map(|f| f.form_type()));
        {
            let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            for mut annot in page.annotations().iter() {
                if let Some(field) = annot.as_form_field_mut() {
                    let name = field.name().unwrap_or_default();
                    if let Some(t) = field.as_text_field_mut() {
                        if name == "nom" {
                            t.set_value("Camille Durand").map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        } else if name == "commentaire" {
                            t.set_value("Ligne 1\nLigne 2 avec accents : é è à ç").map_err(|e| anyhow::anyhow!("{e:?}"))?;
                        }
                    } else if let Some(c) = field.as_checkbox_field_mut() {
                        c.set_checked(true).map_err(|e| anyhow::anyhow!("{e:?}"))?;
                    }
                }
            }
        }
        let dst = out.join("formulaire-rempli.pdf");
        save(&doc, &dst, true)?;
        drop(doc);
        let (re, _) = open_document(&pdfium, &dst, None)?;
        let values = re.form().context("formulaire perdu")?.field_values(re.pages());
        let mut v: Vec<_> = values.into_iter().collect();
        v.sort();
        println!("  valeurs relues : {v:?}");
        save_png(&render_page(&re.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?, 1.5)?, &out.join("formulaire-rempli.png"))?;
    }

    // ------------------------------------------------------------------ critère 6 bis
    println!("\n== 6 bis. Formulaire rempli par le moteur interactif (régénère les apparences)");
    {
        let src = corpus.join("08-formulaire-acroform.pdf");
        let (doc, _) = open_document(&pdfium, &src, None)?;
        {
            let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let h = page.height().value as f64;
            fill_field_interactive(&doc, &page, 290.0, h - 120.0, Some("Camille Durand"))?;
            fill_field_interactive(&doc, &page, 290.0, h - 190.0, Some("Ligne 1 avec accents : é è à ç"))?;
            fill_field_interactive(&doc, &page, 148.0, h - 258.0, None)?;
            fill_field_interactive(&doc, &page, 268.0, h - 298.0, None)?;
        }
        let dst = out.join("formulaire-interactif.pdf");
        save(&doc, &dst, true)?;
        drop(doc);
        let (re, _) = open_document(&pdfium, &dst, None)?;
        let mut v: Vec<_> = re.form().context("formulaire perdu")?.field_values(re.pages()).into_iter().collect();
        v.sort();
        println!("  valeurs relues : {v:?}");
        save_png(&render_page(&re.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?, 1.5)?, &out.join("formulaire-interactif.png"))?;
    }

    println!("\nMémoire finale : {:.0} Mo", mb(process_memory()));
    Ok(())
}

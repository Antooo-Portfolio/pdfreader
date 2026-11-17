//! Phase 2, « Organiser les pages » : pivoter, supprimer, déplacer, insérer (page blanche ou pages
//! d'un autre PDF), extraire, diviser, combiner. Fonctions natives de PDFium (FPDF_MovePages,
//! FPDFPage_Delete, FPDF_ImportPagesByIndex…) ; les pages sont désignées par leur index (0 = la
//! première) dans l'ordre actuel du document.

use std::path::Path;

use anyhow::{Result, bail};
use pdfium_render::prelude::*;

use crate::outline::OutlineItem;

/// Index valides, triés, sans doublon.
fn checked(doc: &PdfDocument, pages: &[i32]) -> Result<Vec<i32>> {
    let n = doc.pages().len();
    let mut v: Vec<i32> = pages.to_vec();
    v.sort_unstable();
    v.dedup();
    if v.is_empty() {
        bail!("aucune page");
    }
    if v.iter().any(|p| !(0..n).contains(p)) {
        bail!("page hors du document");
    }
    Ok(v)
}

/// Correspondance ancien index → nouvel index après une opération (None : page supprimée).
pub type PageMap = Vec<Option<i32>>;

fn map_from_order(old_count: i32, order: &[Option<i32>]) -> PageMap {
    let mut map = vec![None; old_count as usize];
    for (new, old) in order.iter().enumerate() {
        if let Some(o) = old {
            map[*o as usize] = Some(new as i32);
        }
    }
    map
}

/// Pivote les pages d'un quart de tour par unité (`quarters` : 1 = sens horaire, -1 = antihoraire).
/// La rotation est enregistrée dans le fichier (/Rotate), contrairement à la rotation d'affichage.
pub fn rotate(doc: &PdfDocument, pages: &[i32], quarters: i32) -> Result<PageMap> {
    let pages = checked(doc, pages)?;
    let b = raw_bindings();
    for p in pages {
        let page = doc.pages().get(p)?;
        let h = page.raw_handle();
        unsafe {
            let r = b.FPDFPage_GetRotation(h);
            b.FPDFPage_SetRotation(h, (r + quarters).rem_euclid(4));
        }
    }
    let n = doc.pages().len();
    Ok((0..n).map(Some).collect())
}

/// Supprime des pages. Il doit en rester au moins une.
pub fn delete(doc: &PdfDocument, pages: &[i32]) -> Result<PageMap> {
    let pages = checked(doc, pages)?;
    let n = doc.pages().len();
    if pages.len() as i32 >= n {
        bail!("last_page");
    }
    let b = raw_bindings();
    for p in pages.iter().rev() {
        unsafe { b.FPDFPage_Delete(doc.raw_handle(), *p) };
    }
    let order: Vec<Option<i32>> = (0..n).filter(|p| pages.binary_search(p).is_err()).map(Some).collect();
    Ok(map_from_order(n, &order))
}

/// Déplace des pages avant la page `before` (index dans l'ordre actuel ; `before` = nombre de pages :
/// à la fin). Les pages déplacées gardent leur ordre relatif.
pub fn move_pages(doc: &PdfDocument, pages: &[i32], before: i32) -> Result<PageMap> {
    let pages = checked(doc, pages)?;
    let n = doc.pages().len();
    if !(0..=n).contains(&before) {
        bail!("position hors du document");
    }
    // FPDF_MovePages attend l'index final de la première page déplacée.
    let dest = before - pages.iter().filter(|p| **p < before).count() as i32;
    let ok = unsafe { raw_bindings().FPDF_MovePages(doc.raw_handle(), pages.as_ptr(), pages.len() as _, dest) };
    if ok == 0 {
        bail!("déplacement refusé par PDFium");
    }
    let rest: Vec<i32> = (0..n).filter(|p| pages.binary_search(p).is_err()).collect();
    let mut order: Vec<Option<i32>> = rest.iter().map(|p| Some(*p)).collect();
    let tail = order.split_off(dest as usize);
    order.extend(pages.iter().map(|p| Some(*p)));
    order.extend(tail);
    Ok(map_from_order(n, &order))
}

/// Insère une page blanche de la taille donnée (points PDF) à l'index `at`.
pub fn insert_blank(doc: &PdfDocument, at: i32, width: f32, height: f32) -> Result<PageMap> {
    let n = doc.pages().len();
    if !(0..=n).contains(&at) || !(36.0..=14400.0).contains(&width) || !(36.0..=14400.0).contains(&height) {
        bail!("page blanche refusée");
    }
    let b = raw_bindings();
    let page = unsafe { b.FPDFPage_New(doc.raw_handle(), at, width as f64, height as f64) };
    if page.is_null() {
        bail!("page blanche refusée par PDFium");
    }
    unsafe { b.FPDF_ClosePage(page) };
    Ok(shifted(n, at, 1))
}

fn shifted(n: i32, at: i32, k: i32) -> PageMap {
    (0..n).map(|p| Some(if p >= at { p + k } else { p })).collect()
}

/// Insère des pages d'un autre document (toutes si `src_pages` est None) à l'index `at` ; renvoie la
/// correspondance des pages existantes et le nombre de pages insérées. Les commentaires suivent leurs
/// pages ; les champs de formulaire de l'autre document ne sont pas fusionnés au formulaire.
pub fn insert_from(doc: &PdfDocument, src: &PdfDocument, src_pages: Option<&[i32]>, at: i32) -> Result<(PageMap, i32)> {
    let n = doc.pages().len();
    if !(0..=n).contains(&at) {
        bail!("position hors du document");
    }
    let wanted = match src_pages {
        Some(p) => checked(src, p)?,
        None => (0..src.pages().len()).collect(),
    };
    if wanted.is_empty() {
        bail!("aucune page");
    }
    import(doc, src, &wanted, at)?;
    Ok((shifted(n, at, wanted.len() as i32), wanted.len() as i32))
}

fn import(dest: &PdfDocument, src: &PdfDocument, pages: &[i32], at: i32) -> Result<()> {
    let ok = unsafe { raw_bindings().FPDF_ImportPagesByIndex(dest.raw_handle(), src.raw_handle(), pages.as_ptr(), pages.len() as _, at) };
    if ok == 0 {
        bail!("import des pages refusé par PDFium");
    }
    Ok(())
}

/// Écrit les pages choisies dans un nouveau fichier (enregistrement complet, non chiffré : refusé
/// par l'appelant si le document interdit l'assemblage).
pub fn extract(pdfium: &Pdfium, doc: &PdfDocument, pages: &[i32], target: &Path) -> Result<()> {
    let pages = checked(doc, pages)?;
    let out = pdfium.create_new_pdf()?;
    import(&out, doc, &pages, 0)?;
    unsafe { raw_bindings().FPDF_CopyViewerPreferences(out.raw_handle(), doc.raw_handle()) };
    crate::save(&out, target, false)
}

/// Découpe en fichiers de `per_file` pages ; renvoie les plages (première, dernière) de chaque partie.
pub fn split_ranges(page_count: i32, per_file: i32) -> Vec<(i32, i32)> {
    let per = per_file.max(1);
    (0..page_count).step_by(per as usize).map(|s| (s, (s + per - 1).min(page_count - 1))).collect()
}

/// Combine des documents ouverts, dans l'ordre, en un nouveau fichier ; renvoie le nombre de pages.
pub fn combine(pdfium: &Pdfium, sources: &[&PdfDocument], target: &Path) -> Result<i32> {
    if sources.is_empty() {
        bail!("aucun document");
    }
    let out = pdfium.create_new_pdf()?;
    let mut at = 0;
    for src in sources {
        let n = src.pages().len();
        let all: Vec<i32> = (0..n).collect();
        if n > 0 {
            import(&out, src, &all, at)?;
        }
        at += n;
    }
    unsafe { raw_bindings().FPDF_CopyViewerPreferences(out.raw_handle(), sources[0].raw_handle()) };
    crate::save(&out, target, false)?;
    Ok(at)
}

/// Signets en attente (écrits au prochain enregistrement, avec des index de page) : suivent les
/// pages déplacées ; ceux d'une page supprimée perdent leur destination.
pub fn remap_outline(items: &mut [OutlineItem], map: &PageMap) {
    for i in items.iter_mut() {
        if i.page >= 0 {
            i.page = map.get(i.page as usize).copied().flatten().unwrap_or(-1);
        }
        remap_outline(&mut i.children, map);
    }
}

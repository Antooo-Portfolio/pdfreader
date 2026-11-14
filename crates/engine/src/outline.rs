//! M3 : modifier les signets (table des matières, /Outlines).
//!
//! PDFium sait lire les signets mais pas les écrire. Après l'enregistrement par PDFium, une
//! seconde mise à jour incrémentale est ajoutée au fichier avec lopdf : un nouvel arbre /Outlines
//! et le catalogue qui le désigne. Rien d'autre n'est réécrit (les signatures numériques restent
//! valides). Documents chiffrés : refusé (il faudrait chiffrer les nouveaux titres).

use std::path::Path;

use anyhow::{Context, Result, bail};
use lopdf::{Dictionary, IncrementalDocument, Object, ObjectId, StringFormat};

/// Signet à écrire : titre, page (index 0), ordonnée PDF (depuis le bas) du haut de la vue.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq)]
pub struct OutlineItem {
    pub title: String,
    pub page: i32,
    /// Points depuis le HAUT de la page (comme le reste de l'interface) ; converti à l'écriture.
    pub top: Option<f32>,
    /// Signet qui ouvre une adresse web (page ignorée). Page négative et pas d'adresse : aucune action.
    #[serde(default)]
    pub uri: Option<String>,
    #[serde(default)]
    pub children: Vec<OutlineItem>,
}

/// Limites (arbre démesuré envoyé par l'interface).
pub const MAX_ITEMS: usize = 20_000;
const MAX_DEPTH: usize = 48;
/// Au-delà, le fichier n'est pas chargé en mémoire pour ajouter les signets.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

pub fn count(items: &[OutlineItem]) -> usize {
    items.iter().map(|i| 1 + count(&i.children)).sum()
}

/// Titre en chaîne de texte PDF : ASCII tel quel, sinon UTF-16BE avec indicateur d'ordre.
fn text_string(s: &str) -> Object {
    let clean: String = s.chars().filter(|c| !c.is_control()).take(500).collect();
    if clean.is_ascii() {
        Object::String(clean.into_bytes(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for u in clean.encode_utf16() {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

struct Ctx<'a> {
    doc: &'a mut lopdf::Document,
    pages: Vec<ObjectId>,
    heights: Vec<f32>,
}

/// Écrit les enfants de `parent` ; renvoie (premier, dernier, nombre de descendants visibles).
fn write_level(ctx: &mut Ctx, parent: ObjectId, items: &[OutlineItem], depth: usize) -> Result<Option<(ObjectId, ObjectId, i64)>> {
    if items.is_empty() || depth > MAX_DEPTH {
        return Ok(None);
    }
    let ids: Vec<ObjectId> = items.iter().map(|_| ctx.doc.new_object_id()).collect();
    let mut total = 0i64;
    for (i, item) in items.iter().enumerate() {
        let mut d = Dictionary::new();
        d.set("Title", text_string(&item.title));
        d.set("Parent", Object::Reference(parent));
        if i > 0 {
            d.set("Prev", Object::Reference(ids[i - 1]));
        }
        if i + 1 < ids.len() {
            d.set("Next", Object::Reference(ids[i + 1]));
        }
        if let Some(uri) = item.uri.as_deref().filter(|u| !u.is_empty() && u.len() < 4096) {
            let mut a = Dictionary::new();
            a.set("S", Object::Name(b"URI".to_vec()));
            a.set("URI", Object::String(uri.as_bytes().to_vec(), StringFormat::Literal));
            d.set("A", Object::Dictionary(a));
        } else if let (true, Some(&page_id), Some(&h)) = (item.page >= 0, ctx.pages.get(item.page.max(0) as usize), ctx.heights.get(item.page.max(0) as usize)) {
            let top = match item.top {
                Some(t) => Object::Real((h - t).clamp(0.0, h)),
                None => Object::Null,
            };
            d.set("Dest", Object::Array(vec![Object::Reference(page_id), Object::Name(b"XYZ".to_vec()), Object::Null, top, Object::Null]));
        }
        // Les enfants : dépliés (Count positif) pour qu'ils se voient tout de suite.
        if let Some((first, last, n)) = write_level(ctx, ids[i], &item.children, depth + 1)? {
            d.set("First", Object::Reference(first));
            d.set("Last", Object::Reference(last));
            d.set("Count", Object::Integer(n));
            total += n;
        }
        total += 1;
        ctx.doc.set_object(ids[i], Object::Dictionary(d));
    }
    Ok(Some((ids[0], ids[ids.len() - 1], total)))
}

/// Remplace les signets du fichier `path` (déjà enregistré) par `items` ; `heights` : hauteur de
/// chaque page en points (pour convertir l'ordonnée).
pub fn write(path: &Path, items: &[OutlineItem], heights: &[f32]) -> Result<()> {
    if count(items) > MAX_ITEMS {
        bail!("trop de signets");
    }
    let size = std::fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        bail!("file_too_big");
    }
    let mut inc = IncrementalDocument::load(path).map_err(|e| anyhow::anyhow!("lecture du fichier pour les signets : {e}"))?;
    let (root_id, pages) = {
        let prev = inc.get_prev_documents();
        if prev.is_encrypted() {
            bail!("encrypted");
        }
        let root = prev.trailer.get(b"Root").and_then(|r| r.as_reference()).context("catalogue introuvable")?;
        (root, prev.get_pages().into_values().collect::<Vec<_>>())
    };
    if pages.len() != heights.len() {
        bail!("pages incohérentes ({} lues, {} attendues)", pages.len(), heights.len());
    }
    inc.opt_clone_object_to_new_document(root_id).map_err(|e| anyhow::anyhow!("{e}"))?;
    let outlines = if items.is_empty() {
        None
    } else {
        let outlines_id = inc.new_document.new_object_id();
        let mut ctx = Ctx { doc: &mut inc.new_document, pages, heights: heights.to_vec() };
        let level = write_level(&mut ctx, outlines_id, items, 0)?;
        let mut d = Dictionary::new();
        d.set("Type", Object::Name(b"Outlines".to_vec()));
        if let Some((first, last, n)) = level {
            d.set("First", Object::Reference(first));
            d.set("Last", Object::Reference(last));
            d.set("Count", Object::Integer(n));
        }
        inc.new_document.set_object(outlines_id, Object::Dictionary(d));
        Some(outlines_id)
    };
    {
        let catalog = inc.new_document.get_object_mut(root_id).and_then(|o| o.as_dict_mut()).map_err(|e| anyhow::anyhow!("catalogue : {e}"))?;
        match outlines {
            Some(id) => catalog.set("Outlines", Object::Reference(id)),
            None => {
                catalog.remove(b"Outlines");
            }
        }
    }
    // Écriture à côté puis remplacement (le fichier d'origine reste intact en cas d'échec).
    let tmp = path.with_extension("outline.tmp");
    let result = (|| -> Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        inc.save_to(&mut f).map_err(|e| anyhow::anyhow!("écriture des signets : {e}"))?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

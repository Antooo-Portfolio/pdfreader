//! M3, lot « navigation » : pièces jointes (S09), recherche avec extraits (liste des résultats),
//! provenance Internet d'un fichier (vue protégée).
//! Coordonnées renvoyées à l'interface : points PDF depuis le HAUT à gauche de la page.

use std::path::Path;

use anyhow::{Result, anyhow, bail};
use pdfium_render::prelude::*;

// ------------------------------------------------------------------ pièces jointes

/// Pièce jointe du document (arbre /EmbeddedFiles).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Attachment {
    pub index: u16,
    pub name: String,
    pub size: usize,
}

/// Au-delà, la liste est tronquée (PDF piégé).
const MAX_ATTACHMENTS: u16 = 1000;
/// Taille maximale d'une pièce jointe extraite.
pub const MAX_ATTACHMENT_BYTES: usize = 512 * 1024 * 1024;

/// Nom de fichier sans chemin ni caractère interdit par Windows : une pièce jointe ne doit jamais
/// pouvoir viser un autre dossier (« ..\\..\\x.exe »).
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." { "piece-jointe".into() } else { cleaned.chars().take(200).collect() }
}

pub fn attachments(doc: &PdfDocument) -> Vec<Attachment> {
    let list = doc.attachments();
    let n = list.len().min(MAX_ATTACHMENTS);
    (0..n)
        .filter_map(|i| {
            let a = list.get(i).ok()?;
            Some(Attachment { index: i, name: safe_file_name(&a.name()), size: a.len() })
        })
        .collect()
}

/// Contenu d'une pièce jointe.
pub fn attachment_bytes(doc: &PdfDocument, index: u16) -> Result<Vec<u8>> {
    let a = doc.attachments().get(index).map_err(|e| anyhow!("pièce jointe introuvable : {e:?}"))?;
    if a.len() > MAX_ATTACHMENT_BYTES {
        bail!("pièce jointe trop volumineuse");
    }
    a.save_to_bytes().map_err(|e| anyhow!("lecture impossible : {e:?}"))
}

// ------------------------------------------------------------------ recherche avec extraits

/// Un résultat : page, rectangles (un par ligne) et extrait autour du mot trouvé.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub page: i32,
    pub rects: Vec<[f32; 4]>,
    /// Texte avant, trouvé, après (espaces normalisés).
    pub before: String,
    pub matched: String,
    pub after: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetBatch {
    pub hits: Vec<SearchHit>,
    /// Le plafond de résultats est atteint : la recherche s'arrête là.
    pub truncated: bool,
}

const CONTEXT_CHARS: i32 = 48;
pub const MAX_SNIPPET_HITS: usize = 5000;

fn text_range(b: &dyn PdfiumLibraryBindings, tp: FPDF_TEXTPAGE, start: i32, count: i32) -> String {
    if count <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; count as usize + 1];
    let n = unsafe { b.FPDFText_GetText(tp, start, count, buf.as_mut_ptr()) };
    let n = (n.max(1) as usize - 1).min(count as usize);
    String::from_utf16_lossy(&buf[..n])
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cherche dans les pages `from..from + count`, avec un extrait par résultat. `already` : nombre
/// de résultats déjà trouvés (plafond global).
pub fn search_snippets(doc: &PdfDocument, from: i32, count: i32, query: &str, match_case: bool, whole_word: bool, already: usize) -> Result<SnippetBatch> {
    let b = raw_bindings();
    let mut out = SnippetBatch { hits: Vec::new(), truncated: false };
    let q = query.trim();
    if q.is_empty() {
        return Ok(out);
    }
    let mut wide: Vec<u16> = q.encode_utf16().collect();
    wide.push(0);
    let flags = (if match_case { 1 } else { 0 }) | (if whole_word { 2 } else { 0 });
    let total = doc.pages().len();
    for index in from.max(0)..from.saturating_add(count).min(total) {
        let page = doc.pages().get(index).map_err(|e| anyhow!("{e:?}"))?;
        let page_h = page.height().value;
        let tp = unsafe { b.FPDFText_LoadPage(page.raw_handle()) };
        if tp.is_null() {
            continue;
        }
        let chars = unsafe { b.FPDFText_CountChars(tp) };
        let sh = unsafe { b.FPDFText_FindStart(tp, wide.as_ptr() as FPDF_WIDESTRING, flags, 0) };
        if !sh.is_null() {
            while unsafe { b.FPDFText_FindNext(sh) } != 0 {
                if already + out.hits.len() >= MAX_SNIPPET_HITS {
                    out.truncated = true;
                    break;
                }
                let start = unsafe { b.FPDFText_GetSchResultIndex(sh) };
                let n = unsafe { b.FPDFText_GetSchCount(sh) };
                let nrects = unsafe { b.FPDFText_CountRects(tp, start, n) };
                let mut rects = Vec::new();
                for r in 0..nrects.clamp(0, 64) {
                    let (mut l, mut t, mut rt, mut bt) = (0.0, 0.0, 0.0, 0.0);
                    if unsafe { b.FPDFText_GetRect(tp, r, &mut l, &mut t, &mut rt, &mut bt) } != 0 {
                        let (l, t, rt, bt) = (l as f32, t as f32, rt as f32, bt as f32);
                        rects.push([l, page_h - t, (rt - l).max(0.5), (t - bt).max(0.5)]);
                    }
                }
                let b0 = (start - CONTEXT_CHARS).max(0);
                let a1 = (start + n + CONTEXT_CHARS).min(chars);
                out.hits.push(SearchHit {
                    page: index,
                    rects,
                    before: squash(&text_range(b, tp, b0, start - b0)),
                    matched: squash(&text_range(b, tp, start, n)),
                    after: squash(&text_range(b, tp, start + n, a1 - start - n)),
                });
            }
            unsafe { b.FPDFText_FindClose(sh) };
        }
        unsafe { b.FPDFText_ClosePage(tp) };
        if out.truncated {
            break;
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ provenance Internet

/// Le fichier vient-il d'Internet (« marque du Web » posée par le navigateur ou la messagerie :
/// flux NTFS Zone.Identifier, zone 3 Internet ou 4 sites sensibles) ?
pub fn from_internet(path: &Path) -> bool {
    let mut ads = path.as_os_str().to_owned();
    ads.push(":Zone.Identifier");
    let Ok(text) = std::fs::read(Path::new(&ads)) else { return false };
    let text = String::from_utf8_lossy(&text[..text.len().min(4096)]).to_string();
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("ZoneId="))
        .any(|z| matches!(z.trim(), "3" | "4"))
}

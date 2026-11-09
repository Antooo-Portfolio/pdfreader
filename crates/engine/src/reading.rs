//! M2, lot « lecture » : droits du document, liens, signets, recherche.
//! Coordonnées renvoyées à l'interface : points PDF depuis le HAUT à gauche de la page.

use anyhow::Result;
use pdfium_render::prelude::*;

/// Droits accordés par le document (ISO 32000-2 §7.6.4.2, tableau 22). Un document non chiffré,
/// ou ouvert avec le mot de passe propriétaire, accorde tout.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub print: bool,
    pub print_high_quality: bool,
    pub copy: bool,
    pub modify: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    pub assemble: bool,
}

/// Lit les droits par l'API brute : pdfium-render échoue sur les chiffrements AES-256 (R6).
pub fn permissions(doc: &PdfDocument) -> Permissions {
    let b = raw_bindings();
    let bits = unsafe { b.FPDF_GetDocPermissions(doc.raw_handle()) } as u32;
    let rev = unsafe { b.FPDF_GetSecurityHandlerRevision(doc.raw_handle()) };
    let has = |bit: u32| bits & (1 << (bit - 1)) != 0;
    // Révision 2 : les bits 9 à 12 n'existent pas, les bits 3 à 6 valent pour eux.
    let legacy = rev == 2;
    Permissions {
        print: has(3),
        print_high_quality: has(3) && (legacy || has(12)),
        copy: has(5),
        modify: has(4),
        annotate: has(6),
        fill_forms: has(6) || (!legacy && has(9)),
        assemble: has(4) || (!legacy && has(11)),
    }
}

/// Ce que fait un lien ou un signet : aller à une page (ordonnée du haut de la vue si connue),
/// ou ouvrir une adresse, après confirmation de l'utilisateur côté interface. Les autres actions
/// (lancer un programme, JavaScript, autre fichier) sont ignorées volontairement.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkAction {
    Goto { page: i32, top: Option<f32> },
    Uri { uri: String },
    None,
}

fn goto_of(doc: &PdfDocument, dest: &PdfDestination) -> Option<LinkAction> {
    let page = dest.page_index().ok()? as i32;
    let page_h = doc.pages().page_size(page as PdfPageIndex).ok().map(|r| r.height().value);
    let y = match dest.view_settings().ok() {
        Some(PdfDestinationViewSettings::SpecificCoordinatesAndZoom(_, y, _)) => y,
        Some(PdfDestinationViewSettings::FitPageHorizontallyToWindow(y)) => y,
        Some(PdfDestinationViewSettings::FitBoundsHorizontallyToWindow(y)) => y,
        _ => None,
    };
    let top = match (y, page_h) {
        (Some(y), Some(h)) => Some((h - y.value).clamp(0.0, h)),
        _ => None,
    };
    Some(LinkAction::Goto { page, top })
}

fn action_of(doc: &PdfDocument, action: Option<PdfAction>, dest: Option<PdfDestination>) -> LinkAction {
    if let Some(a) = dest.as_ref().and_then(|d| goto_of(doc, d)) {
        return a;
    }
    let Some(action) = action else { return LinkAction::None };
    if let Some(local) = action.as_local_destination_action() {
        if let Some(a) = local.destination().ok().and_then(|d| goto_of(doc, &d)) {
            return a;
        }
    }
    if let Some(uri) = action.as_uri_action().and_then(|u| u.uri().ok()) {
        let uri = uri.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
        if !uri.is_empty() {
            return LinkAction::Uri { uri };
        }
    }
    LinkAction::None
}

/// Un lien d'une page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PageLink {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub action: LinkAction,
}

pub fn page_links(doc: &PdfDocument, page: &PdfPage) -> Vec<PageLink> {
    let page_h = page.height().value;
    let mut out = Vec::new();
    for link in page.links().iter().take(2000) {
        let Ok(r) = link.rect() else { continue };
        let action = action_of(doc, link.action(), link.destination());
        if matches!(action, LinkAction::None) {
            continue;
        }
        let (l, b, rt, t) = (r.left().value, r.bottom().value, r.right().value, r.top().value);
        out.push(PageLink { x: l.min(rt), y: page_h - t.max(b), w: (rt - l).abs(), h: (t - b).abs(), action });
    }
    out
}

/// Signet (table des matières du PDF).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Bookmark {
    pub title: String,
    pub action: LinkAction,
    pub children: Vec<Bookmark>,
}

/// Limites contre les PDF piégés (signets en boucle ou démesurés).
const MAX_BOOKMARKS: usize = 20_000;
const MAX_BOOKMARK_DEPTH: usize = 48;

pub fn bookmarks(doc: &PdfDocument) -> Vec<Bookmark> {
    fn walk(doc: &PdfDocument, first: Option<PdfBookmark>, depth: usize, budget: &mut usize) -> Vec<Bookmark> {
        let mut out = Vec::new();
        let mut cur = first;
        while let Some(b) = cur {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            let children = if depth < MAX_BOOKMARK_DEPTH { walk(doc, b.first_child(), depth + 1, budget) } else { Vec::new() };
            let title = b.title().unwrap_or_default().replace(['\r', '\n', '\0'], " ").trim().to_string();
            out.push(Bookmark { title, action: action_of(doc, b.action(), b.destination()), children });
            cur = b.next_sibling();
        }
        out
    }
    let mut budget = MAX_BOOKMARKS;
    walk(doc, doc.bookmarks().root(), 0, &mut budget)
}

/// Résultats de recherche d'une page : un résultat = un ou plusieurs rectangles [x, y, l, h]
/// (un par ligne s'il est coupé).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PageHits {
    pub page: i32,
    pub hits: Vec<Vec<[f32; 4]>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBatch {
    pub pages: Vec<PageHits>,
    /// Pages parcourues qui contiennent du texte (aucune : document numérisé ?).
    pub pages_with_text: i32,
}

const MAX_HITS_PER_PAGE: usize = 2000;

/// Cherche `query` dans les pages `from..from + count`. L'appelant découpe en lots pour que le
/// rendu des pages visibles ne soit jamais bloqué longtemps.
pub fn search(doc: &PdfDocument, from: i32, count: i32, query: &str, match_case: bool, whole_word: bool) -> Result<SearchBatch> {
    let total = doc.pages().len();
    let opts = PdfSearchOptions::new().match_case(match_case).match_whole_word(whole_word);
    let mut batch = SearchBatch { pages: Vec::new(), pages_with_text: 0 };
    for index in from.max(0)..(from.saturating_add(count)).min(total) {
        let page = doc.pages().get(index).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let page_h = page.height().value;
        let text = page.text().map_err(|e| anyhow::anyhow!("{e:?}"))?;
        if text.len() > 0 {
            batch.pages_with_text += 1;
        }
        if query.is_empty() {
            continue;
        }
        let found = text.search(query, &opts).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let mut hits = Vec::new();
        for segments in found.iter(PdfSearchDirection::SearchForward) {
            let rects: Vec<[f32; 4]> = segments
                .iter()
                .map(|s| {
                    let r = s.bounds();
                    let (l, b, rt, t) = (r.left().value, r.bottom().value, r.right().value, r.top().value);
                    [l, page_h - t, (rt - l).max(0.5), (t - b).max(0.5)]
                })
                .collect();
            if !rects.is_empty() {
                hits.push(rects);
            }
            if hits.len() >= MAX_HITS_PER_PAGE {
                break;
            }
        }
        if !hits.is_empty() {
            batch.pages.push(PageHits { page: index, hits });
        }
    }
    Ok(batch)
}

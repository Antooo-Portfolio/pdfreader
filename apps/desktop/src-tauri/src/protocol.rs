//! Échanges entre l'application et le processus moteur (même exécutable, lancé avec
//! `--engine-host`). Chaque message est une trame : longueur de l'en-tête JSON (u32 LE),
//! longueur des données binaires (u32 LE), l'en-tête, puis les données (tuile WebP, miniature,
//! image de signature, pièce jointe). Les deux côtés sont le même binaire : mêmes types.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use pdfreader_engine as eng;
use serde::{Deserialize, Serialize};

/// Taille maximale d'une trame (en-tête ou données) : au-delà, le flux est considéré corrompu.
const MAX_PART: u32 = 1 << 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub id: u32,
    pub path: String,
    pub name: String,
    pub title: Option<String>,
    pub page_count: i32,
    /// Taille de chaque page en points PDF (largeur, hauteur), rotation comprise.
    pub pages: Vec<[f32; 2]>,
    pub encrypted: bool,
    pub has_form: bool,
    pub is_xfa: bool,
    pub permissions: serde_json::Value,
    /// Nombre de pièces jointes (panneau affiché seulement s'il y en a).
    pub attachment_count: u16,
    /// Le fichier porte la « marque du Web » (téléchargé) : vue protégée.
    pub from_internet: bool,
    /// Les signets peuvent être modifiés (document non chiffré).
    pub bookmarks_editable: bool,
    /// Empreinte du fichier (clé des récents et de l'état de vue).
    pub fingerprint: String,
    /// Dernier état de vue mémorisé, rempli par la commande `doc_open`.
    pub view_state: Option<serde_json::Value>,
    /// Change à chaque rechargement (après enregistrement) : invalide le cache des tuiles.
    pub generation: u32,
}

/// Résultat d'une ouverture ; la miniature voyage dans les données binaires de la trame.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenResult {
    pub info: DocInfo,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub bytes: u64,
    pub generation: u32,
    pub fingerprint: String,
    pub old_fingerprint: String,
}

/// Opération sur les commentaires d'une page.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum AnnotOp {
    List,
    Markup { kind: String, rects: Vec<[f32; 4]>, color: [u8; 3], opacity: f32, author: String },
    Note { x: f32, y: f32, contents: String, color: [u8; 3], author: String },
    Ink { strokes: Vec<Vec<[f32; 2]>>, color: [u8; 3], opacity: f32, width: f32, author: String },
    Update { id: String, patch: eng::annotations::AnnotPatch },
    Text { x: f32, y: f32, text: String, size: f32, color: [u8; 3], author: String },
    Mark { x: f32, y: f32, size: f32, cross: bool, color: [u8; 3], author: String },
    TextBox { rect: [f32; 4], text: String, size: f32, color: [u8; 3], filled: bool, anchor: Option<[f32; 2]>, author: String },
    /// L'image PNG voyage dans les données binaires de la trame.
    Image { rect: [f32; 4], kind: String, author: String },
    Delete { id: String },
    Shape { kind: String, points: Vec<[f32; 2]>, color: [u8; 3], opacity: f32, width: f32, fill: Option<[u8; 3]>, author: String },
    Stamp { x: f32, y: f32, preset: String, label: String, subtitle: Option<String>, author: String },
    Reply { parent: String, contents: String, author: String },
    Status { id: String, status: Option<String>, marked: Option<bool> },
}

/// Demande envoyée au moteur. Les numéros de document sont choisis par l'application : après un
/// redémarrage du moteur, les documents sont rouverts sous le même numéro.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd")]
pub enum Request {
    /// `shown_as` : le fichier lu est une copie de récupération, présentée (et enregistrée) sous
    /// le chemin du document d'origine.
    Open { doc: u32, path: PathBuf, shown_as: Option<PathBuf>, password: Option<String>, generation: u32 },
    TextLayer { doc: u32, page: i32 },
    Annot { doc: u32, page: i32, op: AnnotOp },
    Save { doc: u32, path: Option<PathBuf> },
    CountHighlights { doc: u32, page: i32 },
    /// Impression : avance d'une page chaque fois que le moteur n'a rien d'autre à faire ; la
    /// progression arrive en événements.
    Print { doc: u32, opts: eng::print_win::PrintOptions },
    CancelPrint,
    /// Copie de récupération : enregistre l'état actuel ailleurs, sans toucher au document ouvert.
    Snapshot { doc: u32, target: PathBuf },
    /// Le fichier a-t-il été modifié (ou supprimé) par un autre programme depuis l'ouverture ?
    ChangedOnDisk { doc: u32 },
    /// Relit le fichier depuis le disque (abandonne les modifications en mémoire).
    Reload { doc: u32 },
    Fields { doc: u32, page: i32 },
    SetField { doc: u32, page: i32, index: i32, input: eng::fill::FieldInput, scripts: bool },
    Links { doc: u32, page: i32 },
    Bookmarks { doc: u32 },
    Properties { doc: u32 },
    /// Remplace les signets (écrits au prochain enregistrement).
    SetBookmarks { doc: u32, items: Vec<eng::outline::OutlineItem> },
    Attachments { doc: u32 },
    AttachmentBytes { doc: u32, index: u16 },
    SearchSnippets { doc: u32, from: i32, count: i32, query: String, match_case: bool, whole_word: bool, already: usize },
    Search { doc: u32, from: i32, count: i32, query: String, match_case: bool, whole_word: bool },
    Close { doc: u32 },
    Tile { doc: u32, page: i32, scale: f32, x: i32, y: i32, size: i32 },
    /// Tests de bout en bout seulement (PDFREADER_E2E) : arrêt brutal ou blocage du moteur.
    TestCrash { doc: Option<u32> },
    TestHang { doc: Option<u32> },
}

impl Request {
    /// Document concerné (pour savoir lequel a fait tomber le moteur).
    pub fn doc(&self) -> Option<u32> {
        use Request::*;
        match self {
            Open { doc, .. }
            | TextLayer { doc, .. }
            | Annot { doc, .. }
            | Save { doc, .. }
            | CountHighlights { doc, .. }
            | Print { doc, .. }
            | Snapshot { doc, .. }
            | ChangedOnDisk { doc }
            | Reload { doc }
            | Fields { doc, .. }
            | SetField { doc, .. }
            | Links { doc, .. }
            | Bookmarks { doc }
            | Properties { doc }
            | SetBookmarks { doc, .. }
            | Attachments { doc }
            | AttachmentBytes { doc, .. }
            | SearchSnippets { doc, .. }
            | Search { doc, .. }
            | Close { doc }
            | Tile { doc, .. } => Some(*doc),
            TestCrash { doc } | TestHang { doc } => *doc,
            CancelPrint => None,
        }
    }

    /// Délai au-delà duquel un moteur muet est considéré bloqué. Les opérations qui lisent ou
    /// écrivent tout le fichier ont droit à beaucoup plus de temps que l'affichage.
    pub fn patience(&self) -> std::time::Duration {
        use Request::*;
        let secs = match self {
            Open { .. } | Save { .. } | Snapshot { .. } | Reload { .. } | AttachmentBytes { .. } | Search { .. } | SearchSnippets { .. } => 600,
            _ => 30,
        };
        std::time::Duration::from_secs(secs)
    }
}

/// En-tête envoyé par l'application.
#[derive(Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub id: u64,
    #[serde(flatten)]
    pub req: Request,
}

/// En-tête envoyé par le moteur : réponse (`ok` ou `err`) ou progression d'une impression.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Answer {
    Ok { id: u64, value: serde_json::Value },
    Err { id: u64, error: serde_json::Value },
    Progress { id: u64, done: usize, total: usize },
}

pub fn write_frame(w: &mut impl Write, header: &impl Serialize, data: &[u8]) -> io::Result<()> {
    let head = serde_json::to_vec(header).map_err(io::Error::other)?;
    let mut buf = Vec::with_capacity(8 + head.len() + data.len());
    buf.extend_from_slice(&(head.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
    buf.extend_from_slice(&head);
    buf.extend_from_slice(data);
    w.write_all(&buf)?;
    w.flush()
}

/// Lit une trame ; `Ok(None)` en fin de flux (l'autre côté s'est arrêté).
pub fn read_frame<T: for<'de> Deserialize<'de>>(r: &mut impl Read) -> io::Result<Option<(T, Vec<u8>)>> {
    let mut lens = [0u8; 8];
    match r.read_exact(&mut lens) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let hl = u32::from_le_bytes(lens[..4].try_into().unwrap());
    let dl = u32::from_le_bytes(lens[4..].try_into().unwrap());
    if hl > MAX_PART || dl > MAX_PART {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "trame démesurée"));
    }
    let mut head = vec![0u8; hl as usize];
    r.read_exact(&mut head)?;
    let mut data = vec![0u8; dl as usize];
    r.read_exact(&mut data)?;
    let header = serde_json::from_slice(&head).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some((header, data)))
}

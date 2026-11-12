//! Partagé par les tests du moteur : une seule instance de PDFium par binaire de test (PDFium
//! ne se recharge pas après avoir été libéré), utilisée par un test à la fois.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use pdfium_render::prelude::Pdfium;

static PDFIUM: OnceLock<Mutex<Pdfium>> = OnceLock::new();

pub fn pdfium() -> MutexGuard<'static, Pdfium> {
    PDFIUM
        .get_or_init(|| Mutex::new(pdfreader_engine::load_pdfium(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/pdfium-win-x64/bin")).expect("pdfium.dll")))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Fichier du corpus généré (`tools/corpus/make_corpus.py`), s'il existe.
pub fn corpus(name: &str) -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/generated").join(name);
    p.exists().then_some(p)
}

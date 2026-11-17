//! Phase 2, « Protéger par mot de passe » : chiffrement AES-256 (PDF 2.0, révision 6) avec un mot
//! de passe d'ouverture et / ou un mot de passe des droits qui limite l'impression, la copie, la
//! modification… PDFium ne sait pas chiffrer : le document en clair (enregistré par PDFium) est
//! chiffré par lopdf. Retirer la protection : PDFium enregistre une copie sans chiffrement.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{EncryptionState, EncryptionVersion, Permissions};
use serde::{Deserialize, Serialize};

/// Ce que permet un document protégé à qui l'ouvre sans le mot de passe des droits.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Allowed {
    pub print: bool,
    pub print_high_quality: bool,
    pub copy: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    /// Modifier le document et organiser ses pages.
    pub modify: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protection {
    /// Mot de passe demandé à l'ouverture (aucun : le document s'ouvre sans).
    pub open_password: Option<String>,
    /// Mot de passe des droits, et ce qui reste permis sans lui (aucun : rien n'est limité).
    pub restrictions: Option<(String, Allowed)>,
}

/// Mot de passe accepté : 1 à 127 caractères (limite de la révision 6, en UTF-8).
fn check(pw: &str) -> Result<()> {
    if pw.is_empty() || pw.len() > 127 {
        bail!("password_length");
    }
    Ok(())
}

impl Protection {
    /// Mots de passe utilisateur et propriétaire, et droits, selon les règles :
    /// - sans restriction, le propriétaire a le même mot de passe que l'utilisateur (un mot de passe
    ///   propriétaire vide ouvrirait le document sans rien demander) ;
    /// - avec restrictions, le mot de passe des droits doit différer de celui d'ouverture.
    fn passwords(&self) -> Result<(String, String, Permissions)> {
        match (&self.open_password, &self.restrictions) {
            (None, None) => bail!("nothing_to_protect"),
            (Some(open), None) => {
                check(open)?;
                Ok((open.clone(), open.clone(), Permissions::all()))
            }
            (open, Some((owner, allowed))) => {
                check(owner)?;
                if let Some(o) = open {
                    check(o)?;
                    if o == owner {
                        bail!("same_passwords");
                    }
                }
                let mut p = Permissions::COPYABLE_FOR_ACCESSIBILITY;
                p.set(Permissions::PRINTABLE, allowed.print);
                p.set(Permissions::PRINTABLE_IN_HIGH_QUALITY, allowed.print && allowed.print_high_quality);
                p.set(Permissions::COPYABLE, allowed.copy);
                p.set(Permissions::ANNOTABLE, allowed.annotate);
                p.set(Permissions::FILLABLE, allowed.fill_forms || allowed.annotate);
                p.set(Permissions::MODIFIABLE, allowed.modify);
                p.set(Permissions::ASSEMBLABLE, allowed.modify);
                Ok((open.clone().unwrap_or_default(), owner.clone(), p))
            }
        }
    }

    /// Mot de passe qui rouvre le document avec tous les droits (pour l'auteur, dans cette session).
    pub fn full_access_password(&self) -> Option<String> {
        self.restrictions.as_ref().map(|(o, _)| o.clone()).or_else(|| self.open_password.clone())
    }
}

/// Chiffre en AES-256 un PDF en clair ; renvoie le PDF protégé.
pub fn protect(plain: &[u8], prot: &Protection) -> Result<Vec<u8>> {
    let (user, owner, permissions) = prot.passwords()?;
    let mut doc = lopdf::Document::load_mem(plain).context("lecture du document")?;
    if doc.is_encrypted() {
        bail!("already_encrypted");
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| anyhow::anyhow!("aléa indisponible : {e}"))?;
    let aes: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), aes)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password: &user,
        permissions,
    };
    let state = EncryptionState::try_from(version).map_err(|e| anyhow::anyhow!("{e}"))?;
    key.fill(0);
    doc.encrypt(&state).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut out = Vec::new();
    doc.save_to(&mut out).context("écriture du document protégé")?;
    Ok(out)
}

/// Copie en clair du document ouvert (état actuel, modifications comprises) : enregistrement
/// complet, sans chiffrement s'il était protégé (FPDF_REMOVE_SECURITY). L'appelant vérifie que
/// l'utilisateur a tous les droits.
pub fn plain_bytes(doc: &pdfium_render::prelude::PdfDocument) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let flags = if crate::is_encrypted(doc) { 3 } else { 0 };
    doc.save_to_writer_with_flags(&mut buf, flags).map_err(|e| anyhow::anyhow!("échec de l'enregistrement : {e:?}"))?;
    Ok(buf)
}

/// Tous les droits (document non protégé, ou ouvert avec le mot de passe des droits).
pub fn full_rights(doc: &pdfium_render::prelude::PdfDocument) -> bool {
    let p = crate::permissions(doc);
    p.print && p.print_high_quality && p.copy && p.modify && p.annotate && p.fill_forms && p.assemble
}

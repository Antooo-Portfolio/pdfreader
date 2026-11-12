//! Chaîne de signature des mises à jour : le setup construit (avec la clé privée gardée hors du
//! dépôt) est accepté par la clé publique de tauri.conf.json, exactement comme le fait l'updater
//! de Tauri avant d'installer ; un setup modifié d'un seul octet est refusé.
//! Ignoré si le setup signé n'a pas été construit.

use std::path::Path;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

fn b64_text(s: &str) -> String {
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s.trim()).expect("base64")).expect("utf-8")
}

#[test]
fn built_setup_is_accepted_and_tampering_is_refused() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(manifest.join("tauri.conf.json")).unwrap()).unwrap();
    let version = conf["version"].as_str().unwrap();
    let setup = manifest.join(format!("../../../target/release/bundle/nsis/PDFReader_{version}_x64-setup.exe"));
    let sig = setup.with_extension("exe.sig");
    if !setup.exists() || !sig.exists() {
        eprintln!("setup signé absent : test ignoré");
        return;
    }
    let pubkey = PublicKey::decode(&b64_text(conf["plugins"]["updater"]["pubkey"].as_str().unwrap())).expect("clé publique");
    let signature = Signature::decode(&b64_text(&std::fs::read_to_string(&sig).unwrap())).expect("signature");
    let mut bytes = std::fs::read(&setup).unwrap();
    pubkey.verify(&bytes, &signature, true).expect("le setup construit doit être accepté");
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0x01;
    assert!(pubkey.verify(&bytes, &signature, true).is_err(), "un setup modifié doit être refusé");
}

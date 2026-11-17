//! Phase 2, « Protéger par mot de passe » : AES-256 révision 6, mot de passe d'ouverture, droits
//! limités sans le mot de passe des droits et complets avec, règles des mots de passe, retrait de
//! la protection, nouvelle protection d'un document déjà protégé.

mod common;

use pdfium_render::prelude::*;
use pdfreader_engine as eng;
use pdfreader_engine::security::{Allowed, Protection, full_rights, plain_bytes, protect};

const NONE: Allowed = Allowed { print: false, print_high_quality: false, copy: false, annotate: true, fill_forms: true, modify: false };

fn text(doc: &PdfDocument) -> String {
    eng::text_layer(&doc.pages().get(0).unwrap()).unwrap().iter().flatten().map(|w| w.t.clone()).collect()
}

#[test]
fn password_protection() {
    let Some(src) = common::corpus("01-texte-10p.pdf") else {
        eprintln!("corpus absent : test ignoré");
        return;
    };
    let pdfium = common::pdfium();
    let dir = std::env::temp_dir().join(format!("pdfreader-security-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let plain = std::fs::read(&src).unwrap();
    let write = |name: &str, bytes: &[u8]| {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    };

    // Ouverture et droits limités.
    let both = Protection { open_password: Some("ouvre-moi".into()), restrictions: Some(("droits-auteur".into(), NONE)) };
    let f = write("les-deux.pdf", &protect(&plain, &both).unwrap());
    // Pour vérifier la compatibilité avec un autre lecteur (qpdf / pikepdf) : copie à cet endroit.
    if let Ok(out) = std::env::var("PDFREADER_SECURITY_OUT") {
        std::fs::copy(&f, out).unwrap();
    }
    assert!(matches!(eng::open_typed(&pdfium, &f, None), Err(eng::OpenError::PasswordRequired)));
    assert!(matches!(eng::open_typed(&pdfium, &f, Some("faux")), Err(eng::OpenError::WrongPassword)));
    let user = eng::open_typed(&pdfium, &f, Some("ouvre-moi")).unwrap();
    assert_eq!(unsafe { raw_bindings().FPDF_GetSecurityHandlerRevision(user.raw_handle()) }, 6, "AES-256, révision 6");
    let p = eng::permissions(&user);
    assert!(!p.print && !p.copy && !p.modify && !p.assemble && p.annotate && p.fill_forms, "{p:?}");
    assert!(!full_rights(&user));
    assert!(text(&user).contains("page 1"), "contenu lisible une fois ouvert");
    // Avec le mot de passe des droits : tout est permis.
    let owner = eng::open_typed(&pdfium, &f, Some("droits-auteur")).unwrap();
    assert!(full_rights(&owner));
    // Le contenu est bien chiffré : le texte n'apparaît pas en clair dans le fichier.
    assert!(!std::fs::read(&f).unwrap().windows(12).any(|w| w == b"Texte simple"));

    // Mot de passe d'ouverture seul : tous les droits une fois ouvert.
    let f2 = write("ouverture.pdf", &protect(&plain, &Protection { open_password: Some("abc123".into()), restrictions: None }).unwrap());
    assert!(matches!(eng::open_typed(&pdfium, &f2, None), Err(eng::OpenError::PasswordRequired)));
    assert!(full_rights(&eng::open_typed(&pdfium, &f2, Some("abc123")).unwrap()));

    // Restrictions seules : s'ouvre sans mot de passe, droits limités.
    let print_only = Allowed { print: true, print_high_quality: true, copy: false, annotate: false, fill_forms: false, modify: false };
    let f3 = write("droits.pdf", &protect(&plain, &Protection { open_password: None, restrictions: Some(("secret-des-droits".into(), print_only)) }).unwrap());
    let free = eng::open_typed(&pdfium, &f3, None).unwrap();
    let p3 = eng::permissions(&free);
    assert!(p3.print && p3.print_high_quality && !p3.copy && !p3.annotate && !p3.assemble, "{p3:?}");

    // Règles : rien à protéger, mêmes mots de passe, mot de passe vide.
    assert!(protect(&plain, &Protection { open_password: None, restrictions: None }).is_err());
    assert!(protect(&plain, &Protection { open_password: Some("x1".into()), restrictions: Some(("x1".into(), NONE)) }).is_err());
    assert!(protect(&plain, &Protection { open_password: Some(String::new()), restrictions: None }).is_err());

    // Retrait de la protection (document ouvert avec tous les droits) : s'ouvre sans mot de passe.
    let clear = write("sans.pdf", &plain_bytes(&owner).unwrap());
    let c = eng::open_typed(&pdfium, &clear, None).unwrap();
    assert!(!eng::is_encrypted(&c) && full_rights(&c));
    assert!(text(&c).contains("page 1"));

    // Nouvelle protection d'un document déjà protégé : copie en clair, puis chiffrement.
    let again = write("nouveau.pdf", &protect(&plain_bytes(&owner).unwrap(), &Protection { open_password: Some("nouveau".into()), restrictions: None }).unwrap());
    assert!(matches!(eng::open_typed(&pdfium, &again, Some("ouvre-moi")), Err(eng::OpenError::WrongPassword)));
    assert!(eng::open_typed(&pdfium, &again, Some("nouveau")).is_ok());

    drop((user, owner, free, c));
    let _ = std::fs::remove_dir_all(&dir);
}

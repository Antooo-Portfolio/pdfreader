fn main() {
    // Version de PDFium affichée dans « À propos » (fichier VERSION de pdfium-binaries).
    let version = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vendor/pdfium-win-x64/VERSION");
    println!("cargo:rerun-if-changed={}", version.display());
    let build = std::fs::read_to_string(&version)
        .ok()
        .and_then(|v| v.lines().find_map(|l| l.strip_prefix("BUILD=").map(str::to_string)))
        .unwrap_or_default();
    println!("cargo:rustc-env=PDFIUM_BUILD={build}");
    tauri_build::build()
}

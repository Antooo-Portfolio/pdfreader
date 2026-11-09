# vendor/

- `pdfium-win-x64/` : binaire PDFium (bblanchon/pdfium-binaries, chromium/8138), BSD-3 / Apache-2.0.
  Non versionné (voir .gitignore) : à retélécharger par le script de build.
- `pdfium-render/` : copie de pdfium-render 0.9.5 (MIT OR Apache-2.0) avec un seul correctif :
  `PdfDocument::save_to_writer_with_flags()` pour la sauvegarde incrémentale (`FPDF_INCREMENTAL`),
  absente de l'API publique. À proposer en amont, puis supprimer cette copie.

//! Moteur PDF de PDFReader (spike M0) : fines enveloppes autour de PDFium via pdfium-render.
//!
//! PDFium n'est pas thread-safe : dans l'application, tous les appels passeront par un thread
//! moteur dédié. Ici, le spike reste mono-thread.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use pdfium_render::prelude::*;

/// Charge `pdfium.dll` depuis un dossier (embarqué à côté de l'exécutable dans l'app).
pub fn load_pdfium(lib_dir: &Path) -> Result<Pdfium> {
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(lib_dir))
        .with_context(|| format!("impossible de charger PDFium depuis {}", lib_dir.display()))?;
    Ok(Pdfium::new(bindings))
}

/// Compteurs de lecture : prouvent que l'ouverture lit par blocs et non tout le fichier.
#[derive(Clone, Default)]
pub struct ReadStats {
    pub bytes: Arc<AtomicU64>,
    pub calls: Arc<AtomicU64>,
}

impl ReadStats {
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    pub fn calls(&self) -> u64 {
        self.calls.load(Ordering::Relaxed)
    }
}

/// Lecteur de fichier qui compte les octets lus. PDFium lit à la demande (FPDF_LoadCustomDocument).
pub struct CountingReader {
    inner: BufReader<File>,
    stats: ReadStats,
}

impl CountingReader {
    pub fn open(path: &Path) -> Result<(Self, ReadStats)> {
        let file = File::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
        let stats = ReadStats::default();
        Ok((Self { inner: BufReader::with_capacity(64 * 1024, file), stats: stats.clone() }, stats))
    }
}

impl Read for CountingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.stats.bytes.fetch_add(n as u64, Ordering::Relaxed);
        self.stats.calls.fetch_add(1, Ordering::Relaxed);
        Ok(n)
    }
}

impl Seek for CountingReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

/// Ouvre un PDF en lecture par blocs.
pub fn open_document<'a>(pdfium: &'a Pdfium, path: &Path, password: Option<&str>) -> Result<(PdfDocument<'a>, ReadStats)> {
    let (reader, stats) = CountingReader::open(path)?;
    let doc = pdfium
        .load_pdf_from_reader(reader, password)
        .map_err(|e| anyhow::anyhow!("PDFium n'a pas pu ouvrir {} : {e:?}", path.display()))?;
    Ok((doc, stats))
}

/// Une tuile rendue : pixels RGBA (pdfium-render active FPDF_REVERSE_BYTE_ORDER par défaut),
/// directement utilisables par un `ImageData` côté WebView. `width` × `height`.
pub struct Tile {
    pub width: i32,
    pub height: i32,
    pub rgba: Vec<u8>,
}

/// Rend une tuile `size`×`size` de la page à l'échelle `scale` (1.0 = 72 ppp), coin haut-gauche
/// de la tuile en (`x`, `y`) pixels dans la page rendue.
pub fn render_tile(page: &PdfPage, scale: f32, x: i32, y: i32, size: i32) -> Result<Tile> {
    let page_w = (page.width().value * scale).ceil() as i32;
    let page_h = (page.height().value * scale).ceil() as i32;
    let w = size.min(page_w - x).max(1);
    let h = size.min(page_h - y).max(1);
    let mut bitmap = PdfBitmap::empty(w, h, PdfBitmapFormat::BGRA).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let config = PdfRenderConfig::new()
        .scale_page_by_factor(scale)
        .set_origin(-x, -y)
        .set_clear_color(PdfColor::WHITE)
        .render_form_data(true)
        .render_annotations(true);
    page.render_into_bitmap_with_config(&mut bitmap, &config).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(Tile { width: w, height: h, rgba: bitmap.as_raw_bytes() })
}

/// Rend la page entière (pour les vérifications visuelles du spike).
pub fn render_page(page: &PdfPage, scale: f32) -> Result<Tile> {
    let w = (page.width().value * scale).ceil() as i32;
    let h = (page.height().value * scale).ceil() as i32;
    let mut bitmap = PdfBitmap::empty(w, h, PdfBitmapFormat::BGRA).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let config = PdfRenderConfig::new()
        .scale_page_by_factor(scale)
        .set_clear_color(PdfColor::WHITE)
        .render_form_data(true)
        .render_annotations(true);
    page.render_into_bitmap_with_config(&mut bitmap, &config).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(Tile { width: w, height: h, rgba: bitmap.as_raw_bytes() })
}

/// Surligne la première occurrence de `needle` sur la page. Renvoie le rectangle surligné.
pub fn highlight_first(page: &mut PdfPage, needle: &str, author: &str, rgb: (u8, u8, u8)) -> Result<PdfRect> {
    let rect = {
        let text = page.text().map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let search = text.search(needle, &PdfSearchOptions::new()).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let Some(segments) = search.find_next() else { bail!("« {needle} » introuvable sur la page") };
        let first = segments.iter().next().context("segment vide")?;
        first.bounds()
    };
    let mut annot = page.annotations_mut().create_highlight_annotation().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    // Ordre des QuadPoints attendu par les lecteurs (et par le générateur d'apparence de PDFium) :
    // haut-gauche, haut-droit, bas-gauche, bas-droit. PdfQuadPoints::from_rect utilise un autre
    // ordre et produit une apparence dégénérée : ne pas l'utiliser.
    let quad = PdfQuadPoints::new(rect.left(), rect.top(), rect.right(), rect.top(), rect.left(), rect.bottom(), rect.right(), rect.bottom());
    annot.attachment_points_mut().create_attachment_point_at_end(quad).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_bounds(rect).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_stroke_color(PdfColor::new(rgb.0, rgb.1, rgb.2, 255)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_creator(author).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_contents("Vérifier ce point").map_err(|e| anyhow::anyhow!("{e:?}"))?;
    // Drapeau « Imprimer » (/F 4) : sans lui, les lecteurs n'impriment pas l'annotation.
    annot.set_is_printed(true).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(rect)
}

/// Ajoute une note (annotation Text) en (`x`, `y`) points PDF.
pub fn add_note(page: &mut PdfPage, x: f32, y: f32, text: &str, author: &str) -> Result<()> {
    let mut annot = page.annotations_mut().create_text_annotation(text).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot
        .set_bounds(PdfRect::new_from_values(y, x, y + 20.0, x + 20.0))
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_creator(author).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_fill_color(PdfColor::new(140, 200, 255, 255)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    annot.set_is_printed(true).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(())
}

/// Remplit un champ par le moteur de formulaires interactif de PDFium (comme un utilisateur :
/// clic au point (`x`, `y`) en points PDF, puis saisie). Contrairement à `set_value`, PDFium
/// régénère alors l'apparence (/AP) du champ, indispensable pour que la valeur s'affiche partout.
/// `value = None` : simple clic (case à cocher, bouton radio).
pub fn fill_field_interactive(doc: &PdfDocument, page: &PdfPage, x: f64, y: f64, value: Option<&str>) -> Result<()> {
    let form = doc.form().context("pas de formulaire")?.raw_handle();
    let page_h = page.raw_handle();
    let b = raw_bindings();
    unsafe {
        b.FORM_OnAfterLoadPage(page_h, form);
        b.FORM_OnLButtonDown(form, page_h, 0, x, y);
        b.FORM_OnLButtonUp(form, page_h, 0, x, y);
        if let Some(text) = value {
            let mut utf16: Vec<u16> = text.encode_utf16().collect();
            utf16.push(0);
            b.FORM_SelectAllText(form, page_h);
            b.FORM_ReplaceSelection(form, page_h, utf16.as_ptr() as _);
        }
        b.FORM_ForceToKillFocus(form);
        b.FORM_OnBeforeClosePage(page_h, form);
    }
    Ok(())
}

/// Écriture atomique : fichier temporaire à côté de la cible, fsync, puis renommage.
pub fn atomic_write(target: &Path, write: impl FnOnce(&mut File) -> Result<()>) -> Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let tmp: PathBuf = dir.join(format!(
        ".{}.tmp-{}",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("pdf"),
        std::process::id()
    ));
    {
        let mut f = File::create(&tmp)?;
        write(&mut f)?;
        f.flush()?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// Sauvegarde le document dans `target`. `incremental` : fichier d'origine + mise à jour ajoutée.
/// Écrit directement dans un fichier temporaire (pas de copie en mémoire, même pour 2 Go), puis
/// le renomme : le document continue de lire l'original pendant l'écriture.
pub fn save(doc: &PdfDocument, target: &Path, incremental: bool) -> Result<()> {
    atomic_write(target, |f| {
        let mut writer = f.try_clone()?;
        doc.save_to_writer_with_flags(&mut writer, if incremental { 1 } else { 0 })
            .map_err(|e| anyhow::anyhow!("échec de la sauvegarde : {e:?}"))?;
        Ok(())
    })
}

/// Mémoire du processus (octets), pour les mesures.
pub fn process_memory() -> u64 {
    memory_stats::memory_stats().map(|m| m.physical_mem as u64).unwrap_or(0)
}

pub mod reading;
pub use reading::*;
pub mod annotations;

#[cfg(windows)]
pub mod print_win;

// ============================================================================ M1

/// Erreur d'ouverture typée, pour que l'interface réagisse (demander le mot de passe, etc.).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum OpenError {
    PasswordRequired,
    WrongPassword,
    NotFound,
    Corrupted(String),
    Other(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Ouvre un PDF par blocs, avec une erreur typée.
pub fn open_typed<'a>(pdfium: &'a Pdfium, path: &Path, password: Option<&str>) -> std::result::Result<PdfDocument<'a>, OpenError> {
    if !path.exists() {
        return Err(OpenError::NotFound);
    }
    let (reader, _) = CountingReader::open(path).map_err(|e| OpenError::Other(e.to_string()))?;
    pdfium.load_pdf_from_reader(reader, password).map_err(|e| match e {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            if password.is_some() { OpenError::WrongPassword } else { OpenError::PasswordRequired }
        }
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => OpenError::Corrupted(format!("{e:?}")),
        other => OpenError::Other(format!("{other:?}")),
    })
}

/// Un mot de la couche de texte, en points PDF, origine en HAUT à gauche de la page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TextWord {
    /// Texte du mot, espace finale comprise s'il y en a une (le copier-coller garde les espaces).
    pub t: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

type WordAcc = Option<(String, f32, f32, f32, f32)>; // texte, gauche, bas, droite, haut (PDF)

fn flush_word(word: &mut WordAcc, line: &mut Vec<TextWord>, page_h: f32) {
    if let Some((t, l, b, r, tp)) = word.take() {
        line.push(TextWord { t, x: l, y: page_h - tp, w: (r - l).max(0.1), h: (tp - b).max(0.1) });
    }
}

/// Couche de texte d'une page : lignes de mots positionnés. Sert à la sélection native, au
/// copier et aux lecteurs d'écran (vrai texte DOM au-dessus de l'image de la page).
pub fn text_layer(page: &PdfPage) -> Result<Vec<Vec<TextWord>>> {
    let page_h = page.height().value;
    let text = page.text().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let mut lines: Vec<Vec<TextWord>> = Vec::new();
    let mut line: Vec<TextWord> = Vec::new();
    let mut word: WordAcc = None;
    for ch in text.chars().iter() {
        let Some(c) = ch.unicode_char() else { continue };
        if c == '\r' || c == '\n' {
            flush_word(&mut word, &mut line, page_h);
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            continue;
        }
        if c.is_whitespace() {
            if let Some(w) = word.as_mut() {
                w.0.push(' ');
            }
            flush_word(&mut word, &mut line, page_h);
            continue;
        }
        let Ok(r) = ch.loose_bounds() else { continue };
        let (l, b, rt, tp) = (r.left().value, r.bottom().value, r.right().value, r.top().value);
        let new_word = match word.as_ref() {
            // Nouveau mot si le caractère recule nettement ou change de ligne.
            Some(w) => l + 0.5 < w.1 || (b - w.2).abs() > (tp - b) * 0.6,
            None => true,
        };
        if new_word {
            flush_word(&mut word, &mut line, page_h);
            word = Some((c.to_string(), l, b, rt, tp));
        } else if let Some(w) = word.as_mut() {
            w.0.push(c);
            w.1 = w.1.min(l);
            w.2 = w.2.min(b);
            w.3 = w.3.max(rt);
            w.4 = w.4.max(tp);
        }
    }
    flush_word(&mut word, &mut line, page_h);
    if !line.is_empty() {
        lines.push(line);
    }
    Ok(lines)
}

/// Surligne une sélection : un rectangle par ligne, en points PDF (gauche, bas, droite, haut).
/// Génère l'apparence (/AP) et pose le drapeau « Imprimer ».
pub fn add_highlight(page: &mut PdfPage, rects: &[[f32; 4]], rgb: (u8, u8, u8), author: &str) -> Result<()> {
    if rects.is_empty() {
        bail!("sélection vide");
    }
    {
        let mut annot = page.annotations_mut().create_highlight_annotation().map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let (mut l, mut b, mut r, mut t) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &[x0, y0, x1, y1] in rects {
            // Ordre : haut-gauche, haut-droit, bas-gauche, bas-droit.
            let q = PdfQuadPoints::new(
                PdfPoints::new(x0), PdfPoints::new(y1), PdfPoints::new(x1), PdfPoints::new(y1),
                PdfPoints::new(x0), PdfPoints::new(y0), PdfPoints::new(x1), PdfPoints::new(y0),
            );
            annot.attachment_points_mut().create_attachment_point_at_end(q).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            l = l.min(x0);
            b = b.min(y0);
            r = r.max(x1);
            t = t.max(y1);
        }
        annot.set_bounds(PdfRect::new_from_values(b, l, t, r)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        annot.set_stroke_color(PdfColor::new(rgb.0, rgb.1, rgb.2, 255)).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        annot.set_creator(author).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        annot.set_is_printed(true).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    }
    // Un rendu fait générer l'apparence par PDFium (surlignage en Multiply).
    render_page(page, 0.25)?;
    Ok(())
}

/// Nombre d'annotations d'un type donné sur une page (contrôles et tests).
pub fn count_annotations(page: &PdfPage, kind: PdfPageAnnotationType) -> usize {
    page.annotations().iter().filter(|a| a.annotation_type() == kind).count()
}

/// Empreinte stable d'un fichier : taille + SHA-256 des 64 premiers et 64 derniers Ko.
/// Retrouve un fichier déplacé ou renommé dans les récents, sans tout relire.
pub fn fingerprint(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let mut h = Sha256::new();
    h.update(len.to_le_bytes());
    let mut buf = vec![0u8; 64 * 1024];
    let n = f.read(&mut buf)?;
    h.update(&buf[..n]);
    if len > 128 * 1024 {
        f.seek(SeekFrom::End(-(64 * 1024)))?;
        let n = f.read(&mut buf)?;
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Vignette PNG de la première page, `width` pixels de large (accueil, S01).
pub fn thumbnail_png(doc: &PdfDocument, width: u32) -> Result<Vec<u8>> {
    let page = doc.pages().get(0).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let tile = render_page(&page, width as f32 / page.width().value)?;
    let mut out = std::io::Cursor::new(Vec::new());
    image::write_buffer_with_format(&mut out, &tile.rgba, tile.width as u32, tile.height as u32, image::ColorType::Rgba8, image::ImageFormat::Png)?;
    Ok(out.into_inner())
}

/// Encode une tuile en WebP sans perte (format retenu au spike M0 : 5 ms par tuile 512 px).
pub fn tile_webp(tile: &Tile) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out).encode(&tile.rgba, tile.width as u32, tile.height as u32, image::ExtendedColorType::Rgba8)?;
    Ok(out)
}

/// Date de modification du fichier (détection des modifications externes).
pub fn file_mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

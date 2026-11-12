//! Polices de remplacement pour le japonais, le chinois et le coréen (spike M0, constat 5).
//!
//! Un PDF qui demande une police CJK non embarquée (« HeiseiMin-W3 », « STSong-Light »…) et
//! absente de l'ordinateur s'affichait sans texte : le correspondant de polices de Windows rend
//! alors une police latine sans ces caractères. On intercale ici un correspondant qui délègue
//! tout à celui de PDFium, sauf pour ces demandes : il choisit une police installée de la bonne
//! écriture (avec ou sans empattements selon le nom demandé) et vérifie qu'elle existe vraiment.

use std::ffi::{CStr, CString, c_char, c_int, c_uchar, c_uint, c_ulong, c_void};

use pdfium_render::prelude::*;

// Jeux de caractères (fpdf_sysfontinfo.h).
const SHIFTJIS: c_int = 128;
const HANGEUL: c_int = 129;
const GB2312: c_int = 134;
const CHINESEBIG5: c_int = 136;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Script {
    Japanese,
    SimplifiedChinese,
    TraditionalChinese,
    Korean,
}

/// Écriture demandée, d'après le jeu de caractères ou, à défaut, le nom de la police.
fn script_of(charset: c_int, face: &str) -> Option<Script> {
    match charset {
        SHIFTJIS => return Some(Script::Japanese),
        GB2312 => return Some(Script::SimplifiedChinese),
        CHINESEBIG5 => return Some(Script::TraditionalChinese),
        HANGEUL => return Some(Script::Korean),
        _ => {}
    }
    let f = face.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| f.contains(w));
    if has(&["heisei", "mincho", "gothic", "kozmin", "kozgo", "ryumin", "meiryo", "hiragino"]) && !has(&["century gothic", "franklin gothic"]) {
        Some(Script::Japanese)
    } else if has(&["stsong", "stheiti", "stkaiti", "simsun", "simhei", "yahei", "adobesong", "adobeheiti"]) {
        Some(Script::SimplifiedChinese)
    } else if has(&["msung", "mhei", "mingliu", "jhenghei", "adobeming"]) {
        Some(Script::TraditionalChinese)
    } else if has(&["hygothic", "hysmyeongjo", "batang", "gulim", "dotum", "malgun", "adobemyungjo", "adobegothicstd"]) {
        Some(Script::Korean)
    } else {
        None
    }
}

/// Polices installées avec Windows (ou ses modules de langue), de la plus proche à la plus
/// générale. `serif` : la police demandée a des empattements (Mincho, Song, Ming, Myeongjo).
fn candidates(script: Script, serif: bool) -> &'static [&'static str] {
    match (script, serif) {
        (Script::Japanese, true) => &["Yu Mincho", "MS Mincho", "MS PMincho", "Yu Gothic", "MS Gothic", "Meiryo"],
        (Script::Japanese, false) => &["Yu Gothic", "Meiryo", "MS Gothic", "MS PGothic", "Yu Mincho", "MS Mincho"],
        (Script::SimplifiedChinese, true) => &["SimSun", "NSimSun", "Microsoft YaHei", "DengXian", "SimHei"],
        (Script::SimplifiedChinese, false) => &["Microsoft YaHei", "DengXian", "SimHei", "SimSun"],
        (Script::TraditionalChinese, true) => &["PMingLiU", "MingLiU", "Microsoft JhengHei"],
        (Script::TraditionalChinese, false) => &["Microsoft JhengHei", "PMingLiU", "MingLiU"],
        (Script::Korean, true) => &["Batang", "BatangChe", "Malgun Gothic", "Gulim"],
        (Script::Korean, false) => &["Malgun Gothic", "Gulim", "Dotum", "Batang"],
    }
}

fn is_serif(face: &str) -> bool {
    let f = face.to_ascii_lowercase();
    ["mincho", "min-", "song", "ming", "myeongjo", "myungjo", "batang", "sung", "kozmin", "ryumin", "serif"].iter().any(|w| f.contains(w))
}

/// Correspondant de polices : la structure de PDFium d'abord (PDFium ne connaît qu'elle), puis
/// le correspondant d'origine auquel tout est délégué.
#[repr(C)]
struct Fallback {
    base: FPDF_SYSFONTINFO,
    inner: *mut FPDF_SYSFONTINFO,
}

unsafe fn inner(this: *mut FPDF_SYSFONTINFO) -> *mut FPDF_SYSFONTINFO {
    unsafe { (*(this as *mut Fallback)).inner }
}

unsafe extern "C" fn release(_this: *mut FPDF_SYSFONTINFO) {
    // Vit aussi longtemps que le processus (installé une seule fois).
}

unsafe extern "C" fn enum_fonts(this: *mut FPDF_SYSFONTINFO, mapper: *mut c_void) {
    unsafe {
        let i = inner(this);
        if let Some(f) = (*i).EnumFonts {
            f(i, mapper);
        }
    }
}

unsafe fn face_name(i: *mut FPDF_SYSFONTINFO, font: *mut c_void) -> Option<String> {
    unsafe {
        let f = (*i).GetFaceName?;
        let mut buf = [0 as c_char; 128];
        let n = f(i, font, buf.as_mut_ptr(), buf.len() as c_ulong);
        if n == 0 || n as usize > buf.len() {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

unsafe extern "C" fn map_font(
    this: *mut FPDF_SYSFONTINFO,
    weight: c_int,
    italic: FPDF_BOOL,
    charset: c_int,
    pitch_family: c_int,
    face: *const c_char,
    exact: *mut FPDF_BOOL,
) -> *mut c_void {
    unsafe {
        let i = inner(this);
        let Some(map) = (*i).MapFont else { return std::ptr::null_mut() };
        let requested = if face.is_null() { String::new() } else { CStr::from_ptr(face).to_string_lossy().into_owned() };
        if let Some(script) = script_of(charset, &requested) {
            // Une police du bon nom est installée : on la garde.
            let direct = map(i, weight, italic, charset, pitch_family, face, exact);
            if !direct.is_null() {
                if let Some(got) = face_name(i, direct) {
                    if got.eq_ignore_ascii_case(&requested) {
                        return direct;
                    }
                }
                if let Some(del) = (*i).DeleteFont {
                    del(i, direct);
                }
            }
            for &candidate in candidates(script, is_serif(&requested)) {
                let name = CString::new(candidate).unwrap();
                let h = map(i, weight, italic, charset, pitch_family, name.as_ptr(), exact);
                if h.is_null() {
                    continue;
                }
                // Windows rend toujours « une » police : on vérifie que c'est bien celle-là.
                if face_name(i, h).is_some_and(|got| got.eq_ignore_ascii_case(candidate)) {
                    return h;
                }
                if let Some(del) = (*i).DeleteFont {
                    del(i, h);
                }
            }
        }
        map(i, weight, italic, charset, pitch_family, face, exact)
    }
}

unsafe extern "C" fn get_font(this: *mut FPDF_SYSFONTINFO, face: *const c_char) -> *mut c_void {
    unsafe {
        let i = inner(this);
        (*i).GetFont.map(|f| f(i, face)).unwrap_or(std::ptr::null_mut())
    }
}

unsafe extern "C" fn get_font_data(this: *mut FPDF_SYSFONTINFO, font: *mut c_void, table: c_uint, buffer: *mut c_uchar, size: c_ulong) -> c_ulong {
    unsafe {
        let i = inner(this);
        (*i).GetFontData.map(|f| f(i, font, table, buffer, size)).unwrap_or(0)
    }
}

unsafe extern "C" fn get_face_name(this: *mut FPDF_SYSFONTINFO, font: *mut c_void, buffer: *mut c_char, size: c_ulong) -> c_ulong {
    unsafe {
        let i = inner(this);
        (*i).GetFaceName.map(|f| f(i, font, buffer, size)).unwrap_or(0)
    }
}

unsafe extern "C" fn get_font_charset(this: *mut FPDF_SYSFONTINFO, font: *mut c_void) -> c_int {
    unsafe {
        let i = inner(this);
        (*i).GetFontCharset.map(|f| f(i, font)).unwrap_or(0)
    }
}

unsafe extern "C" fn delete_font(this: *mut FPDF_SYSFONTINFO, font: *mut c_void) {
    unsafe {
        let i = inner(this);
        if let Some(f) = (*i).DeleteFont {
            f(i, font);
        }
    }
}

/// Installe le correspondant de polices CJK. À appeler une fois, juste après le chargement de
/// PDFium et avant d'ouvrir un document.
pub fn install_cjk_fallback() {
    let b = raw_bindings();
    unsafe {
        let inner = b.FPDF_GetDefaultSystemFontInfo();
        if inner.is_null() {
            return;
        }
        let wrapper = Box::new(Fallback {
            base: FPDF_SYSFONTINFO {
                version: (*inner).version,
                Release: Some(release),
                EnumFonts: Some(enum_fonts),
                MapFont: Some(map_font),
                GetFont: Some(get_font),
                GetFontData: Some(get_font_data),
                GetFaceName: Some(get_face_name),
                GetFontCharset: Some(get_font_charset),
                DeleteFont: Some(delete_font),
            },
            inner,
        });
        // PDFium garde le pointeur jusqu'à sa fermeture : la structure vit jusqu'à la fin.
        b.FPDF_SetSystemFontInfo(Box::leak(wrapper) as *mut Fallback as *mut FPDF_SYSFONTINFO);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_are_recognised() {
        assert_eq!(script_of(SHIFTJIS, "Whatever"), Some(Script::Japanese));
        assert_eq!(script_of(0, "HeiseiMin-W3"), Some(Script::Japanese));
        assert_eq!(script_of(0, "STSong-Light"), Some(Script::SimplifiedChinese));
        assert_eq!(script_of(0, "MSung-Light"), Some(Script::TraditionalChinese));
        assert_eq!(script_of(0, "HYSMyeongJo-Medium"), Some(Script::Korean));
        assert_eq!(script_of(0, "Century Gothic"), None);
        assert_eq!(script_of(0, "Helvetica"), None);
        assert!(is_serif("HeiseiMin-W3"));
        assert!(!is_serif("HeiseiKakuGo-W5"));
    }
}

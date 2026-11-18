//! Repère de la page affichée. PDFium dessine la boîte de recadrage de la page pivotée de son
//! /Rotate ; l'interface ne connaît que la page affichée. Les coordonnées échangées avec elle
//! sont des points de la page affichée : depuis le haut à gauche (« top ») ou, à l'intérieur du
//! moteur, depuis le bas à gauche (« up », comme le PDF). Ce repère les convertit vers les
//! coordonnées du contenu (espace utilisateur, non pivoté) et retour.

use pdfium_render::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    /// Quarts de tour horaires (0 à 3).
    pub rot: i32,
    left: f32,
    bottom: f32,
    /// Largeur et hauteur de la boîte, non pivotée.
    cw: f32,
    ch: f32,
}

impl Frame {
    pub fn of(page: &PdfPage) -> Frame {
        let b = raw_bindings();
        let h = page.raw_handle();
        let rot = unsafe { b.FPDFPage_GetRotation(h) }.rem_euclid(4);
        let mut r = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
        if unsafe { b.FPDF_GetPageBoundingBox(h, &mut r) } != 0 && r.right != r.left && r.top != r.bottom {
            let (l, rt) = (r.left.min(r.right), r.left.max(r.right));
            let (bt, t) = (r.bottom.min(r.top), r.bottom.max(r.top));
            return Frame { rot, left: l, bottom: bt, cw: rt - l, ch: t - bt };
        }
        let (dw, dh) = (page.width().value, page.height().value);
        let (cw, ch) = if rot % 2 == 1 { (dh, dw) } else { (dw, dh) };
        Frame { rot, left: 0.0, bottom: 0.0, cw, ch }
    }

    /// Repère sans rotation ni décalage (tests, pages neuves).
    pub fn plain(width: f32, height: f32) -> Frame {
        Frame { rot: 0, left: 0.0, bottom: 0.0, cw: width, ch: height }
    }

    /// Taille de la page affichée.
    pub fn width(&self) -> f32 {
        if self.rot % 2 == 1 { self.ch } else { self.cw }
    }
    pub fn height(&self) -> f32 {
        if self.rot % 2 == 1 { self.cw } else { self.ch }
    }

    /// Angle (degrés, sens trigonométrique) d'un texte du contenu qui paraît droit à l'affichage.
    pub fn angle(&self) -> f32 {
        90.0 * self.rot as f32
    }

    /// Matrice (a, b, c, d, e, f) qui envoie le repère « up » de la page affichée vers le contenu.
    pub fn matrix(&self) -> [f64; 6] {
        let (l, b, w, h) = (self.left as f64, self.bottom as f64, self.cw as f64, self.ch as f64);
        match self.rot {
            1 => [0.0, 1.0, -1.0, 0.0, l + w, b],
            2 => [-1.0, 0.0, 0.0, -1.0, l + w, b + h],
            3 => [0.0, -1.0, 1.0, 0.0, l, b + h],
            _ => [1.0, 0.0, 0.0, 1.0, l, b],
        }
    }

    pub fn is_identity(&self) -> bool {
        self.rot == 0 && self.left == 0.0 && self.bottom == 0.0
    }

    /// Point « up » de la page affichée → contenu.
    pub fn to_content(&self, x: f32, y: f32) -> (f32, f32) {
        let m = self.matrix();
        let (x, y) = (x as f64, y as f64);
        ((m[0] * x + m[2] * y + m[4]) as f32, (m[1] * x + m[3] * y + m[5]) as f32)
    }

    /// Point du contenu → repère « up » de la page affichée.
    pub fn to_view(&self, x: f32, y: f32) -> (f32, f32) {
        let (u, v) = (x - self.left, y - self.bottom);
        match self.rot {
            1 => (v, self.cw - u),
            2 => (self.cw - u, self.ch - v),
            3 => (self.ch - v, u),
            _ => (u, v),
        }
    }

    /// Rectangle (gauche, bas, droite, haut) du contenu → repère « up » de la page affichée.
    pub fn rect_to_view(&self, l: f32, b: f32, r: f32, t: f32) -> (f32, f32, f32, f32) {
        let (x0, y0) = self.to_view(l, b);
        let (x1, y1) = self.to_view(r, t);
        (x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1))
    }

    /// Rectangle (gauche, bas, droite, haut) du repère « up » → contenu.
    pub fn rect_to_content(&self, l: f32, b: f32, r: f32, t: f32) -> (f32, f32, f32, f32) {
        let (x0, y0) = self.to_content(l, b);
        let (x1, y1) = self.to_content(r, t);
        (x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1))
    }

    /// Rectangle du contenu → [x, y, largeur, hauteur] depuis le haut à gauche de la page affichée.
    pub fn rect_to_top(&self, l: f32, b: f32, r: f32, t: f32) -> [f32; 4] {
        let (l, b, r, t) = self.rect_to_view(l, b, r, t);
        [l, self.height() - t, r - l, t - b]
    }

    /// Destination d'un lien ou d'un signet (gauche, haut du contenu, chacun facultatif) → haut
    /// de la page affichée où amener la vue.
    pub fn top_of_dest(&self, left: Option<f32>, top: Option<f32>) -> Option<f32> {
        let h = self.height();
        let yd = match self.rot {
            1 => left.map(|x| x - self.left),
            2 => top.map(|y| y - self.bottom),
            3 => left.map(|x| self.cw - (x - self.left)),
            _ => top.map(|y| self.ch - (y - self.bottom)),
        }?;
        Some(yd.clamp(0.0, h))
    }

    /// Haut de la page affichée → destination (gauche, haut du contenu) à écrire.
    pub fn dest_of_top(&self, top: f32) -> (Option<f32>, Option<f32>) {
        let t = top.clamp(0.0, self.height());
        match self.rot {
            1 => (Some(self.left + t), None),
            2 => (None, Some(self.bottom + t)),
            3 => (Some(self.left + self.cw - t), None),
            _ => (None, Some(self.bottom + self.ch - t)),
        }
    }

    /// Rectangle de texte (gauche, bas, droite, haut) du repère « up » → points d'attache d'un
    /// marquage, dans l'ordre attendu : haut gauche, haut droit, bas gauche, bas droit (tels qu'à
    /// l'affichage, pour que le soulignement suive le bas des lettres).
    pub fn quad(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> FS_QUADPOINTSF {
        let (ax, ay) = self.to_content(x0, y1);
        let (bx, by) = self.to_content(x1, y1);
        let (cx, cy) = self.to_content(x0, y0);
        let (dx, dy) = self.to_content(x1, y0);
        FS_QUADPOINTSF { x1: ax, y1: ay, x2: bx, y2: by, x3: cx, y3: cy, x4: dx, y4: dy }
    }

    /// Place un objet construit dans le repère « up » de la page affichée.
    ///
    /// # Safety
    /// `obj` doit être un objet de page valide.
    pub unsafe fn place(&self, obj: FPDF_PAGEOBJECT) {
        if self.is_identity() {
            return;
        }
        let m = self.matrix();
        unsafe { raw_bindings().FPDFPageObj_Transform(obj, m[0], m[1], m[2], m[3], m[4], m[5]) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for rot in 0..4 {
            let f = Frame { rot, left: 10.0, bottom: 20.0, cw: 600.0, ch: 800.0 };
            for (x, y) in [(0.0, 0.0), (15.0, 700.0), (590.0, 33.0)] {
                let (cx, cy) = f.to_content(x, y);
                let (bx, by) = f.to_view(cx, cy);
                assert!((bx - x).abs() < 1e-3 && (by - y).abs() < 1e-3, "rot {rot} : {x},{y} → {cx},{cy} → {bx},{by}");
            }
            // Le coin bas gauche affiché est un coin de la boîte du contenu.
            let (cx, cy) = f.to_content(0.0, 0.0);
            assert!([10.0, 610.0].contains(&cx) && [20.0, 820.0].contains(&cy), "rot {rot}");
            let t = f.top_of_dest(Some(100.0), Some(500.0)).unwrap();
            let (l, tp) = f.dest_of_top(t);
            assert_eq!(f.top_of_dest(l.or(Some(100.0)), tp.or(Some(500.0))), Some(t), "rot {rot}");
        }
        // Quart de tour horaire : le haut gauche du contenu passe en haut à droite.
        let f = Frame { rot: 1, left: 0.0, bottom: 0.0, cw: 600.0, ch: 800.0 };
        assert_eq!(f.to_view(0.0, 800.0), (800.0, 600.0));
    }
}

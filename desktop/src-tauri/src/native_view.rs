//! Phase 2, P2.2: the 2D view of one viewport cell, and the image ↔ cell
//! transform. The SAME math runs in three places, which must agree:
//!   - the fragment shader (cell pixel → image pixel, native.rs SHADER);
//!   - `Transform::to_cell` / `to_image` here (pick, ROI statistics);
//!   - `desktop/src/native/transform.ts` (annotation / overlay drawing).
//! Tests on both sides use the same numbers.
//!
//! Conventions: image pixel (col, row) with (0, 0) the top-left corner of the
//! first pixel; cell coordinates in CSS px from the cell's top-left. The image
//! is centred in the cell and fitted (contain), then zoomed about the cell
//! centre, panned (CSS px), rotated clockwise in 90° steps and flipped (in the
//! displayed orientation). Invert and window/level do not move pixels.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub index: usize,
    /// Window centre and width, modality units.
    pub wl: (f32, f32),
    /// 1 = fitted to the cell.
    pub zoom: f32,
    /// CSS px, applied after the fit and zoom.
    pub pan: (f32, f32),
    /// Clockwise, 0 / 90 / 180 / 270.
    pub rotation: u16,
    pub flip_h: bool,
    pub flip_v: bool,
    pub invert: bool,
}

impl Default for View {
    fn default() -> Self {
        Self { index: 0, wl: (40.0, 400.0), zoom: 1.0, pan: (0.0, 0.0), rotation: 0, flip_h: false, flip_v: false, invert: false }
    }
}

/// A partial update from the page (every field optional).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPatch {
    pub index: Option<usize>,
    pub wl: Option<(f32, f32)>,
    pub zoom: Option<f32>,
    pub pan: Option<(f32, f32)>,
    pub rotation: Option<u16>,
    pub flip_h: Option<bool>,
    pub flip_v: Option<bool>,
    pub invert: Option<bool>,
    /// Zoom 1, no pan / rotation / flip / invert (window and slice kept).
    #[serde(default)]
    pub reset_camera: bool,
}

impl View {
    pub fn apply(&mut self, p: &ViewPatch) {
        if p.reset_camera {
            self.zoom = 1.0;
            self.pan = (0.0, 0.0);
            self.rotation = 0;
            self.flip_h = false;
            self.flip_v = false;
            self.invert = false;
        }
        if let Some(i) = p.index {
            self.index = i;
        }
        if let Some(wl) = p.wl {
            self.wl = (wl.0, wl.1.max(1.0));
        }
        if let Some(z) = p.zoom {
            self.zoom = z.clamp(0.05, 64.0);
        }
        if let Some(pan) = p.pan {
            self.pan = pan;
        }
        if let Some(r) = p.rotation {
            self.rotation = ((r as u32 % 360) / 90 * 90) as u16;
        }
        if let Some(f) = p.flip_h {
            self.flip_h = f;
        }
        if let Some(f) = p.flip_v {
            self.flip_v = f;
        }
        if let Some(i) = p.invert {
            self.invert = i;
        }
    }
}

/// Where the image sits in the cell (CSS px). Sent to the page with every view.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    /// CSS px per image pixel (fit × zoom).
    pub scale: f32,
    /// The image centre in the cell, CSS px.
    pub center: (f32, f32),
    pub cos: f32,
    pub sin: f32,
    pub flip_x: f32,
    pub flip_y: f32,
    pub cols: f32,
    pub rows: f32,
}

impl Transform {
    pub fn new(view: &View, cols: usize, rows: usize, cell_w: f32, cell_h: f32) -> Self {
        let (iw, ih) = if view.rotation % 180 == 90 { (rows as f32, cols as f32) } else { (cols as f32, rows as f32) };
        let fit = (cell_w / iw.max(1.0)).min(cell_h / ih.max(1.0));
        let (sin, cos) = match view.rotation {
            90 => (1.0, 0.0),
            180 => (0.0, -1.0),
            270 => (-1.0, 0.0),
            _ => (0.0, 1.0),
        };
        Transform {
            scale: fit * view.zoom,
            center: (cell_w / 2.0 + view.pan.0, cell_h / 2.0 + view.pan.1),
            cos,
            sin,
            flip_x: if view.flip_h { -1.0 } else { 1.0 },
            flip_y: if view.flip_v { -1.0 } else { 1.0 },
            cols: cols as f32,
            rows: rows as f32,
        }
    }

    /// Image pixel → cell CSS px. Only the tests use it; native.rs carries the inverse.
    #[cfg(test)]
    pub fn to_cell(&self, col: f32, row: f32) -> (f32, f32) {
        let fx = (col - self.cols / 2.0) * self.scale * self.flip_x;
        let fy = (row - self.rows / 2.0) * self.scale * self.flip_y;
        // Clockwise rotation in screen coordinates (y down).
        let dx = self.cos * fx - self.sin * fy;
        let dy = self.sin * fx + self.cos * fy;
        (self.center.0 + dx, self.center.1 + dy)
    }

    /// Cell CSS px → image pixel (the shader's mapping).
    pub fn to_image(&self, x: f32, y: f32) -> (f32, f32) {
        let dx = x - self.center.0;
        let dy = y - self.center.1;
        let fx = self.cos * dx + self.sin * dy;
        let fy = -self.sin * dx + self.cos * dy;
        (fx * self.flip_x / self.scale + self.cols / 2.0, fy * self.flip_y / self.scale + self.rows / 2.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
    }

    #[test]
    fn fits_and_centres() {
        // 512² image in an 800×600 cell: fit 600/512, centred.
        let t = Transform::new(&View::default(), 512, 512, 800.0, 600.0);
        assert!((t.scale - 600.0 / 512.0).abs() < 1e-6);
        assert!(close(t.to_cell(256.0, 256.0), (400.0, 300.0)));
        assert!(close(t.to_cell(0.0, 0.0), (100.0, 0.0)));
        assert!(close(t.to_cell(512.0, 512.0), (700.0, 600.0)));
    }

    #[test]
    fn rotation_is_clockwise_and_round_trips() {
        let v = View { rotation: 90, ..View::default() };
        let t = Transform::new(&v, 400, 200, 400.0, 400.0);
        // Top-left image corner goes to the top-right after a clockwise turn.
        let tl = t.to_cell(0.0, 0.0);
        assert!(tl.0 > 200.0 && tl.1 < 200.0, "{tl:?}");
        for (c, r) in [(0.0, 0.0), (123.0, 45.0), (399.0, 199.0)] {
            let (x, y) = t.to_cell(c, r);
            assert!(close(t.to_image(x, y), (c, r)));
        }
    }

    #[test]
    fn zoom_pan_flip_round_trip() {
        let v = View { zoom: 2.5, pan: (30.0, -12.0), flip_h: true, flip_v: true, rotation: 270, ..View::default() };
        let t = Transform::new(&v, 512, 384, 640.0, 480.0);
        for (c, r) in [(1.0, 2.0), (256.0, 192.0), (500.0, 10.0)] {
            let (x, y) = t.to_cell(c, r);
            assert!(close(t.to_image(x, y), (c, r)));
        }
        // flip_h on a 270° view still flips the IMAGE's columns.
        let a = t.to_cell(0.0, 192.0);
        let b = t.to_cell(512.0, 192.0);
        assert!((a.0 - b.0).abs() < 1e-3 || (a.1 - b.1).abs() > 1.0);
    }

    #[test]
    fn patch_reset_keeps_window_and_slice() {
        let mut v = View { index: 7, wl: (40.0, 400.0), zoom: 3.0, rotation: 90, invert: true, ..View::default() };
        v.apply(&ViewPatch { reset_camera: true, ..Default::default() });
        assert_eq!((v.index, v.wl, v.zoom, v.rotation, v.invert), (7, (40.0, 400.0), 1.0, 0, false));
        v.apply(&ViewPatch { rotation: Some(450), ..Default::default() });
        assert_eq!(v.rotation, 90);
    }
}

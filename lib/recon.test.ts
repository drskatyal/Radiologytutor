// Reconstruction core (packages/viewer-core/src/recon): geometry, sampling,
// slabs, multi-oblique planes, curved and cross-curved MPR. Every volume here
// is synthetic and deterministic (no patient data).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquisitionFrames,
  buildReconVolume,
  cardinalFrames,
  cprPixelToPatient,
  crossSectionGrid,
  crossSectionStations,
  crosshairLines,
  curveFrames,
  dot,
  edgeLetters,
  geometryFromSlices,
  indexToPatient,
  initialOblique,
  insertPoint,
  norm,
  normalize,
  orthogonalityError,
  paneGrid,
  paneNormal,
  paneToPatient,
  patientToIndex,
  patientToPane,
  planeName,
  reductionFor,
  removePoint,
  rotate,
  rotateOthers,
  sampleGrid,
  sampleGridSync,
  scrollPane,
  slabOffsets,
  straightenedGrid,
  sub,
  ReconCancelled,
  type ReconVolume,
  type Vec3,
  type VolumeGeometry,
} from "../packages/viewer-core/src/recon";

// ───────────── synthetic volumes ─────────────

/** An oblique, anisotropic, gantry-tilted geometry. */
function obliqueGeometry(): VolumeGeometry {
  const z: Vec3 = [0, 0, 1];
  const row = normalize(rotate([1, 0, 0], z, (30 * Math.PI) / 180));
  const col0 = normalize(rotate([0, 1, 0], z, (30 * Math.PI) / 180));
  const col = normalize(rotate(col0, row, (12 * Math.PI) / 180)); // tilted out of axial
  const normal = normalize([row[1] * col[2] - row[2] * col[1], row[2] * col[0] - row[0] * col[2], row[0] * col[1] - row[1] * col[0]]);
  const tilt = normalize(rotate(normal, row, (8 * Math.PI) / 180)); // slice step not ⟂ (gantry tilt)
  return { dims: [48, 44, 36], spacing: [0.7, 0.8, 2.5], origin: [-20, 15, -40], axes: [row, col, tilt] };
}

function fill(g: VolumeGeometry, f: (p: Vec3) => number, Arr: Int16ArrayConstructor | Float32ArrayConstructor = Float32Array): ReconVolume {
  const [nx, ny, nz] = g.dims;
  const data = new Arr(nx * ny * nz);
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) data[(k * ny + j) * nx + i] = f(indexToPatient(g, [i, j, k]));
  return { geometry: g, data };
}

const linear = (p: Vec3) => 3 * p[0] - 2 * p[1] + 5 * p[2] + 7;

const isotropic = (n: number, mm = 1): VolumeGeometry => ({
  dims: [n, n, n],
  spacing: [mm, mm, mm],
  origin: [-((n - 1) * mm) / 2, -((n - 1) * mm) / 2, -((n - 1) * mm) / 2],
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
});

const close = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);

// ───────────── geometry ─────────────

test("index ↔ patient round-trips on an oblique, anisotropic, tilted volume", () => {
  const g = obliqueGeometry();
  for (const ijk of [
    [0, 0, 0],
    [47, 43, 35],
    [10.25, 3.5, 17.75],
  ] as Vec3[]) {
    const back = patientToIndex(g, indexToPatient(g, ijk));
    ijk.forEach((v, n) => close(back[n], v, 1e-9));
  }
});

test("geometry from shuffled slices: ordered along the normal, true step, uneven spacing rejected", () => {
  const orientation = [1, 0, 0, 0, 1, 0];
  const make = (z: number, x = 0) => ({ position: [x, 0, z], orientation, pixelSpacing: [0.5, 0.6], rows: 4, columns: 5 });
  const slices = [make(10), make(0), make(5), make(2.5), make(7.5)];
  const { geometry, order } = geometryFromSlices(slices);
  assert.deepEqual(order, [1, 3, 2, 4, 0]);
  assert.deepEqual(geometry.dims, [5, 4, 5]);
  assert.deepEqual(geometry.spacing.map((s) => +s.toFixed(6)), [0.6, 0.5, 2.5], "Pixel Spacing is [row, column]");
  // Gantry tilt: each slice shifts 1 mm in x per 2.5 mm in z.
  const tilted = geometryFromSlices([0, 1, 2, 3].map((k) => make(k * 2.5, k)));
  close(tilted.geometry.spacing[2], Math.hypot(1, 2.5), 1e-9, "step is the true slice-to-slice distance");
  close(tilted.geometry.axes[2][0], 1 / Math.hypot(1, 2.5), 1e-9, "slice axis keeps the tilt");
  assert.throws(() => geometryFromSlices([make(0), make(2.5), make(10)]), /unevenly spaced/);
  assert.throws(() => geometryFromSlices([make(0), { ...make(5), rows: 8 }]), /differ in size/);
});

test("trilinear sampling reproduces a linear field exactly in patient space (oblique, anisotropic, tilted)", () => {
  const g = obliqueGeometry();
  const vol = fill(g, linear);
  const s = initialOblique(g);
  for (let pane = 0; pane < 3; pane += 1) {
    const grid = paneGrid(g, s, pane, { fovMm: 30, pan: [0, 0] }, 24, 20);
    const img = sampleGridSync(vol, grid);
    let checked = 0;
    for (let y = 0; y < img.height; y += 3)
      for (let x = 0; x < img.width; x += 3) {
        const v = img.values[y * img.width + x];
        const at = paneToPatient(grid, x, y);
        const ijk = patientToIndex(g, at);
        // Exact inside the voxel grid (the outer half voxel is clamped, by design).
        if (Number.isNaN(v) || ijk.some((c, n) => c < 0 || c > g.dims[n] - 1)) continue;
        close(v, linear(at), 1e-3, `pane ${pane} (${x},${y})`);
        checked += 1;
      }
    assert.ok(checked > 20, `pane ${pane}: samples inside the volume (${checked})`);
  }
});

test("outside the volume is NaN, never tissue", () => {
  const g = isotropic(8);
  const vol = fill(g, () => 100);
  const img = sampleGridSync(vol, { kind: "plane", origin: [50, 50, 50], du: [1, 0, 0], dv: [0, 1, 0], width: 4, height: 4 });
  assert.ok([...img.values].every(Number.isNaN));
});

// ───────────── slabs ─────────────

test("slab offsets are centred and capped", () => {
  assert.deepEqual(slabOffsets(0, 1), [0]);
  assert.deepEqual(slabOffsets(4, 1), [-2, -1, 0, 1, 2]);
  assert.equal(slabOffsets(10_000, 0.1).length, 512);
});

test("MIP / MinIP / average slab across the plane normal, with the right thickness", () => {
  // Background 0; a bright sheet (1000) 4 mm above the plane z = 0, a dark one (−500) 4 mm below.
  const g = isotropic(33, 0.5);
  const vol = fill(g, (p) => (Math.abs(p[2] - 4) < 0.26 ? 1000 : Math.abs(p[2] + 4) < 0.26 ? -500 : 0));
  const plane = (slab?: { mode: "mip" | "minip" | "avg"; thicknessMm: number }) =>
    sampleGridSync(vol, {
      kind: "plane",
      origin: [-2, -2, 0],
      du: [1, 0, 0],
      dv: [0, 1, 0],
      width: 4,
      height: 4,
      slab: slab ? { ...slab, normal: [0, 0, 1] } : undefined,
    }).values[5];
  assert.equal(plane(), 0, "thin plane between the sheets");
  assert.equal(plane({ mode: "mip", thicknessMm: 6 }), 0, "6 mm slab (±3 mm) misses the sheet at +4 mm");
  assert.equal(plane({ mode: "mip", thicknessMm: 10 }), 1000, "10 mm MIP reaches it");
  assert.equal(plane({ mode: "minip", thicknessMm: 10 }), -500, "10 mm MinIP finds the dark sheet");
  close(plane({ mode: "avg", thicknessMm: 10 })!, (1000 - 500) / 21, 1e-3, "average over 21 samples, 0.5 mm apart");
});

test("an oblique plane through a sphere shows a disc of the true radius (mm), anisotropic volume", () => {
  const g: VolumeGeometry = { ...obliqueGeometry(), dims: [96, 88, 30] };
  const c = indexToPatient(g, [48, 44, 15]);
  const vol = fill(g, (p) => (norm(sub(p, c)) <= 8 ? 1000 : 0));
  let s = { ...initialOblique(g), center: c };
  s = rotateOthers(s, 0, 0.6); // a double-oblique plane in pane 1
  s = rotateOthers(s, 2, -0.4);
  const grid = paneGrid(g, s, 1, { fovMm: 40, pan: [0, 0] }, 160, 160);
  // Centre the pane on the sphere.
  const at = patientToPane(grid, c);
  const shifted = { ...grid, origin: sub(grid.origin, sub(paneToPatient(grid, 80, 80), paneToPatient(grid, at.x, at.y))) };
  const img = sampleGridSync(vol, shifted);
  const area = [...img.values].filter((v) => v > 500).length * shifted.pixelMm ** 2;
  close(area, Math.PI * 64, Math.PI * 64 * 0.1, "disc area ≈ π·8²");
});

test("cancellation: an aborted request rejects and stops", async () => {
  const g = isotropic(16);
  const vol = fill(g, () => 1);
  const ctl = new AbortController();
  let bands = 0;
  const p = sampleGrid(
    vol,
    { kind: "plane", origin: [0, 0, 0], du: [0.1, 0, 0], dv: [0, 0.1, 0], width: 64, height: 64 },
    {
      signal: ctl.signal,
      bandRows: 8,
      yieldFn: async () => {
        bands += 1;
        ctl.abort();
      },
    }
  );
  await assert.rejects(p, ReconCancelled);
  assert.equal(bands, 1, "stopped after the first band");
});

// ───────────── multi-oblique ─────────────

test("cardinal frames are radiological and labelled", () => {
  const [axial, coronal, sagittal] = cardinalFrames();
  assert.deepEqual(edgeLetters(axial.u, axial.v), { right: "L", left: "R", bottom: "P", top: "A" });
  assert.deepEqual(edgeLetters(coronal.u, coronal.v), { right: "L", left: "R", bottom: "F", top: "H" });
  assert.deepEqual(edgeLetters(sagittal.u, sagittal.v), { right: "P", left: "A", bottom: "F", top: "H" });
  assert.equal(planeName(paneNormal(axial)).label, "Axial");
  assert.equal(planeName(paneNormal(coronal)).label, "Coronal");
  const tilted = planeName(rotate([0, 0, 1], [1, 0, 0], (23 * Math.PI) / 180));
  assert.equal(tilted.label, "Oblique · 23° from axial");
});

test("rotating in one pane turns the other two about its normal; planes stay orthonormal", () => {
  const g = isotropic(16);
  let s = initialOblique(g);
  const before = s.panes[0];
  s = rotateOthers(s, 0, 0.3);
  assert.deepEqual(s.panes[0], before, "the pane being dragged does not spin");
  close(dot(paneNormal(s.panes[1]), [0, 0, 1]), 0, 1e-12, "coronal stays vertical");
  close(Math.acos(dot(paneNormal(s.panes[1]), [0, 1, 0])), 0.3, 1e-9, "coronal turned 0.3 rad");
  // Many random rotations: no drift.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let n = 0; n < 2000; n += 1) s = rotateOthers(s, n % 3, rnd());
  assert.ok(orthogonalityError(s) < 1e-9, `orthogonality error ${orthogonalityError(s)}`);
});

test("crosshair traces and linked scrolling", () => {
  const g = isotropic(16);
  const s = initialOblique(g);
  const lines = crosshairLines(s, 0); // axial pane
  const coronal = lines.find((l) => l.pane === 1)!.dir;
  const sagittal = lines.find((l) => l.pane === 2)!.dir;
  close(Math.abs(coronal[0]), 1, 1e-12, "coronal trace is horizontal on the axial");
  close(Math.abs(sagittal[1]), 1, 1e-12, "sagittal trace is vertical on the axial");
  const moved = scrollPane(s, 0, 5);
  close(moved.center[2] - s.center[2], 5, 1e-12, "scrolling the axial moves the crosshair head-ward");
  // The crosshair lies on every plane, wherever it is.
  for (let i = 0; i < 3; i += 1) {
    const grid = paneGrid(g, moved, i, { fovMm: 20, pan: [3, -2] }, 50, 40);
    close(patientToPane(grid, moved.center).depthMm, 0, 1e-9, `on pane ${i}`);
  }
});

test("acquisition-aligned frames follow an oblique scan and stay orthonormal", () => {
  const g = obliqueGeometry();
  const f = acquisitionFrames(g);
  close(Math.abs(dot(paneNormal(f[0]), normalize([
    g.axes[0][1] * g.axes[1][2] - g.axes[0][2] * g.axes[1][1],
    g.axes[0][2] * g.axes[1][0] - g.axes[0][0] * g.axes[1][2],
    g.axes[0][0] * g.axes[1][1] - g.axes[0][1] * g.axes[1][0],
  ]))), 1, 1e-9);
  assert.ok(orthogonalityError({ center: [0, 0, 0], panes: f }) < 1e-9);
});

// ───────────── curved / cross-curved ─────────────

test("a curve drawn on a plane keeps that plane's normal as up (no twist)", () => {
  const pts: Vec3[] = [
    [-20, 0, 0],
    [-5, 12, 0],
    [10, 5, 0],
    [22, 18, 0],
  ];
  const f = curveFrames(pts, 0.5, [0, 0, 1]);
  for (const u of f.up) close(u[2], 1, 1e-9);
  for (let i = 0; i < f.points.length; i += 1) close(dot(f.up[i], f.tangents[i]), 0, 1e-9);
  // Passes through every control point.
  for (const p of pts) assert.ok(Math.min(...f.points.map((q) => norm(sub(q, p)))) < 0.5);
  // Arc steps are 0.5 mm.
  for (let i = 1; i < f.points.length - 1; i += 1) close(norm(sub(f.points[i], f.points[i - 1])), 0.5, 0.02);
  const turned = curveFrames(pts, 0.5, [0, 0, 1], 90);
  for (let i = 0; i < f.points.length; i += 1) close(Math.abs(dot(turned.up[i], f.lateral[i])), 1, 1e-9, "90° turns up onto lateral");
});

test("straightened CPR of a 3D tube puts the lumen on the centre row; cross-sections show its true diameter", () => {
  const g = isotropic(81, 0.5);
  // Tube (radius 3 mm, value 1000) around a 3D arc, out of any single plane.
  const centre = (t: number): Vec3 => [14 * Math.cos(t), 14 * Math.sin(t), 4 * t - 6];
  const samples = Array.from({ length: 300 }, (_, i) => centre((i / 299) * 2.6));
  const dist = (p: Vec3) => {
    // Far from the helix's cylinder (radius 14): skip the search.
    if (Math.abs(Math.hypot(p[0], p[1]) - 14) > 4) return Infinity;
    let best = Infinity;
    for (const q of samples) best = Math.min(best, norm(sub(p, q)));
    return best;
  };
  const vol = fill(g, (p) => (dist(p) <= 3 ? 1000 : 0));
  const control = [0, 0.65, 1.3, 1.95, 2.6].map(centre);
  const f = curveFrames(control, 0.5, [0, 0, 1]);
  const grid = straightenedGrid(f, 8);
  const img = sampleGridSync(vol, grid);
  const mid = grid.halfRows;
  const inLumen = [...Array(img.width).keys()].filter((x) => img.values[mid * img.width + x] > 500).length;
  assert.ok(inLumen / img.width > 0.95, `centre row inside the lumen at ${inLumen}/${img.width} columns`);
  assert.ok(img.values[0] < 500 && img.values[(img.height - 1) * img.width] < 500, "8 mm off-axis is outside the tube");
  // CPR pixel → patient lands on the centreline at the centre row.
  close(norm(sub(cprPixelToPatient(f, grid, 10, mid), f.points[10])), 0, 1e-9);
  // Perpendicular cross-sections: a centred disc ≈ π·3².
  for (const s of crossSectionStations(f, f.lengthMm / 2, 5, 5)) {
    const cs = crossSectionGrid(f, s, 16, 0.25);
    const ci = sampleGridSync(vol, cs);
    const c = (cs.width - 1) / 2;
    assert.ok(ci.values[Math.round(c) * ci.width + Math.round(c)] > 500, "centre of the section is lumen");
    const area = [...ci.values].filter((v) => v > 500).length * 0.25 ** 2;
    close(area, Math.PI * 9, Math.PI * 9 * 0.15, `section at ${s.toFixed(1)} mm`);
  }
});

test("CPR slab across the sheet and cross-section slab along the curve", () => {
  const g = isotropic(41, 0.5);
  // A bright dot 3 mm to the side of a straight centreline along x.
  const vol = fill(g, (p) => (norm(sub(p, [0, 3, 0])) < 0.6 ? 1000 : 0));
  const f = curveFrames(
    [
      [-8, 0, 0],
      [8, 0, 0],
    ],
    0.5,
    [0, 0, 1]
  );
  const thin = sampleGridSync(vol, straightenedGrid(f, 4));
  const slab = sampleGridSync(vol, straightenedGrid(f, 4, { mode: "mip", thicknessMm: 8 }));
  const mid = (img: typeof thin) => Math.max(...img.values.slice(8 * img.width, 9 * img.width));
  assert.equal(mid(thin), 0, "thin CPR misses the dot");
  assert.ok(mid(slab) > 500, "8 mm MIP across the sheet finds it");
  // Cross-section 2 mm from the dot along the curve: thin misses, 6 mm slab along the tangent finds it.
  const at = f.lengthMm / 2 + 2;
  const thinCs = sampleGridSync(vol, crossSectionGrid(f, at, 10, 0.5));
  const slabCs = sampleGridSync(vol, crossSectionGrid(f, at, 10, 0.5, { mode: "mip", thicknessMm: 6 }));
  assert.ok(Math.max(...thinCs.values) < 500 && Math.max(...slabCs.values) > 500);
});

test("cross-section orientation matches the CPR: down = −up, right = tangent × up", () => {
  const f = curveFrames(
    [
      [0, 0, -10],
      [0, 0, 10],
    ],
    1,
    [0, -1, 0] // drawn on a coronal plane, up = anterior
  );
  const cs = crossSectionGrid(f, 5, 10, 1);
  // Looking head-ward along the curve: right = +z × −y = +x (patient left).
  assert.deepEqual(edgeLetters(cs.right, cs.down), { right: "L", left: "R", bottom: "P", top: "A" });
});

test("control-point editing: insert in the nearest segment, beyond the ends, remove", () => {
  const pts: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [20, 0, 0],
  ];
  assert.deepEqual(insertPoint(pts, [15, 1, 0]), [pts[0], pts[1], [15, 1, 0], pts[2]]);
  assert.deepEqual(insertPoint(pts, [-5, 0, 0])[0], [-5, 0, 0]);
  assert.deepEqual(insertPoint(pts, [25, 0, 0])[3], [25, 0, 0]);
  assert.deepEqual(removePoint(pts, 1), [pts[0], pts[2]]);
});

// ───────────── volume assembly ─────────────

test("assembled volumes keep patient geometry, also when reduced to fit the budget", async () => {
  const z: Vec3 = [0, 0, 1];
  const row = normalize(rotate([1, 0, 0], z, 0.4));
  const col = normalize(rotate([0, 1, 0], z, 0.4));
  const normal: Vec3 = [0, 0, 1];
  const rows = 16;
  const columns = 20;
  const ps = [0.9, 0.6];
  const slices = Array.from({ length: 12 }, (_, k) => {
    const position: Vec3 = [5 + normal[0] * k * 2, -3 + normal[1] * k * 2, 10 + k * 2];
    return {
      position,
      orientation: [...row, ...col],
      pixelSpacing: ps,
      rows,
      columns,
      values: async () => {
        const out = new Int16Array(rows * columns);
        for (let j = 0; j < rows; j += 1)
          for (let i = 0; i < columns; i += 1) {
            const p: Vec3 = [
              position[0] + row[0] * i * ps[1] + col[0] * j * ps[0],
              position[1] + row[1] * i * ps[1] + col[1] * j * ps[0],
              position[2] + row[2] * i * ps[1] + col[2] * j * ps[0],
            ];
            out[j * columns + i] = Math.round(2 * p[0] + p[1] - p[2]);
          }
        return out;
      },
    };
  });
  // Shuffled input order.
  const shuffled = [...slices].reverse();
  const full = await buildReconVolume(shuffled, { budgetBytes: 1 << 30 });
  assert.deepEqual(full.reduced, [1, 1]);
  assert.ok(full.data instanceof Int16Array);
  const reduced = await buildReconVolume(shuffled, { budgetBytes: 2000 });
  assert.notDeepEqual(reduced.reduced, [1, 1]);
  // Both reproduce the (near-linear) field at the same patient point.
  const p = indexToPatient(full.geometry, [9.5, 7.5, 5.5]);
  const a = sampleGridSync(full, { kind: "plane", origin: p, du: [1, 0, 0], dv: [0, 1, 0], width: 1, height: 1 }).values[0];
  const b = sampleGridSync(reduced, { kind: "plane", origin: p, du: [1, 0, 0], dv: [0, 1, 0], width: 1, height: 1 }).values[0];
  close(a, 2 * p[0] + p[1] - p[2], 1);
  close(b, a, 1.5, "reduced volume stays in place");
});

test("reduction ladder matches the desktop's", () => {
  const mb = 1 << 20;
  assert.deepEqual(reductionFor(512, 512, 848, 2, 768 * mb), [1, 1]);
  assert.deepEqual(reductionFor(512, 512, 2000, 2, 768 * mb), [1, 2]);
  assert.deepEqual(reductionFor(512, 512, 4332, 2, 768 * mb), [2, 1]);
  assert.deepEqual(reductionFor(1024, 1024, 4332, 2, 768 * mb), [2, 3]);
});

test("performance: a 512×512 oblique plane with a 10 mm MIP slab (reported, loosely bounded)", () => {
  const g = isotropic(160, 0.6);
  const vol = fill(g, (p) => p[0] + p[1], Int16Array);
  let s = initialOblique(g);
  s = rotateOthers(s, 0, 0.5);
  const thin = paneGrid(g, s, 1, { fovMm: 96, pan: [0, 0] }, 512, 512);
  const slab = paneGrid(g, s, 1, { fovMm: 96, pan: [0, 0] }, 512, 512, { mode: "mip", thicknessMm: 10 });
  const t0 = performance.now();
  sampleGridSync(vol, thin);
  const t1 = performance.now();
  sampleGridSync(vol, slab);
  const t2 = performance.now();
  console.log(`# recon perf (this machine, Node, single thread): 512² thin ${(t1 - t0).toFixed(0)} ms, 512² MIP 10 mm (17 samples) ${(t2 - t1).toFixed(0)} ms`);
  assert.ok(t2 - t1 < 20_000);
});

test("direction letters agree with the overlay's orientationLetters", async () => {
  const { orientationLetters } = await import("../packages/viewer-core/src/dicomOverlay");
  const { directionLetters } = await import("../packages/viewer-core/src/recon");
  for (const v of [[1, 0, 0], [0, -1, 0], [0, 0, 1], [0.8, 0.5, 0.1], [-0.2, 0.25, -0.95], [0.6, -0.6, 0.53]] as Vec3[]) {
    assert.equal(directionLetters(v), orientationLetters(v));
  }
});

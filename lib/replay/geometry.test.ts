import test from 'node:test';
import assert from 'node:assert/strict';
import { replayShape, projectReplayShapes } from './geometry';
import { journalTestView as snapshot } from '../journal/fixtures';
import { uncalibratedGeometry, patientToPixel } from '../anchors/geometry';
import type { JournalEntry } from '../journal/types';
const geometry = { calibration: 'PixelSpacing' as const, spacing: [0.7, 0.9] as [number, number], origin: [10, 20, 30] as [number, number, number], orientation: [1, 0, 0, 0, 1, 0] as [number, number, number, number, number, number], positionSource: 'instance' as const };
const journal: JournalEntry[] = [ { seq: 0, t: 0, kind: 'render', snapshot, renderSeq: 1 }, { seq: 1, t: 100, kind: 'annotation', snapshot, renderSeq: 1, payload: { annotationId: 'length-1', dimensions: [64, 64], imagePoints: [{ x: 10, y: 20 }, { x: 20, y: 20 }], geometry, event: { tool: 'Length', label: 'Synthetic length' } } } ];
test('T8: replay measurement retains original pixels, patient coordinates and spacing provenance', () => {
  const shape = replayShape(journal[1], journal)!;
  assert.equal(shape.lengthMm, 9); assert.equal(shape.geometry.calibration, 'PixelSpacing');
  shape.patientPoints.forEach((p, i) => assert.deepEqual(patientToPixel(p!, shape.geometry), shape.imagePoints[i]));
  const projected = projectReplayShapes([shape], snapshot, [64, 64], (x, y) => ({ x: 50 + x * 126, y: 70 + y * 126 }));
  assert.deepEqual(projected[0].canvasPoints, [{ x: 70, y: 110 }, { x: 90, y: 110 }]);
  assert.deepEqual(projectReplayShapes([shape], { ...snapshot, frame: 2 }, [64, 64], () => null), []);
  assert.throws(() => projectReplayShapes([shape], snapshot, [128, 64], () => null), /dimensions changed/);
});
test('T8: missing spacing stays uncalibrated, never assumed 1 mm; unconfirmed geometry fails closed', () => {
  const j = structuredClone(journal); j[1].payload!.geometry = uncalibratedGeometry();
  const shape = replayShape(j[1], j)!; assert.equal(shape.lengthMm, null); assert.deepEqual(shape.patientPoints, [null, null]);
  j[1].snapshot = { ...snapshot, frame: 2 }; assert.throws(() => replayShape(j[1], j), /confirmed image-pixel geometry/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewRenderIdentity } from './model';
import { journalTestView } from '../journal/fixtures';
import { uncalibratedGeometry } from '../anchors/geometry';
import type { Finding } from '../types';

const finding: Finding = {
  id: 'synthetic-review', order: 1, label: 'Synthetic contour', description: '', teachingPoints: [], state: ' ',
  studyInstanceUID: journalTestView.studyUID, seriesInstanceUID: journalTestView.seriesUID,
  sopInstanceUID: journalTestView.sopUID, frameNumber: journalTestView.frame,
  marker: { shape: 'circle', x_pct: .5, y_pct: .5 },
  resolvedAnchor: { anchorId: 'synthetic-anchor', anchorStatus: 'resolved', snapshot: journalTestView,
    imagePoint: { x: 20, y: 20 }, dimensions: [64, 64], patientPoint: null,
    calibration: 'uncalibrated', geometry: uncalibratedGeometry(), journalSeq: [1] },
};

test('review render identity survives text, PHI, version and render sequence bookkeeping changes', () => {
  const next = structuredClone(finding);
  Object.assign(next, { label: 'Edited text', description: 'Expert review', teachingPoints: ['Compare images'],
    currentVersion: 2, phiReview: { pixels: true, audio: true, screen: true } });
  next.resolvedAnchor!.snapshot!.renderSeq++;
  next.resolvedAnchor!.journalSeq = [20];
  assert.ok(reviewRenderIdentity(finding));
  assert.equal(reviewRenderIdentity(next), reviewRenderIdentity(finding));
});

test('review render identity invalidates changed image, frame, view and anchor geometry even on the same SOP', () => {
  const changes: Array<(next: Finding) => void> = [
    next => { next.studyInstanceUID = 'another-study'; },
    next => { next.seriesInstanceUID = 'another-series'; },
    next => { next.sopInstanceUID = 'another-instance'; },
    next => { next.frameNumber = 2; next.resolvedAnchor!.snapshot!.frame = 2; },
    next => { next.resolvedAnchor!.snapshot!.camera.pan[0]++; },
    next => { next.resolvedAnchor!.snapshot!.voi.ww++; },
    next => { next.resolvedAnchor!.imagePoint!.x++; },
    next => { next.resolvedAnchor!.dimensions = [128, 128]; },
    next => { next.resolvedAnchor!.geometry = { ...next.resolvedAnchor!.geometry, calibration: 'PixelSpacing', spacing: [1, 1] }; },
    next => { next.marker.x_pct = .2; },
    next => { next.resolvedAnchor!.anchorStatus = 'unresolved'; },
  ];
  for (const change of changes) {
    const next = structuredClone(finding); change(next);
    assert.notEqual(reviewRenderIdentity(next), reviewRenderIdentity(finding));
  }
});

test('missing or incomplete recorded image cannot retain review confirmation', () => {
  assert.equal(reviewRenderIdentity({ ...finding, resolvedAnchor: undefined }), null);
  assert.equal(reviewRenderIdentity({ ...finding, resolvedAnchor: { ...finding.resolvedAnchor!, snapshot: null } }), null);
});

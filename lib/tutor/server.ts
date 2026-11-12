import { getCaseForOrg } from '../cases';
import { loadApprovedToolContext } from '../harness/approvedToolContext';
import type { ApprovedToolContext } from '../harness/approvedTools';
import { reviewSnapshot } from '../review/model';
import { validSnapshot } from '../journal/viewer';
import { sameImage } from '../replay/geometry';
import { measuredLength } from '../anchors/geometry';
import type { Case } from '../types';
import type { ViewerSnapshot } from '../journal/types';
import { parseTutorCommand, TutorCommandError, type TutorStep } from './commands';
/** The only command authority is a fresh server approval/inventory, never a client snapshot. */
export function resolveTutorCommand(data: Case, context: ApprovedToolContext, raw: unknown, currentFindingId?: string, currentView?: ViewerSnapshot): TutorStep {
  const command = parseTutorCommand(raw), ordered = data.findings.filter(f => context.anchors.some(a => a.findingId === f.id)).sort((a, b) => a.order - b.order);
  let anchor = context.anchors.find(a => a.findingId === (currentFindingId ?? ordered[0]?.id));
  if (command.type === 'show_finding') anchor = context.anchors.find(a => a.findingId === command.findingId);
  if (command.type === 'show_anchor') anchor = context.anchors.find(a => a.id === command.anchorId);
  if (command.type === 'highlight') anchor = context.anchors.find(a => a.id === context.annotations.find(a => a.id === command.annotationId)?.anchorId);
  if (command.type === 'scroll_to') anchor = context.anchors.find(a => a.target.seriesUID === command.seriesUID && a.target.sopUID === command.sopUID && a.target.frame === command.frame);
  if (command.type === 'set_series') anchor = context.anchors.find(a => a.target.seriesUID === command.seriesUID);
  if (command.type === 'next_in_tour' || command.type === 'prev_in_tour') {
    const i = ordered.findIndex(f => f.id === currentFindingId), next = Math.max(0, Math.min(ordered.length - 1, i + (command.type === 'next_in_tour' ? 1 : -1)));
    anchor = context.anchors.find(a => a.findingId === ordered[next]?.id);
  }
  if (!anchor) throw new TutorCommandError();
  const frames = context.series.find(s => s.seriesUID === anchor!.target.seriesUID && s.studyUID === anchor!.target.studyUID);
  if (!frames || frames.frameCount !== frames.frames.length || frames.frames.filter(f => Object.keys(anchor!.target).every(k => f[k as keyof typeof f] === anchor!.target[k as keyof typeof f])).length !== 1) throw new TutorCommandError();
  const finding = data.findings.find(f => f.id === anchor!.findingId)!, base = reviewSnapshot(finding);
  if (!base) throw new TutorCommandError('The approved finding needs a complete recorded view. Rebind and re-approve it.');
  let snapshot = structuredClone(base);
  if (['hold', 'set_window', 'zoom', 'set_invert', 'clear_overlay'].includes(command.type) && currentView) {
    if (!validSnapshot(currentView) || !sameImage(base, currentView) || /mpr|volume/i.test(currentView.layout)) throw new TutorCommandError('The current image is outside the approved target.');
    // A renderer view can preserve camera/window, but never choose another image or supply annotation geometry.
    snapshot = structuredClone(currentView);
  }
  if (command.type === 'set_window') snapshot.voi = { ww: command.ww, wc: command.wc };
  if (command.type === 'zoom') snapshot.camera.zoom = command.zoom;
  if (command.type === 'set_invert') snapshot.invert = command.value;
  const result: TutorStep = { command, findingId: finding.id, anchorId: anchor.id, snapshot };
  if (['show_finding', 'show_anchor', 'next_in_tour', 'prev_in_tour', 'highlight'].includes(command.type)) {
    let evidence = finding.resolvedAnchor, tool = 'marker', label = finding.label;
    if (command.type === 'highlight') {
      const index = context.annotations.find(a => a.id === command.annotationId)?.id.split('/').at(-1);
      const annotation = finding.annotations?.[Number(index)] as { resolvedAnchor?: typeof evidence; tool?: string; label?: string } | undefined;
      evidence = annotation?.resolvedAnchor; tool = annotation?.tool ?? ''; label = annotation?.label ?? '';
    }
    if (!evidence?.snapshot || !sameImage(evidence.snapshot, base) || evidence.anchorStatus !== 'resolved' || !evidence.imagePoint || !evidence.dimensions) throw new TutorCommandError('Approved image-pixel geometry is incomplete. Rebind and re-approve it.');
    const points = evidence.imagePoints ?? [evidence.imagePoint];
    const counts: Record<string, number> = { marker: 1, Probe: 1, Length: 2, ArrowAnnotate: 2, EllipticalROI: 4, RectangleROI: 4, Angle: 3, Bidirectional: 4 };
    if (points.length !== counts[tool]) throw new TutorCommandError('Unsupported approved annotation.');
    result.shapes = [{ id: command.type === 'highlight' ? command.annotationId : anchor.id, kind: tool === 'marker' ? 'marker' : 'annotation', tool, label, snapshot: base, dimensions: evidence.dimensions, imagePoints: points, patientPoints: evidence.patientPoints ?? [evidence.patientPoint], geometry: evidence.geometry, lengthMm: tool === 'Length' ? measuredLength(points, evidence.geometry) : null }];
  }
  if (command.type === 'clear_overlay') result.shapes = [];
  return result;
}
export async function loadTutorCommand(orgId: string, caseId: string, raw: unknown, currentFindingId?: string, currentView?: ViewerSnapshot) {
  let data = await getCaseForOrg(orgId, caseId);
  if (!data || data.status !== 'published') throw new TutorCommandError('Published approved teaching evidence is unavailable.');
  const context = await loadApprovedToolContext(data, undefined, async () => { data = await getCaseForOrg(orgId, caseId); return data; });
  if (!data) throw new TutorCommandError();
  return resolveTutorCommand(data, context, raw, currentFindingId, currentView);
}

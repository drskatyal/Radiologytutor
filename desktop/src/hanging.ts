// Desktop adapter for the viewer core's hanging protocols: the scanned study
// model → `HpStudy`, so `chooseHangingProtocol` can pick the grid and cells.

import { chooseHangingProtocol, orientationOf, type HangingPlan, type HpStudy } from "@flowrad/viewer-core";
import type { ViewerStudy } from "./types";

export function toHpStudies(studies: readonly ViewerStudy[]): HpStudy[] {
  return studies.map((study) => ({
    uid: study.uid,
    date: study.date,
    patientId: study.patient.id,
    series: study.series.map((series) => {
      const first = series.headers[0];
      const zs = series.headers.map((h) => h.imagePositionPatient?.[2]).filter((z): z is number => Number.isFinite(z));
      return {
        uid: series.uid,
        modality: series.modality,
        description: series.description,
        imageCount: series.imageCount,
        number: series.number,
        orientation: orientationOf(first?.imageOrientationPatient),
        sliceThickness: first?.sliceThickness,
        zRange: zs.length ? ([Math.min(...zs), Math.max(...zs)] as [number, number]) : undefined,
      };
    }),
  }));
}

export function hangingPlanFor(studies: readonly ViewerStudy[]): HangingPlan | null {
  return chooseHangingProtocol(toHpStudies(studies));
}

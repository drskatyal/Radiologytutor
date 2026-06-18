// Build Cornerstone `wadors:` imageIds for a series and register per-instance
// metadata with the DICOM image loader (required before pixels can be decoded).
// Mirrors the official cornerstonejs/nextjs-cornerstone3d template helper.
//
// Client-only: imports the dicom-image-loader, which touches browser APIs.

import { api } from "dicomweb-client";
import cornerstoneDICOMImageLoader from "@cornerstonejs/dicom-image-loader";

const SOP_INSTANCE_UID = "00080018";
const SERIES_INSTANCE_UID = "0020000E";

export interface SeriesRef {
  StudyInstanceUID: string;
  SeriesInstanceUID: string;
  /** WADO-RS root, e.g. https://host/dicomweb */
  wadoRsRoot: string;
}

export default async function createImageIdsAndCacheMetaData({
  StudyInstanceUID,
  SeriesInstanceUID,
  wadoRsRoot,
}: SeriesRef): Promise<string[]> {
  const client = new api.DICOMwebClient({ url: wadoRsRoot, singlepart: true });
  const instances = await client.retrieveSeriesMetadata({
    studyInstanceUID: StudyInstanceUID,
    seriesInstanceUID: SeriesInstanceUID,
  });

  return (instances as unknown as Record<string, { Value: string[] }>[]).map((inst) => {
    const seriesUID = inst[SERIES_INSTANCE_UID].Value[0];
    const sopUID = inst[SOP_INSTANCE_UID].Value[0];
    const imageId =
      `wadors:${wadoRsRoot}/studies/${StudyInstanceUID}` +
      `/series/${seriesUID}/instances/${sopUID}/frames/1`;
    cornerstoneDICOMImageLoader.wadors.metaDataManager.add(imageId, inst);
    return imageId;
  });
}

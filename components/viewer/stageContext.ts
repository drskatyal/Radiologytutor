"use client";

import { createContext } from "react";

/**
 * The imaging stage (ImagingLayout) shares its fullscreen state with the
 * viewer toolbar inside it. A toolbar that `claim`s the control renders the
 * fullscreen button in its own row, and the stage drops the floating button
 * it would otherwise paint over the top-right corner of the image — exactly
 * where the DICOM overlay prints the image number.
 */
export interface ImagingStage {
  expanded: boolean;
  toggle: () => void;
  /** Returns the release function. */
  claim: () => () => void;
}

export const ImagingStageContext = createContext<ImagingStage | null>(null);

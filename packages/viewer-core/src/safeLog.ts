// Error text that is safe to print.
//
// A Cornerstone loader rejection can carry the parsed DICOM dataset
// (`{ error, dataSet }`), and the dataset holds the patient's name, ID, birth
// date and every UID. Printing that object puts patient data in the console —
// and in any tool that collects console output. Every viewer log of an
// unknown error goes through `safeErrorText`: the error's name and message
// only, DICOM UIDs masked, never the object.

/** A DICOM UID: dotted numeric, at least five components. */
const UID_PATTERN = /\b\d+(?:\.\d+){4,}\b/g;

export function redactIdentifiers(text: string): string {
  return text.replace(UID_PATTERN, "[uid]");
}

export function safeErrorText(error: unknown): string {
  const inner =
    error && typeof error === "object" && "error" in error
      ? (error as { error: unknown }).error
      : error;
  let text: string;
  if (inner instanceof Error) text = `${inner.name}: ${inner.message}`;
  else if (typeof inner === "string") text = inner;
  else if (inner && typeof inner === "object" && "message" in inner) {
    text = String((inner as { message: unknown }).message);
  } else text = "unknown error";
  return redactIdentifiers(text).slice(0, 300);
}

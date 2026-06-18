// Small inline SVG icon set for the Author surface. Stroke-based, 20x20 view,
// inherit `currentColor` so they tint with the surrounding text/button color.
// Kept here (not in components/ui) because they're author-specific glyphs.

export function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 13.5V16h2.5L15 7.5 12.5 5 4 13.5z" strokeLinejoin="round" />
      <path d="M11.5 6l2.5 2.5" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path
        d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6m2 0v9a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 016 15V6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M5 12l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  );
}

export function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3z" strokeLinejoin="round" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M11 5l-5 5 5 5M6 10h9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" stroke="none">
      <circle cx="7" cy="5" r="1.3" />
      <circle cx="13" cy="5" r="1.3" />
      <circle cx="7" cy="10" r="1.3" />
      <circle cx="13" cy="10" r="1.3" />
      <circle cx="7" cy="15" r="1.3" />
      <circle cx="13" cy="15" r="1.3" />
    </svg>
  );
}

export function LayersIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M10 3l7 3.5-7 3.5-7-3.5L10 3z" strokeLinejoin="round" />
      <path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function TargetIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2" />
      <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" strokeLinecap="round" />
    </svg>
  );
}

export function DocIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 3h6l4 4v10a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M11 3v4h4M7 11h6M7 14h4" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" stroke="none">
      <path d="M6 4.5v11a1 1 0 001.5.87l9-5.5a1 1 0 000-1.74l-9-5.5A1 1 0 006 4.5z" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
      <path d="M4.5 9a5.5 5.5 0 0011 0M10 14.5V17" strokeLinecap="round" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5h.01" strokeLinecap="round" />
    </svg>
  );
}

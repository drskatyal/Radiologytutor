"use client";

// Optional anatomical level for the learner hint. The tour says this only
// when the student is off the money slice, and it withholds the finding label.

import { Field, Input } from "@/components/ui";
import { LIMITS } from "./lib";

export function LandmarkField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <Field
      label="Level to name first"
      error={error}
      hint={
        error
          ? undefined
          : "Optional. A landmark such as carina — not the diagnosis. Said only if the learner is off the slice."
      }
    >
      {(p) => (
        <Input
          {...p}
          placeholder="e.g. carina"
          value={value}
          maxLength={LIMITS.landmark}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

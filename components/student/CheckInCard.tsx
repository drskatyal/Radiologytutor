"use client";

// Text choices for a Teach-tour check-in. The viewer is already on the
// authored anchor; these buttons do not move it.

import { Button } from "@/components/ui";

export function CheckInCard({
  prompt,
  options,
  disabled,
  onSelect,
}: {
  prompt: string;
  options: readonly string[];
  disabled?: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      className="animate-fade-up rounded-lg border border-subtle bg-elevated p-3"
      role="group"
      aria-label={`Check-in: ${prompt}`}
    >
      <p className="text-sm font-medium text-primary">{prompt}</p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {options.map((option, index) => (
          <Button
            key={`${index}:${option}`}
            variant="secondary"
            size="sm"
            wrap
            disabled={disabled}
            className="h-auto w-full justify-start px-3 py-2"
            onClick={() => onSelect(index)}
          >
            {option}
          </Button>
        ))}
      </div>
    </div>
  );
}

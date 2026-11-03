// The voice command list, shown in the keyboard sheet (?) and Settings.
// Rows come from the recognizer's own table (voiceUi.ts), so the list is
// exactly what voice understands.

import { Mic } from "lucide-react";
import { voiceCommandRows, voiceTriggerText, VOICE_GROUP_ORDER } from "../voiceUi";

/** How to switch voice on (mic / key, toggle) in one line. */
export function VoiceTrigger({ keys }: { keys?: string }) {
  return (
    <p className="flex items-start gap-2 text-xs text-secondary" data-testid="voice-trigger">
      <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span>
        {voiceTriggerText(keys)} Works offline: no audio leaves this computer.
      </span>
    </p>
  );
}

/** Every voice command with what to say, grouped. */
export function VoiceCommandList({ columns = 2 }: { columns?: 1 | 2 }) {
  const rows = voiceCommandRows();
  return (
    <div className={columns === 2 ? "grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2" : "flex flex-col gap-5"} data-testid="voice-command-list">
      {VOICE_GROUP_ORDER.map((group) => {
        const inGroup = rows.filter((r) => r.group === group);
        if (!inGroup.length) return null;
        return (
          <section key={group}>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</h4>
            <dl className="flex flex-col gap-1.5">
              {inGroup.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-4 text-sm" data-voice-command={r.label}>
                  <dt className="text-secondary">{r.label}</dt>
                  <dd className="min-w-0 text-right text-xs text-primary">
                    “{r.phrases[0]}”
                    {r.phrases.length > 1 && <span className="text-muted"> · {r.phrases.slice(1).map((p) => `“${p}”`).join(" · ")}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

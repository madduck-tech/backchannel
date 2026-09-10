'use client';

import { cn } from '@/lib/utils';

/** Above this the decode is trustworthy and the UI says nothing about it. */
const QUIET_THRESHOLD = 0.8;

/**
 * Whether there is a score to show at all.
 *
 * The payload is JSON, so `number | undefined` is not what actually arrives. `serde_json` cannot
 * write a non-finite float and sends `null` instead, and `null !== undefined` is **true** — so a
 * guard written that way lets `null` through, and `Math.round(null * 100)` is `0`. Measured
 * 2026-09-10 (#162): every line of every recording made with a family that reports no token
 * probabilities carried a red `0%` badge reading *Low confidence*.
 *
 * A genuine `0` is a score and must still warn. "Nothing scored it" and "it scored zero" are
 * different facts and only one of them is silence, so this asks whether the value is a finite
 * number, never whether it is truthy.
 */
export function isScored(confidence: number | null | undefined): confidence is number {
  return typeof confidence === 'number' && Number.isFinite(confidence);
}

function describe(conf: number) {
  if (conf >= QUIET_THRESHOLD) return { label: 'High confidence', tone: 'brand' } as const;
  if (conf >= 0.7) return { label: 'Good confidence', tone: 'brand' } as const;
  if (conf >= 0.4) return { label: 'Uncertain', tone: 'warn' } as const;
  return { label: 'Low confidence', tone: 'danger' } as const;
}

/**
 * Decode confidence, shown only when it is worth acting on. A confident
 * transcript carries no marker at all — decorating every line with a green dot
 * is noise, and noise is what makes the real warnings invisible.
 *
 * `always` forces the readout (used in tooltips, where the user asked).
 */
export const ConfidenceIndicator: React.FC<{
  confidence: number | null | undefined;
  showIndicator?: boolean;
  always?: boolean;
}> = ({ confidence, showIndicator = true, always = false }) => {
  if (!showIndicator) return null;
  // Defence in depth: the callers ask `isScored` before rendering this at all, and this refuses
  // again rather than trusting them — one of them is inside a tooltip, where the mistake is invisible
  // until someone hovers.
  if (!isScored(confidence)) return null;
  if (!always && confidence >= QUIET_THRESHOLD) return null;

  const { label, tone } = describe(confidence);
  const percent = Math.round(confidence * 100);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1 py-px align-middle',
        tone === 'danger' && 'bg-danger-soft text-danger-ink',
        tone === 'warn' && 'bg-warn-soft text-warn-ink',
        tone === 'brand' && 'bg-brand-soft text-brand-soft-ink'
      )}
      title={`${label} — ${percent}%`}
      aria-label={`Transcription confidence ${percent} percent, ${label}`}
    >
      <span className="readout text-2xs font-medium">{percent}%</span>
    </span>
  );
};

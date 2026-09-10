import React from 'react';
import { cn } from '@/lib/utils';
import type { OnboardingContainerProps } from '@/types/onboarding';

/**
 * The shell every first-run screen sits in, and it is the approved one. (#154)
 *
 * `design/prototypes/onboarding-summariser.html` (`c-inline-scroll`, approved 2026-09-08) is a
 * fixed-height grid: a step strip, a head that does not move, a region that scrolls, and a footer
 * that stays. Read out of it rather than remembered:
 *
 *     body   { height: 100vh; display: grid; grid-template-rows: auto minmax(0,1fr) auto }
 *     main   { min-height: 0;  display: grid; grid-template-rows: auto minmax(0,1fr) }
 *     .scroll{ overflow-y: auto; min-height: 0; scrollbar-gutter: stable }
 *     footer { min-height: 56px }
 *     .col   { max-width: 1000px; margin: 0 auto }
 *
 * **What it replaced, and why that mattered.** The old container was a centred `max-w-2xl` column
 * whose children scrolled as one long page, with no footer at all: each step rendered its own
 * Continue inside the scrolling content. So on a 520px-tall window — the minimum
 * `tauri.conf.json` permits — the summariser's key field and its Continue were both below the fold,
 * and the product owner reported choosing a provider and nothing happening. #138 fixed that by
 * scrolling the chosen option into view, which is a repair to a layout that was never the approved
 * one.
 *
 * `footer` is optional so the two steps that have not been redesigned keep working unchanged.
 */
export function OnboardingContainer({
  title,
  description,
  children,
  step,
  totalSteps = 4,
  hideProgress = false,
  className,
  footer,
  scrollRef,
}: OnboardingContainerProps) {
  /** The strip's names, from the prototype's `<nav class="strip">`. */
  const STEPS = ['Transcription', 'Summariser', 'Download', 'Audio check'];
  const names = STEPS.slice(0, totalSteps);

  return (
    <div className="fixed inset-0 z-modal grid h-full grid-rows-[auto_minmax(0,1fr)_auto] bg-canvas text-ink">
      {step && !hideProgress ? (
        <nav
          aria-label="Setup steps"
          className="flex h-11 items-center gap-7 border-b border-line bg-panel px-6 text-xs"
        >
          {names.map((name, i) => {
            const n = i + 1;
            const state = n < step ? 'done' : n === step ? 'current' : 'todo';
            return (
              <span
                key={name}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  '-mb-px flex items-center gap-2 self-stretch border-b-2 border-transparent',
                  state === 'todo' ? 'text-ink-faint' : 'text-ink',
                  state === 'current' && 'border-brand-soft-ink'
                )}
              >
                <b className="font-mono font-normal">{n}</b>
                {name}
              </span>
            );
          })}
        </nav>
      ) : (
        <div />
      )}

      <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <div className="px-6 pt-7">
          <div className="mx-auto w-full max-w-[1000px]">
            <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight text-ink">
              {title}
            </h1>
            {description && (
              <p className="mt-2 max-w-[68ch] text-sm text-ink-muted">{description}</p>
            )}
          </div>
        </div>

        {/* `min-h-0` is what makes this scroll instead of growing the grid row; without it the
            footer leaves the window on a short one, which is the defect this shell exists to end. */}
        <div ref={scrollRef} className="min-h-0 overflow-y-auto px-6 pb-6 [scrollbar-gutter:stable]">
          <div className={cn('mx-auto w-full max-w-[1000px]', className)}>{children}</div>
        </div>
      </main>

      {footer ? (
        <footer className="flex min-h-[56px] items-center gap-3 border-t border-line bg-panel px-6 py-2.5">
          <div className="mx-auto flex w-full max-w-[1000px] items-center gap-3">{footer}</div>
        </footer>
      ) : (
        <div />
      )}
    </div>
  );
}

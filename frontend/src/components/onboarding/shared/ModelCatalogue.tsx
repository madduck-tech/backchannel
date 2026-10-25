'use client';

/**
 * First run's catalogue: every transcription model, one row each, and a row is the choice. (#166)
 *
 * **Not the Settings card.** First run used to mount `TranscriptionModelManager` with
 * `canDownload={false}`. That card offers `Use` only for a file already on disk and `Download` only
 * where downloads are allowed, so on a clean profile all 86 rows rendered no control at all, and the
 * 82 models outside the recommended four could not be chosen anywhere in first run (#139 made that
 * regression on 2026-09-09).
 *
 * The rows follow the approved prototype, `design/prototypes/onboarding-catalogue.html` (`a4`), in
 * content and in interaction:
 * - each row shows a dot, the model id, its size, how text arrives and its languages;
 * - a row is a `radio`, chosen by click, Enter or Space;
 * - choosing fetches nothing, because the download screen fetches the choice;
 * - the search matches the id, the family and the languages, and only those, since nothing else is
 *   on the row.
 *
 * Quality, WER, speed and the description stay in Settings, where the card still shows them.
 */

import { useEffect, useState } from 'react';
import { ModelInfo, TranscribeAPI, corruptedSizeMb } from '@/lib/transcribe';
import { languageName } from '@/lib/languages';
import { cn } from '@/lib/utils';

interface Props {
  selectedModel?: string;
  onModelSelect: (modelName: string) => void;
}

const base = (code: string) => code.split('-')[0].toLowerCase();

// English names as well as the reader's own. The rows show `languageName`, which follows the
// locale as Settings does; the search also accepts the English name, so "Russian" finds Russian
// on a Russian desktop, where the row reads "русский" (#166's gate).
let english: Intl.DisplayNames | null = null;
function englishName(code: string): string {
  try {
    english ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
    return english.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Whether a query names this language. A query of one or two letters is a code and matches only a
 * code. A longer one matches the start of a word of the language's name, in English or in the
 * reader's language. The prototype matched any substring of the name, so "ta" found Italian and "es"
 * found Estonian, and a row reading "28 languages" answered for a language it does not show
 * (#166's gate). The intent, a language or a model name, is the prototype's.
 */
function namesLanguage(code: string, q: string): boolean {
  const b = base(code);
  if (b === q) return true;
  if (q.length < 3) return false;
  return [languageName(b), englishName(b)].some((name) =>
    name.toLowerCase().split(/[^\p{L}]+/u).some((word) => word.startsWith(q))
  );
}

/** The language a query names, as a base code, or `null` when it names none. */
function queryLanguage(models: ModelInfo[], q: string): string | null {
  if (!q) return null;
  for (const m of models) {
    for (const code of m.languages) {
      if (namesLanguage(code, q)) return base(code);
    }
  }
  return null;
}

/** Names when there are four or fewer, otherwise a count, as the prototype writes it (`:302-305`). */
function languageWords(model: ModelInfo, asked: string | null): string {
  const codes = [...new Set(model.languages.map(base))];
  if (codes.length === 0) return 'Unknown';
  if (codes.length <= 4) return codes.map(languageName).join(', ');
  return asked && codes.includes(asked)
    ? `${codes.length} languages, incl. ${languageName(asked)}`
    : `${codes.length} languages`;
}

function matches(model: ModelInfo, q: string): boolean {
  return (
    !q ||
    model.name.toLowerCase().includes(q) ||
    model.family.toLowerCase().includes(q) ||
    model.languages.some((code) => namesLanguage(code, q))
  );
}

/** Family, then size, then id: the prototype's order (`:298`). */
const byFamily = (a: ModelInfo, b: ModelInfo) =>
  a.family.localeCompare(b.family) || a.size_mb - b.size_mb || a.name.localeCompare(b.name);

// Five columns, and at 899 px or less the prototype's two lines (`:206-211`): how text arrives and
// the languages move under the id. `max-[900px]` is `width < 900px`, which is the prototype's
// `max-width: 899px` including fractional widths.
const GRID = cn(
  'grid grid-cols-[16px_minmax(0,1.4fr)_84px_112px_minmax(0,1.6fr)] items-center gap-x-3.5 pl-3 pr-2',
  'max-[900px]:grid-cols-[16px_minmax(0,1fr)_84px] max-[900px]:grid-rows-[auto_auto] max-[900px]:gap-y-0.5'
);

export function ModelCatalogue({ selectedModel, onModelSelect }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    TranscribeAPI.getAvailableModels()
      .then((list) => { if (live) setModels(list); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // A skeleton, as `DESIGN.md` asks of a content area, in the rows' own grid.
  if (loading) {
    return (
      <div aria-busy="true" aria-label="Loading models" className="grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(GRID, 'min-h-10 border-b border-line py-[7px]')}>
            <span className="h-4 w-4 rounded-full bg-sunken" />
            <span className="h-3 w-40 rounded-sm bg-sunken" />
            <span className="h-3 w-12 rounded-sm bg-sunken" />
            <span className="h-3 w-16 rounded-sm bg-sunken" />
            <span className="h-3 w-24 rounded-sm bg-sunken" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="rounded-md bg-danger-soft p-3 text-sm text-danger-ink">Could not read the model catalogue: {error}</div>;
  }
  if (models.length === 0) {
    return <p className="py-6 text-sm text-ink-muted">The catalogue is empty, so there is no model to choose here.</p>;
  }

  const q = query.trim().toLowerCase();
  const asked = queryLanguage(models, q);
  const shown = models.filter((m) => matches(m, q)).sort(byFamily);

  const row = (model: ModelInfo) => {
    const on = model.name === selectedModel;
    const truncatedMb = corruptedSizeMb(model.status);
    return (
      <div
        key={model.name}
        role="radio"
        aria-checked={on}
        tabIndex={0}
        data-model={model.name}
        onClick={() => onModelSelect(model.name)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onModelSelect(model.name);
          }
        }}
        className={cn(
          'min-h-10 cursor-pointer border-b border-line py-[7px] transition-colors duration-fast hover:bg-sunken',
          // The prototype's inset bar (`.row.on`), which moves no column, where a left border would.
          on && 'shadow-[inset_2px_0_0_oklch(var(--brand-soft-ink))]'
        )}
      >
        <div className={GRID}>
          <span
            aria-hidden
            className={cn(
              'h-4 w-4 rounded-full border',
              on
                ? 'border-brand-soft-ink bg-[radial-gradient(circle,oklch(var(--brand-soft-ink))_0_4px,transparent_4.5px)]'
                : 'border-line-strong bg-canvas'
            )}
          />
          <span className="readout text-sm text-ink [overflow-wrap:anywhere]">{model.name}</span>
          <span className="readout whitespace-nowrap text-xs text-ink-muted">{model.size_mb} MB</span>
          <span className="readout whitespace-nowrap text-xs text-ink-muted max-[900px]:col-start-3 max-[900px]:row-start-2">
            {model.streaming ? 'word by word' : 'in chunks'}
          </span>
          <span className="text-sm text-ink max-[900px]:col-start-2 max-[900px]:row-start-2">
            {languageWords(model, asked)}
          </span>
        </div>
        {truncatedMb !== null && (
          <p className="ml-[30px] mt-1 pr-2 text-xs text-warn-ink">
            Incomplete download: {truncatedMb} MB of {model.size_mb} MB is on this device. If it is the
            choice, the whole file is fetched again.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* The prototype's well (`.well`, `:182-186`), focused on opening as its `autofocus` is. */}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Language or model name"
        aria-label="Search models"
        autoFocus
        className={cn(
          'h-11 w-full rounded-md border border-line-strong bg-sunken px-3.5 text-base text-ink',
          'placeholder:text-ink-muted transition-colors duration-fast',
          'hover:border-ink focus:border-brand-soft-ink'
        )}
      />
      <div role="radiogroup" aria-label="Models" className="grid">
        {shown.length === 0 ? (
          <p className="py-6 text-sm text-ink-muted">
            Nothing matches. Try a language, such as Russian or ru, or part of a model name.
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                GRID,
                'readout sticky top-0 z-10 h-7 border-b border-line-strong bg-canvas text-2xs text-ink-muted max-[900px]:hidden'
              )}
            >
              <span />
              <span>Model</span>
              <span>Download</span>
              <span>Text arrives</span>
              <span>Languages</span>
            </div>
            {shown.map(row)}
          </>
        )}
      </div>
    </div>
  );
}

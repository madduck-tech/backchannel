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

/** The language a query names, as a base code, or `null` when it names none. */
function queryLanguage(models: ModelInfo[], q: string): string | null {
  if (!q) return null;
  for (const m of models) {
    for (const code of m.languages) {
      const b = base(code);
      if (b === q || languageName(b).toLowerCase() === q) return b;
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
    model.languages.some((code) => base(code) === q || languageName(base(code)).toLowerCase().includes(q))
  );
}

/** Family, then size, then id: the prototype's order (`:298`). */
const byFamily = (a: ModelInfo, b: ModelInfo) =>
  a.family.localeCompare(b.family) || a.size_mb - b.size_mb || a.name.localeCompare(b.name);

// Five columns, and under 900 px the prototype's two lines (`:206-211`): how text arrives and the
// languages move under the id.
const GRID = cn(
  'grid grid-cols-[16px_minmax(0,1.4fr)_84px_112px_minmax(0,1.6fr)] items-center gap-x-3.5 pl-3 pr-2',
  'max-[899px]:grid-cols-[16px_minmax(0,1fr)_84px] max-[899px]:grid-rows-[auto_auto] max-[899px]:gap-y-0.5'
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

  if (loading) {
    return <div className="text-sm text-ink-muted">Loading models…</div>;
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
          'min-h-10 cursor-pointer border-b border-l-2 border-b-line py-[7px] transition-colors duration-fast hover:bg-sunken',
          on ? 'border-l-brand' : 'border-l-transparent'
        )}
      >
        <div className={GRID}>
          <span
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 rounded-full border',
              on ? 'border-brand bg-brand' : 'border-line-strong'
            )}
          />
          <span className="readout text-sm text-ink [overflow-wrap:anywhere]">{model.name}</span>
          <span className="readout whitespace-nowrap text-xs text-ink-muted">{model.size_mb} MB</span>
          <span className="readout whitespace-nowrap text-xs text-ink-muted max-[899px]:col-start-3 max-[899px]:row-start-2">
            {model.streaming ? 'word by word' : 'in chunks'}
          </span>
          <span className="text-sm text-ink max-[899px]:col-start-2 max-[899px]:row-start-2">
            {languageWords(model, asked)}
          </span>
        </div>
        {truncatedMb !== null && (
          <p className="ml-[30px] mt-1 pr-2 text-xs text-warn-ink">
            Incomplete download: {truncatedMb} MB of {model.size_mb} MB is on this device. Choosing this
            model fetches the whole file again.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <div className="rounded-md bg-danger-soft p-3 text-sm text-danger-ink">{error}</div>}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Language or model name"
        aria-label="Search models"
        className={cn(
          'h-9 w-full rounded-md border border-line bg-sunken px-3 text-sm text-ink',
          'placeholder:text-ink-muted transition-colors duration-fast',
          'hover:border-line-strong focus:border-brand focus:bg-elevated'
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
                'readout sticky top-0 z-10 h-7 border-b border-line-strong bg-canvas text-2xs text-ink-muted max-[899px]:hidden'
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

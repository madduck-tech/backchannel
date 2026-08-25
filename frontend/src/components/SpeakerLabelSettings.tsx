import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Switch } from './ui/switch';
import { useConfig } from '@/contexts/ConfigContext';

/**
 * The speaker-labelling toggle.
 *
 * Enabling it downloads the model, which is why the size is on screen before
 * the switch is touched rather than announced afterwards. If the download
 * fails the switch goes back off — a setting that claims to be on while the
 * weights are missing would just fail silently after every meeting.
 */
export function SpeakerLabelSettings() {
  const { isAutoLabelSpeakers, toggleIsAutoLabelSpeakers } = useConfig();
  const [sizeMb, setSizeMb] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [size, present] = await Promise.all([
          invoke<number>('diarizer_size_mb'),
          invoke<boolean>('is_diarizer_downloaded_command'),
        ]);
        if (cancelled) return;
        setSizeMb(size);
        setDownloaded(present);
      } catch (error) {
        console.error('Failed to read speaker model status:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        toggleIsAutoLabelSpeakers(false);
        return;
      }

      if (downloaded) {
        toggleIsAutoLabelSpeakers(true);
        return;
      }

      setDownloading(true);
      try {
        await invoke('download_diarizer_command');
        setDownloaded(true);
        toggleIsAutoLabelSpeakers(true);
        toast.success('Speaker model downloaded.');
      } catch (error) {
        toggleIsAutoLabelSpeakers(false);
        toast.error(`Could not download the speaker model: ${String(error)}`);
      } finally {
        setDownloading(false);
      }
    },
    [downloaded, toggleIsAutoLabelSpeakers]
  );

  return (
    <div className="bg-elevated rounded-lg border border-line p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-ink mb-2">Label speakers</h3>
          <p className="text-sm text-ink-muted">
            After a recording, work out who spoke and label the transcript. Up to four speakers,
            numbered — rename them on the meeting itself. You can also run this by hand on any
            meeting from the Speakers button.
          </p>
          {sizeMb !== null && downloaded === false && (
            <p className="text-sm text-ink-muted mt-2">
              {downloading
                ? `Downloading the speaker model (${sizeMb} MB)…`
                : `Turning this on downloads a ${sizeMb} MB speaker model.`}
            </p>
          )}
        </div>
        <Switch
          checked={isAutoLabelSpeakers}
          onCheckedChange={handleToggle}
          disabled={downloading || downloaded === null}
        />
      </div>
    </div>
  );
}

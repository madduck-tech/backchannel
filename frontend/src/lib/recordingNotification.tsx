import { toast } from 'sonner';

/**
 * The notice that a recording has started, and that the people in the room should be told.
 *
 * **Why `toast.custom` and not `toast.info`.** It used to pass a title string and put the whole card
 * into `description`. Sonner then drew its own chrome around that card -- a leading `info` icon and a
 * close button, both positioned against the toast, not against the content -- so on screen the icon
 * and the X floated outside the card's left and top edges. The 🔴 in the title was a second icon
 * beside sonner's own, and a `min-w-[280px]` inside kept the text in a narrow column while the toast
 * itself was much wider.
 *
 * A custom toast owns its whole box, so there is one card, one width, and no chrome that belongs to
 * something else.
 */
export async function showRecordingNotification(): Promise<void> {
  try {
    const { Store } = await import('@tauri-apps/plugin-store');
    const store = await Store.load('preferences.json');
    const showNotification = (await store.get<boolean>('show_recording_notification')) ?? true;
    if (!showNotification) return;

    let dontShowAgain = false;

    const toastId = toast.custom(
      (id) => (
        <div className="flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-lg border border-line bg-elevated p-4 shadow-float">
          <span className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-danger" />
            <span className="text-md font-medium text-ink">Recording started</span>
          </span>

          <p className="text-base leading-relaxed text-ink-muted">
            Tell everyone in the meeting that it is being recorded.
          </p>

          <label className="flex cursor-pointer items-center gap-2 text-base text-ink-muted">
            <input
              type="checkbox"
              onChange={(e) => {
                dontShowAgain = e.target.checked;
              }}
              className="rounded border-line"
            />
            <span className="select-none">Do not show this again</span>
          </label>

          <button
            type="button"
            onClick={async () => {
              if (dontShowAgain) {
                const { Store: S } = await import('@tauri-apps/plugin-store');
                const s = await S.load('preferences.json');
                await s.set('show_recording_notification', false);
                await s.save();
              }
              toast.dismiss(id);
            }}
            className="h-9 w-full rounded-md bg-ink text-base font-medium text-canvas transition-colors duration-fast hover:bg-ink/90"
          >
            I have told them
          </button>
        </div>
      ),
      { duration: 10000, position: 'bottom-right' }
    );

    void toastId;
  } catch (notificationError) {
    console.error('Failed to show recording notification:', notificationError);
    // Never fail a recording because a notice could not be drawn.
  }
}

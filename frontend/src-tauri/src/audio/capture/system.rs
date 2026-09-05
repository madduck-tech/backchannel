use std::pin::Pin;
use std::task::{Context, Poll};
use futures_util::{Stream, StreamExt};
use anyhow::Result;
use cpal::traits::HostTrait;
use crate::audio::devices::device_name;


#[cfg(target_os = "macos")]
use futures_channel::mpsc;
#[cfg(target_os = "macos")]
use super::core_audio::CoreAudioCapture;
#[cfg(target_os = "macos")]
use log::info;

/// Keep the devices whose name could be read, and count the ones that could not.
///
/// Split out of [`SystemAudioCapture::list_system_devices`] so it can be tested without a
/// sound card. That is not a stylistic preference: the only test this path had asserted
/// `device_list.len() >= 0`, which is `>= 0` on a `usize` and therefore true for every
/// possible input, and it ran on a CI runner with no audio devices at all — so no
/// assertion about a *real* enumeration could go red there either. With the mapping
/// separated from the hardware, the empty case and the unreadable case become ordinary
/// unit tests, and the part that genuinely needs a machine is `#[ignore]`d and run by the
/// gate.
fn readable_names<I, E>(names: I) -> (Vec<String>, usize)
where
    I: IntoIterator<Item = std::result::Result<String, E>>,
{
    let mut readable = Vec::new();
    let mut unreadable = 0usize;
    for name in names {
        match name {
            Ok(name) => readable.push(name),
            Err(_) => unreadable += 1,
        }
    }
    (readable, unreadable)
}

/// System audio capture using Core Audio tap (macOS) or CPAL (other platforms)
pub struct SystemAudioCapture {
    _host: cpal::Host,
}

impl SystemAudioCapture {
    pub fn new() -> Result<Self> {
        let host = crate::audio::devices::host::audio_host();
        Ok(Self { _host: host })
    }

    pub fn list_system_devices() -> Result<Vec<String>> {
        let host = crate::audio::devices::host::audio_host();
        let devices = host.output_devices()
            .map_err(|e| anyhow::anyhow!("Failed to enumerate output devices: {}", e))?;

        let (device_names, unreadable) = readable_names(devices.map(|d| device_name(&d)));
        if unreadable > 0 {
            // Said out loud. A device whose name cannot be read is simply absent from the
            // picker, and a user looking for it has no way to tell that from "the machine
            // does not have it" -- which is the shape of #10.
            log::warn!(
                "{unreadable} output device(s) were skipped because their name could not be read"
            );
        }

        Ok(device_names)
    }

    pub fn start_system_audio_capture(&self) -> Result<SystemAudioStream> {
        #[cfg(target_os = "macos")]
        {
            info!("Starting Core Audio system capture (macOS)");
            // Use Core Audio tap for system audio capture
            let core_audio = CoreAudioCapture::new()?;
            let core_audio_stream = core_audio.stream()?;
            let sample_rate = core_audio_stream.sample_rate();

            // Convert CoreAudioStream to SystemAudioStream
            let (tx, rx) = mpsc::unbounded::<Vec<f32>>();
            let (drop_tx, drop_rx) = std::sync::mpsc::channel::<()>();

            // Spawn task to forward Core Audio samples
            tokio::spawn(async move {
                use futures_util::StreamExt;
                let mut stream = core_audio_stream;

                // The Core Audio stream already yields batches, so forward them
                // as they come rather than reassembling them sample by sample.
                while let Some(batch) = stream.next().await {
                    if drop_rx.try_recv().is_ok() || tx.unbounded_send(batch).is_err() {
                        break;
                    }
                }
            });

            let receiver = rx.map(futures_util::stream::iter).flatten();

            info!("Core Audio system capture started successfully");

            Ok(SystemAudioStream {
                drop_tx,
                sample_rate,
                receiver: Box::pin(receiver),
            })
        }

        #[cfg(not(target_os = "macos"))]
        {
            // For non-macOS platforms, you would implement WASAPI/ALSA loopback here
            anyhow::bail!("System audio capture not yet implemented for this platform")
        }
    }

    pub fn check_system_audio_permissions() -> bool {
        // Check if we can enumerate audio devices
        match crate::audio::devices::host::audio_host().output_devices() {
            Ok(_) => true,
            Err(_) => false,
        }
    }
}

pub struct SystemAudioStream {
    drop_tx: std::sync::mpsc::Sender<()>,
    sample_rate: u32,
    receiver: Pin<Box<dyn Stream<Item = f32> + Send + Sync>>,
}

impl Drop for SystemAudioStream {
    fn drop(&mut self) {
        let _ = self.drop_tx.send(());
    }
}

impl Stream for SystemAudioStream {
    type Item = f32;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.as_mut().poll_next_unpin(cx)
    }
}

impl SystemAudioStream {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Public interface for system audio capture
pub async fn start_system_audio_capture() -> Result<SystemAudioStream> {
    let capture = SystemAudioCapture::new()?;
    capture.start_system_audio_capture()
}

pub fn list_system_audio_devices() -> Result<Vec<String>> {
    SystemAudioCapture::list_system_devices()
}

pub fn check_system_audio_permissions() -> bool {
    SystemAudioCapture::check_system_audio_permissions()
}
#[cfg(test)]
mod tests {
    use super::readable_names;

    #[test]
    fn an_empty_enumeration_produces_an_empty_list_and_no_skips() {
        // The case the old assertion pretended to cover. `assert!(len() >= 0)` is true for
        // every list including this one, so it could not tell an empty enumeration from a
        // full one -- and on a CI runner with no audio devices, empty is what it always got.
        let (names, unreadable) = readable_names(Vec::<std::result::Result<String, anyhow::Error>>::new());
        assert!(names.is_empty());
        assert_eq!(unreadable, 0);
    }

    #[test]
    fn a_device_whose_name_cannot_be_read_is_counted_rather_than_vanishing() {
        let (names, unreadable) = readable_names(vec![
            Ok("Speakers".to_string()),
            Err(anyhow::anyhow!("name unavailable")),
            Ok("HDMI".to_string()),
        ]);

        assert_eq!(names, vec!["Speakers".to_string(), "HDMI".to_string()]);
        assert_eq!(
            unreadable, 1,
            "a device dropped from the picker must be counted, or the user cannot tell it \
             from a device the machine does not have"
        );
    }

    #[test]
    fn order_is_the_enumeration_order() {
        let (names, _) = readable_names(vec![
            Ok::<_, anyhow::Error>("b".to_string()),
            Ok("a".to_string()),
            Ok("c".to_string()),
        ]);
        assert_eq!(names, vec!["b".to_string(), "a".to_string(), "c".to_string()]);
    }
}

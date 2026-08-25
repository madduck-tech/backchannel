// Post-hoc speaker labelling.
//
// Most of the model catalog cannot tell you who spoke. Only two families
// diarize (see `config::DIARIZING_VARIANTS`), and picking one of them means
// accepting its WER, its languages and its speed for the sake of a label. This
// module removes that trade: a dedicated diarizer runs over the finished
// recording afterwards and stamps speaker ids onto the transcript rows that are
// already there, whichever model produced them.
//
// Three things make this cheap rather than a second transcription pipeline:
//
//   - It never touches the text. Rows keep their words, their times and their
//     ids; only the `speaker` column changes. That makes the pass idempotent
//     and re-runnable, and means a user who has already read their transcript
//     does not watch it rewrite itself.
//   - It reuses `retranscription`'s audio front end (`find_audio_file`, decode,
//     resample) and its in-progress guard. Both jobs rewrite one meeting's rows,
//     so sharing the guard is what stops them racing.
//   - The diarizer is loaded for the duration of the run and dropped. It never
//     enters `TranscribeEngine`'s single model slot, so nothing about recording
//     changes and no memory is held between meetings.
//
// The one thing that is not negotiable: sortformer must see the *continuous*
// recording in a single `run`. Its speaker cache is what carries identity
// across the meeting, so feeding it VAD segments would restart the numbering at
// every pause and produce labels that mean nothing.

use crate::audio::retranscription::{find_audio_file, RetranscriptionGuard};
use crate::state::AppState;
use anyhow::{anyhow, Result};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use transcribe_cpp::{
    Model, RunExtension, RunOptions, SortformerPreset, SortformerStreamOptions, SpeakerSegment,
};

/// Result of a labelling pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationResult {
    pub meeting_id: String,
    /// Rows that came back with a speaker.
    pub labelled_count: usize,
    /// Rows left `None` because no speaker turn overlapped them.
    pub unlabelled_count: usize,
    /// Distinct speakers found, capped by the model at four.
    pub speaker_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationError {
    pub meeting_id: String,
    pub error: String,
}

/// One transcript row, as much of it as the mapping needs.
struct Row {
    id: String,
    text: String,
    timestamp: String,
    audio_start_time: Option<f64>,
    audio_end_time: Option<f64>,
    duration: Option<f64>,
}

/// Whether the diarizer weights are on disk.
pub async fn is_diarizer_downloaded<R: Runtime>(app: &AppHandle<R>) -> bool {
    match diarizer_path(app).await {
        Ok(path) => path.exists(),
        Err(_) => false,
    }
}

async fn diarizer_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let engine = {
        let guard = crate::transcribe_engine::commands::TRANSCRIBE_ENGINE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    let engine = engine.ok_or_else(|| anyhow!("Transcription engine not initialized"))?;
    let _ = app;
    Ok(engine
        .get_models_directory()
        .await
        .join(crate::config::SPEAKER_DIARIZER.filename))
}

/// Label the speakers in one meeting.
///
/// Errors rather than downloading if the diarizer is missing: pulling 139 MB as
/// a side effect of a labelling request is the kind of surprise that a
/// privacy-first app does not get to spring on anybody. The caller downloads
/// deliberately, or reports the error.
pub async fn label_speakers<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_folder_path: String,
) -> Result<DiarizationResult> {
    let _guard = RetranscriptionGuard::acquire().map_err(|e| anyhow!(e))?;

    let result = run_diarization(&app, &meeting_id, &meeting_folder_path).await;

    match &result {
        Ok(res) => {
            let _ = app.emit("diarization-complete", res);
        }
        Err(e) => {
            let _ = app.emit(
                "diarization-error",
                DiarizationError {
                    meeting_id: meeting_id.clone(),
                    error: e.to_string(),
                },
            );
        }
    }

    result
}

async fn run_diarization<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    meeting_folder_path: &str,
) -> Result<DiarizationResult> {
    let folder = PathBuf::from(meeting_folder_path);
    let audio_path = find_audio_file(&folder)?;
    let model_path = diarizer_path(app).await?;
    if !model_path.exists() {
        return Err(anyhow!(
            "The speaker model is not downloaded yet ({} MB). Enable speaker labelling in settings to download it.",
            crate::config::SPEAKER_DIARIZER.size_mb
        ));
    }

    info!(
        "Labelling speakers for meeting {} from {}",
        meeting_id,
        audio_path.display()
    );

    // Decode and resample are CPU-bound over the whole file; a two-hour meeting
    // is minutes of work, not milliseconds.
    let decode_path = audio_path.clone();
    let decoded = tokio::task::spawn_blocking(move || {
        crate::audio::decoder::decode_audio_file(&decode_path)
    })
    .await
    .map_err(|e| anyhow!("Decode task panicked: {}", e))??;

    let duration_seconds = decoded.duration_seconds;
    let audio = tokio::task::spawn_blocking(move || decoded.to_whisper_format())
        .await
        .map_err(|e| anyhow!("Resample task panicked: {}", e))?;

    let turns = run_diarizer(model_path, audio).await?;
    info!(
        "Diarizer produced {} speaker turns over {:.1}s",
        turns.len(),
        duration_seconds
    );

    let rows = load_rows(app, meeting_id).await?;
    if rows.is_empty() {
        return Err(anyhow!("This meeting has no transcript to label"));
    }

    let labels: Vec<Option<String>> = rows
        .iter()
        .map(|row| {
            let (start, end) = row_span(row)?;
            dominant_speaker(&turns, start, end).map(|id| id.to_string())
        })
        .collect();

    let labelled_count = labels.iter().filter(|l| l.is_some()).count();
    let mut speakers: Vec<&String> = labels.iter().flatten().collect();
    speakers.sort();
    speakers.dedup();

    save_labels(app, meeting_id, &rows, &labels).await?;
    write_meeting_files(&folder, meeting_id, &rows, &labels, duration_seconds, &audio_path);

    let result = DiarizationResult {
        meeting_id: meeting_id.to_string(),
        labelled_count,
        unlabelled_count: rows.len() - labelled_count,
        speaker_count: speakers.len(),
    };
    info!(
        "Labelled {}/{} rows across {} speakers for meeting {}",
        result.labelled_count,
        rows.len(),
        result.speaker_count,
        meeting_id
    );
    Ok(result)
}

/// Load the diarizer, run it over the whole recording, drop it.
///
/// Everything lives inside the one blocking closure so the weights are freed
/// the moment the run returns — the pass happens once per meeting, and 139 MB
/// resident for the rest of the session buys nothing.
async fn run_diarizer(model_path: PathBuf, audio: Vec<f32>) -> Result<Vec<SpeakerSegment>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<SpeakerSegment>> {
        let started = std::time::Instant::now();
        let model = Model::load(&model_path)
            .map_err(|e| anyhow!("Failed to load the speaker model: {}", e))?;
        let mut session = model
            .session()
            .map_err(|e| anyhow!("Failed to open a speaker session: {}", e))?;

        let options = RunOptions {
            // VERY_HIGH_LATENCY is the offline operating point: ~30s of
            // lookahead, which costs nothing on a recording that already
            // finished, and it is the point upstream's 14.7% AMI DER was
            // measured at. `diarize` is left at its default deliberately —
            // sortformer sets DIARIZATION as a family invariant and populates
            // speaker segments straight from the probabilities, so the runtime
            // toggle has nothing to switch.
            family: Some(RunExtension::Sortformer(SortformerStreamOptions {
                preset: Some(SortformerPreset::VeryHighLatency),
            })),
            ..Default::default()
        };

        let transcript = session
            .run(&audio, &options)
            .map_err(|e| anyhow!("Speaker detection failed: {}", e))?;
        info!("Diarizer run took {:?}", started.elapsed());
        Ok(transcript.speaker_segments)
    })
    .await
    .map_err(|e| anyhow!("Speaker detection task panicked: {}", e))?
}

fn row_span(row: &Row) -> Option<(f64, f64)> {
    Some((row.audio_start_time?, row.audio_end_time?))
}

/// Pick the speaker who holds most of `[start_s, end_s)`.
///
/// Overlapping turns are the normal case, not an edge case — the diarizer is
/// scored with overlap included — so this sums each speaker's overlap with the
/// row before comparing, rather than taking whichever turn happens to be found
/// first. Rows are not split at turn boundaries: splitting needs word-level
/// timestamps to cut the text at, and stored rows do not carry any (the
/// streaming path emits none at all, deliberately).
///
/// A row that nothing overlaps returns `None` and stays unlabelled. Snapping it
/// to the nearest speaker would read exactly like a real attribution while
/// being a guess, and the transcript already refuses to invent a confidence
/// number for the same reason.
fn dominant_speaker(turns: &[SpeakerSegment], start_s: f64, end_s: f64) -> Option<i32> {
    if !(end_s > start_s) {
        return None;
    }
    let start_ms = start_s * 1000.0;
    let end_ms = end_s * 1000.0;

    // Four speakers maximum, so a linear scan beats a map and keeps the tie
    // rule in plain sight.
    let mut totals: Vec<(i32, f64)> = Vec::new();
    for turn in turns {
        if turn.speaker_id <= 0 {
            continue;
        }
        let overlap = (turn.t1_ms as f64).min(end_ms) - (turn.t0_ms as f64).max(start_ms);
        if overlap <= 0.0 {
            continue;
        }
        match totals.iter_mut().find(|(id, _)| *id == turn.speaker_id) {
            Some((_, total)) => *total += overlap,
            None => totals.push((turn.speaker_id, overlap)),
        }
    }

    // Ties go to the lower id so the answer does not depend on the order the
    // diarizer happened to emit its turns in.
    totals
        .into_iter()
        .reduce(|best, next| {
            if next.1 > best.1 || (next.1 == best.1 && next.0 < best.0) {
                next
            } else {
                best
            }
        })
        .map(|(id, _)| id)
}

async fn load_rows<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) -> Result<Vec<Row>> {
    let app_state = app
        .try_state::<AppState>()
        .ok_or_else(|| anyhow!("App state not available"))?;

    let rows: Vec<(String, String, String, Option<f64>, Option<f64>, Option<f64>)> =
        sqlx::query_as(
            "SELECT id, transcript, timestamp, audio_start_time, audio_end_time, duration
             FROM transcripts WHERE meeting_id = ?
             ORDER BY audio_start_time IS NULL, audio_start_time, timestamp",
        )
        .bind(meeting_id)
        .fetch_all(app_state.db_manager.pool())
        .await
        .map_err(|e| anyhow!("Failed to read transcripts: {}", e))?;

    Ok(rows
        .into_iter()
        .map(
            |(id, text, timestamp, audio_start_time, audio_end_time, duration)| Row {
                id,
                text,
                timestamp,
                audio_start_time,
                audio_end_time,
                duration,
            },
        )
        .collect())
}

/// Write the labels back, in one transaction.
///
/// An UPDATE per row rather than the delete-and-reinsert retranscription does:
/// the text is not changing, and rewriting rows that only need one column
/// touched is how ids drift out from under anything else holding them.
async fn save_labels<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    rows: &[Row],
    labels: &[Option<String>],
) -> Result<()> {
    let app_state = app
        .try_state::<AppState>()
        .ok_or_else(|| anyhow!("App state not available"))?;

    let pool = app_state.db_manager.pool();
    let mut conn = pool.acquire().await.map_err(|e| anyhow!("DB error: {}", e))?;
    let mut tx = sqlx::Connection::begin(&mut *conn)
        .await
        .map_err(|e| anyhow!("Failed to start transaction: {}", e))?;

    for (row, label) in rows.iter().zip(labels) {
        sqlx::query("UPDATE transcripts SET speaker = ? WHERE id = ? AND meeting_id = ?")
            .bind(label)
            .bind(&row.id)
            .bind(meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| anyhow!("Failed to save speaker label: {}", e))?;
    }

    tx.commit()
        .await
        .map_err(|e| anyhow!("Failed to commit speaker labels: {}", e))?;
    Ok(())
}

/// Rewrite the meeting folder's transcript files and stamp the metadata.
///
/// `transcript.md` renders a speaker prefix on every line, so leaving it stale
/// means the file the user exports disagrees with the app that produced it.
/// Failures are warnings, not errors: the labels are already committed, and
/// losing them over an unwritable folder would be the worse outcome.
fn write_meeting_files(
    folder: &Path,
    meeting_id: &str,
    rows: &[Row],
    labels: &[Option<String>],
    duration_seconds: f64,
    audio_path: &Path,
) {
    use crate::audio::common::{markdown_segments, write_transcript_md, write_transcripts_json};

    let segments: Vec<crate::api::TranscriptSegment> = rows
        .iter()
        .zip(labels)
        .map(|(row, label)| crate::api::TranscriptSegment {
            id: row.id.clone(),
            text: row.text.clone(),
            timestamp: row.timestamp.clone(),
            audio_start_time: row.audio_start_time,
            audio_end_time: row.audio_end_time,
            duration: row.duration,
            speaker: label.clone(),
        })
        .collect();

    if let Err(e) = write_transcripts_json(folder, &segments) {
        warn!("Failed to write transcripts.json: {}", e);
    }
    if let Err(e) = write_transcript_md(folder, None, &markdown_segments(&segments)) {
        warn!("Failed to write transcript.md: {}", e);
    }
    if let Err(e) = stamp_metadata(folder, meeting_id, duration_seconds, audio_path) {
        warn!("Failed to update metadata.json: {}", e);
    }
}

fn stamp_metadata(
    folder: &Path,
    meeting_id: &str,
    duration_seconds: f64,
    audio_path: &Path,
) -> Result<()> {
    let metadata_path = folder.join("metadata.json");
    let temp_path = folder.join(".metadata.json.tmp");
    let now = chrono::Utc::now().to_rfc3339();

    let json = if metadata_path.exists() {
        let existing = std::fs::read_to_string(&metadata_path)?;
        let mut value: serde_json::Value = serde_json::from_str(&existing)?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("diarized_at".to_string(), serde_json::json!(now));
        }
        value
    } else {
        let audio_filename = audio_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("audio.mp4");
        serde_json::json!({
            "version": "1.0",
            "meeting_id": meeting_id,
            "created_at": now,
            "completed_at": now,
            "diarized_at": now,
            "duration_seconds": duration_seconds,
            "audio_file": audio_filename,
            "transcript_file": "transcripts.json",
            "status": "completed",
        })
    };

    std::fs::write(&temp_path, serde_json::to_string_pretty(&json)?)?;
    std::fs::rename(&temp_path, &metadata_path)?;
    Ok(())
}

// Tauri commands

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationStarted {
    pub meeting_id: String,
}

/// Kick off a labelling pass. Result arrives as `diarization-complete` /
/// `diarization-error`.
#[tauri::command]
pub async fn label_speakers_command<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    meeting_folder_path: String,
) -> Result<DiarizationStarted, String> {
    if crate::audio::retranscription::is_retranscription_in_progress() {
        return Err("Another transcript job is already running".to_string());
    }

    let started = DiarizationStarted {
        meeting_id: meeting_id.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = label_speakers(app, meeting_id, meeting_folder_path).await {
            warn!("Speaker labelling failed: {}", e);
        }
    });
    Ok(started)
}

#[tauri::command]
pub async fn is_diarizer_downloaded_command<R: Runtime>(app: AppHandle<R>) -> bool {
    is_diarizer_downloaded(&app).await
}

/// How big the download is, so the UI can say so before starting it.
#[tauri::command]
pub fn diarizer_size_mb() -> u64 {
    crate::config::SPEAKER_DIARIZER.size_mb
}

/// Fetch the diarizer weights. Reuses the catalog downloader's cancellation and
/// partial-file cleanup without putting the diarizer in the catalog.
#[tauri::command]
pub async fn download_diarizer_command() -> Result<(), String> {
    let engine = {
        let guard = crate::transcribe_engine::commands::TRANSCRIBE_ENGINE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    let engine = engine.ok_or_else(|| "Transcription engine not initialized".to_string())?;

    let diarizer = &crate::config::SPEAKER_DIARIZER;
    engine
        .download_file(
            crate::config::SPEAKER_DIARIZER_NAME,
            diarizer.hf_repo,
            diarizer.filename,
            None,
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(t0_ms: i64, t1_ms: i64, speaker_id: i32) -> SpeakerSegment {
        SpeakerSegment {
            t0_ms,
            t1_ms,
            speaker_id,
            p: 1.0,
        }
    }

    #[test]
    fn picks_the_speaker_holding_most_of_the_row() {
        // Speaker 2 holds 3s of the row against speaker 1's 1s.
        let turns = vec![turn(0, 1000, 1), turn(1000, 4000, 2)];
        assert_eq!(dominant_speaker(&turns, 0.0, 4.0), Some(2));
    }

    #[test]
    fn sums_a_speakers_turns_before_comparing() {
        // Speaker 1 speaks twice for 2s total; speaker 2 has one 1.5s stretch.
        // Taking the longest single turn would wrongly pick 2.
        let turns = vec![turn(0, 1000, 1), turn(1000, 2500, 2), turn(2500, 3500, 1)];
        assert_eq!(dominant_speaker(&turns, 0.0, 3.5), Some(1));
    }

    #[test]
    fn overlapping_turns_both_count() {
        // Two people talking over each other for the whole row; 2 holds more.
        let turns = vec![turn(0, 2000, 1), turn(0, 4000, 2)];
        assert_eq!(dominant_speaker(&turns, 0.0, 4.0), Some(2));
    }

    #[test]
    fn a_row_nobody_overlaps_stays_unlabelled() {
        let turns = vec![turn(0, 1000, 1)];
        assert_eq!(dominant_speaker(&turns, 5.0, 6.0), None);
    }

    #[test]
    fn clips_turns_to_the_rows_span() {
        // Speaker 1's turn is enormous but only 0.5s of it lands in the row,
        // against a full second of speaker 2.
        let turns = vec![turn(0, 10_500, 1), turn(10_500, 12_000, 2)];
        assert_eq!(dominant_speaker(&turns, 10.0, 11.5), Some(2));
    }

    #[test]
    fn ties_go_to_the_lower_id_whatever_the_turn_order() {
        let ascending = vec![turn(0, 1000, 1), turn(1000, 2000, 2)];
        let descending = vec![turn(1000, 2000, 2), turn(0, 1000, 1)];
        assert_eq!(dominant_speaker(&ascending, 0.0, 2.0), Some(1));
        assert_eq!(dominant_speaker(&descending, 0.0, 2.0), Some(1));
    }

    #[test]
    fn ignores_unattributed_turns() {
        // speaker_id 0 means "no attribution"; it must not become "Speaker 0".
        let turns = vec![turn(0, 3000, 0), turn(0, 1000, 1)];
        assert_eq!(dominant_speaker(&turns, 0.0, 3.0), Some(1));
    }

    #[test]
    fn rejects_an_empty_or_inverted_span() {
        let turns = vec![turn(0, 5000, 1)];
        assert_eq!(dominant_speaker(&turns, 2.0, 2.0), None);
        assert_eq!(dominant_speaker(&turns, 3.0, 1.0), None);
    }

    #[test]
    fn no_turns_at_all_labels_nothing() {
        assert_eq!(dominant_speaker(&[], 0.0, 10.0), None);
    }

    #[test]
    fn a_row_missing_its_times_is_skipped() {
        let row = Row {
            id: "a".into(),
            text: "hello".into(),
            timestamp: "t".into(),
            audio_start_time: None,
            audio_end_time: Some(3.0),
            duration: None,
        };
        assert_eq!(row_span(&row), None);
    }
}

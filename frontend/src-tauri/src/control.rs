//! Driving a recording from a shell, for the virtual audio experiment's verification (#281,
//! ADR 0034). Not a product mode: nothing here records anything itself.
//!
//! A second launch of the binary hands its arguments to the running app through
//! `tauri-plugin-single-instance` (a Unix socket on macOS). When those arguments are
//! `--control <command> --control-id <id> …`, this module runs the **same** crate-root commands
//! the Start and Stop buttons invoke and appends one JSON line per command to
//! `control-results.jsonl` in the app data directory. Anything else keeps today's behaviour.
//!
//! The opt-in is `--control-enabled` on the running app's **own** launch, read once in `run()`.
//! Forwarded arguments never enable it: any process of the same user can write to the socket,
//! so the launch flag is the whole boundary.
//!
//! What a control run does not exercise -- every UI surface, the onboarding gate, the frontend's
//! model check and title, and the meeting's database row (only the frontend saves it, so a
//! control meeting is absent from the meeting list) -- is listed in #281 and named by every
//! verdict that uses this.

use std::io::Write;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, Runtime};

/// The revision this binary was built from, embedded at build time by `scripts/macos-control.sh
/// build`. A `.built-from` file inside the bundle would break its signature, so the caller looks
/// for the expected revision's hash in the executable itself, before it sends anything.
pub const BUILT_FROM: &str = match option_env!("BACKCHANNEL_BUILT_FROM") {
    Some(rev) => rev,
    None => "unknown",
};
/// The launch flag that enables control. Only ever read from the process's own arguments.
pub const ENABLE_FLAG: &str = "--control-enabled";
const CONTROL: &str = "--control";
const ID: &str = "--control-id";
const RESULTS: &str = "control-results.jsonl";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Start { mic: String, system: String, meeting: String },
    Stop,
    Status,
    SetBackend(String),
}

impl Command {
    /// The phase a state-changing command holds while it runs; `status` holds none.
    fn phase(&self) -> Option<&'static str> {
        match self {
            Command::Start { .. } => Some("starting"),
            Command::Stop => Some("stopping"),
            Command::SetBackend(_) => Some("setting-backend"),
            Command::Status => None,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Command::Start { .. } => "start",
            Command::Stop => "stop",
            Command::Status => "status",
            Command::SetBackend(_) => "set-backend",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// Not a control request: the second launch was a person opening the app again.
    NotControl,
    Request { id: String, command: Command },
    /// A control request that cannot be run. `id` is echoed when it was given.
    Invalid { id: Option<String>, error: String },
}

/// What a forwarded argument list asks for. Pure, so every rule here is tested on every platform.
///
/// `args[0]` is the second process's own path and is skipped, as are the arguments macOS or
/// a launcher may add. Only `--control …` pairs are read.
pub fn parse(args: &[String]) -> Parsed {
    let rest = args.get(1..).unwrap_or_default();
    let value = |flag: &str| {
        rest.iter()
            .position(|a| a == flag)
            .and_then(|i| rest.get(i + 1))
            .filter(|v| !v.starts_with("--"))
            .cloned()
    };
    if !rest.iter().any(|a| a == CONTROL) {
        return Parsed::NotControl;
    }
    let id = value(ID);
    let invalid = |error: String| Parsed::Invalid { id: id.clone(), error };
    let Some(name) = value(CONTROL) else {
        return invalid("--control needs a command: start, stop, status or set-backend".into());
    };
    let Some(id_value) = id.clone() else {
        return invalid(format!("{name}: --control-id <id> is required"));
    };
    let command = match name.as_str() {
        "start" => match (value("--mic"), value("--system")) {
            (Some(mic), Some(system)) => Command::Start {
                mic,
                system,
                meeting: value("--meeting").unwrap_or_else(|| format!("control {id_value}")),
            },
            _ => return invalid("start: --mic <name> and --system <name> are both required".into()),
        },
        "stop" => Command::Stop,
        "status" => Command::Status,
        "set-backend" => match value("--backend") {
            Some(backend) => Command::SetBackend(backend),
            None => return invalid("set-backend: --backend <id> is required".into()),
        },
        other => return invalid(format!("unknown control command {other:?}")),
    };
    Parsed::Request { id: id_value, command }
}

/// Whether this process was launched with control enabled. Reads the launch arguments only.
pub fn enabled_by_launch(launch_args: &[String]) -> bool {
    launch_args.iter().skip(1).any(|a| a == ENABLE_FLAG)
}

static ENABLED: OnceLock<bool> = OnceLock::new();

/// Called once from `run()` with `std::env::args()`.
pub fn init(launch_args: &[String]) {
    let enabled = enabled_by_launch(launch_args);
    let _ = ENABLED.set(enabled);
    if enabled {
        log::warn!("Control enabled by {ENABLE_FLAG}: a second launch can start and stop recordings (#281)");
    }
}

fn enabled() -> bool {
    ENABLED.get().copied().unwrap_or(false)
}

/// What to do with a parsed request, given the launch opt-in. Pure; the gate the tests hold.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    PassThrough,
    /// Control is off for this launch. The id is echoed so a caller can tell this from a hang.
    Refuse { id: Option<String> },
    Report { id: Option<String>, error: String },
    Run { id: String, command: Command },
}

pub fn decide(parsed: Parsed, enabled: bool) -> Decision {
    match parsed {
        Parsed::NotControl => Decision::PassThrough,
        Parsed::Invalid { id, .. } if !enabled => Decision::Refuse { id },
        Parsed::Request { id, .. } if !enabled => Decision::Refuse { id: Some(id) },
        Parsed::Invalid { id, error } => Decision::Report { id, error },
        Parsed::Request { id, command } => Decision::Run { id, command },
    }
}

/// The decision `handle` acts on: forwarded arguments say what is asked, and only the launch
/// says whether control is on. Pure, so the boundary is tested on the path `handle` takes.
pub fn decision_for(forwarded: &[String], launch_enabled: bool) -> Decision {
    decide(parse(forwarded), launch_enabled)
}

/// The single-instance callback's entry point. Returns true when the args were a control
/// request (handled or refused), so the caller does not focus the window for it.
pub fn handle<R: Runtime>(app: &AppHandle<R>, forwarded: &[String]) -> bool {
    match decision_for(forwarded, enabled()) {
        Decision::PassThrough => false,
        Decision::Refuse { id } => {
            log::warn!("Control request refused: this launch has no {ENABLE_FLAG} (#281)");
            // A line, so the caller can tell a refusal from a hang.
            let error = format!("control is not enabled: this launch has no {ENABLE_FLAG}");
            write_line(app, &serde_json::json!({ "id": id, "ok": false, "error": error }));
            true
        }
        Decision::Report { id, error } => {
            write_line(app, &serde_json::json!({ "id": id, "ok": false, "error": error }));
            true
        }
        Decision::Run { id, command } => {
            // Claimed before spawning, so two requests cannot both pass: measured on 2026-10-29,
            // a `set-backend` that arrived while a `start` waited on a TCC prompt switched the
            // backend between the microphone stream and the system stream, and the "selected
            // device" run recorded through the global tap.
            if let Some(phase) = command.phase() {
                if let Err(busy) = claim(&IN_FLIGHT, phase) {
                    write_line(app, &serde_json::json!({
                        "id": id, "command": command.name(), "ok": false,
                        "error": format!("busy: another control command is {busy}"),
                    }));
                    return true;
                }
            }
            let app = app.clone();
            // Spawned, never awaited here: this runs on the socket's accept loop, and `stop`
            // waits for transcription with no limit (#210), so `status` must not queue behind it.
            tauri::async_runtime::spawn(async move {
                let line = run(&app, &id, &command).await;
                if command.phase().is_some() {
                    release(&IN_FLIGHT);
                }
                write_line(&app, &line);
            });
            true
        }
    }
}

/// The one command that changes state, if any, for `status`. `IS_RECORDING` alone turns true
/// before the model is validated, so it would report "recording" for a start that then fails.
static IN_FLIGHT: Mutex<Option<&'static str>> = Mutex::new(None);

/// Take the slot for `phase`, or say which phase holds it. One state-changing command at a time.
fn claim(slot: &Mutex<Option<&'static str>>, phase: &'static str) -> Result<(), &'static str> {
    let mut held = slot.lock().unwrap_or_else(|e| e.into_inner());
    match *held {
        Some(busy) => Err(busy),
        None => {
            *held = Some(phase);
            Ok(())
        }
    }
}

fn release(slot: &Mutex<Option<&'static str>>) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

async fn phase() -> &'static str {
    let in_flight = *IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    match in_flight {
        Some(p) => p,
        None if crate::audio::recording_commands::is_recording().await => "recording",
        None => "idle",
    }
}

/// The devices the recording actually opened, as the product wrote them at folder init.
fn opened_devices(folder: &Option<String>) -> serde_json::Value {
    folder
        .as_ref()
        .and_then(|f| std::fs::read_to_string(std::path::Path::new(f).join("metadata.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|m| m.get("devices").cloned())
        .unwrap_or(serde_json::Value::Null)
}

async fn meeting_folder() -> Option<String> {
    crate::audio::recording_commands::get_meeting_folder_path()
        .await
        .ok()
        .flatten()
}

async fn run<R: Runtime>(app: &AppHandle<R>, id: &str, command: &Command) -> serde_json::Value {
    let base = |ok: bool| serde_json::json!({ "id": id, "command": command.name(), "ok": ok });
    let with = |mut v: serde_json::Value, extra: serde_json::Value| {
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        v
    };
    match command {
        Command::Start { mic, system, meeting } => {
            let result = crate::start_recording_with_devices_and_meeting(
                app.clone(),
                Some(mic.clone()),
                Some(system.clone()),
                Some(meeting.clone()),
            )
            .await;
            match result {
                Ok(()) => {
                    let folder = meeting_folder().await;
                    let transcripts = folder.as_ref().map(|f| format!("{f}/transcripts.json"));
                    with(base(true), serde_json::json!({
                        "meeting_folder": folder,
                        "transcripts": transcripts,
                        "devices": opened_devices(&folder),
                    }))
                }
                Err(error) => with(base(false), serde_json::json!({ "error": error })),
            }
        }
        Command::Stop => {
            let folder = meeting_folder().await;
            let save_path = save_path(app);
            let result = match save_path {
                Ok(save_path) => crate::stop_recording(app.clone(), crate::RecordingArgs { save_path }).await,
                Err(e) => Err(e),
            };
            match result {
                Ok(()) => with(base(true), serde_json::json!({
                    "meeting_folder": folder,
                    "transcripts": folder.as_ref().map(|f| format!("{f}/transcripts.json")),
                })),
                Err(error) => with(base(false), serde_json::json!({ "error": error })),
            }
        }
        Command::Status => {
            let folder = meeting_folder().await;
            let exe = std::env::current_exe().ok();
            with(base(true), serde_json::json!({
                "phase": phase().await,
                "backend": crate::audio::recording_preferences::get_current_audio_backend().await.ok(),
                "meeting_folder": folder,
                "devices": opened_devices(&folder),
                "executable": exe.map(|e| e.to_string_lossy().to_string()),
                "built_from": BUILT_FROM,
            }))
        }
        Command::SetBackend(backend) => {
            match crate::audio::recording_preferences::set_audio_backend(app.clone(), backend.clone()).await {
                Ok(()) => with(base(true), serde_json::json!({ "backend": backend })),
                Err(error) => with(base(false), serde_json::json!({ "error": error })),
            }
        }
    }
}

/// The same path the tray builds for `stop` (`tray.rs`), which the frontend also uses.
fn save_path<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    Ok(dir.join(format!("recording-{timestamp}.wav")).to_string_lossy().to_string())
}

static WRITE: Mutex<()> = Mutex::new(());

/// One whole line per result, under a lock, so a reader never sees half of one.
fn write_line<R: Runtime>(app: &AppHandle<R>, value: &serde_json::Value) {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(dir) = app.path().app_data_dir() else {
        log::error!("Control: no app data dir for {RESULTS}");
        return;
    };
    let mut line = value.to_string();
    line.push('\n');
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(RESULTS))
        .and_then(|mut f| f.write_all(line.as_bytes()));
    if let Err(e) = written {
        log::error!("Control: could not append to {RESULTS}: {e}");
    }
    log::info!("Control result: {}", value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("/path/to/backchannel").chain(list.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn a_second_launch_without_control_keeps_todays_behaviour() {
        assert_eq!(parse(&args(&[])), Parsed::NotControl);
        assert_eq!(parse(&args(&["-psn_0_12345"])), Parsed::NotControl);
        // The first element is the second process's own path, never a command.
        assert_eq!(parse(&["--control".to_string()]), Parsed::NotControl);
    }

    #[test]
    fn each_command_parses_with_its_arguments() {
        let start = parse(&args(&["--control", "start", "--control-id", "a1", "--mic", "BlackHole 2ch", "--system", "BlackHole 16ch"]));
        assert_eq!(
            start,
            Parsed::Request {
                id: "a1".into(),
                command: Command::Start { mic: "BlackHole 2ch".into(), system: "BlackHole 16ch".into(), meeting: "control a1".into() },
            }
        );
        let named = parse(&args(&["--control", "start", "--control-id", "a2", "--mic", "m", "--system", "s", "--meeting", "run 4"]));
        assert!(matches!(named, Parsed::Request { command: Command::Start { ref meeting, .. }, .. } if meeting == "run 4"));
        assert_eq!(parse(&args(&["--control", "stop", "--control-id", "b"])), Parsed::Request { id: "b".into(), command: Command::Stop });
        assert_eq!(parse(&args(&["--control-id", "c", "--control", "status"])), Parsed::Request { id: "c".into(), command: Command::Status });
        assert_eq!(
            parse(&args(&["--control", "set-backend", "--backend", "coreaudio", "--control-id", "d"])),
            Parsed::Request { id: "d".into(), command: Command::SetBackend("coreaudio".into()) }
        );
    }

    #[test]
    fn a_request_that_cannot_run_is_an_error_not_a_silent_no_op() {
        let cases: [(&[&str], Option<&str>, &str); 5] = [
            (&["--control", "dance", "--control-id", "x"], Some("x"), "unknown control command"),
            (&["--control", "stop"], None, "--control-id"),
            (&["--control", "--control-id", "y"], Some("y"), "needs a command"),
            (&["--control", "start", "--control-id", "z", "--mic", "m"], Some("z"), "--system"),
            (&["--control", "set-backend", "--control-id", "w"], Some("w"), "--backend"),
        ];
        for (list, id, needle) in cases {
            match parse(&args(list)) {
                Parsed::Invalid { id: got, error } => {
                    assert_eq!(got.as_deref(), id, "{list:?}");
                    assert!(error.contains(needle), "{list:?}: {error}");
                }
                other => panic!("{list:?} parsed as {other:?}"),
            }
        }
    }

    #[test]
    fn nothing_runs_unless_this_launch_opted_in() {
        let request = || parse(&args(&["--control", "stop", "--control-id", "s"]));
        assert_eq!(decide(request(), false), Decision::Refuse { id: Some("s".into()) });
        assert_eq!(decide(parse(&args(&["--control", "nope", "--control-id", "q"])), false), Decision::Refuse { id: Some("q".into()) });
        assert_eq!(decide(request(), true), Decision::Run { id: "s".into(), command: Command::Stop });
        assert_eq!(decide(parse(&args(&[])), false), Decision::PassThrough);
    }

    /// The opt-in comes from the running app's own launch. A forwarded copy of the flag is just
    /// another argument from whoever wrote to the socket.
    #[test]
    fn a_forwarded_opt_in_does_not_enable_control() {
        assert!(!enabled_by_launch(&args(&[])));
        assert!(enabled_by_launch(&args(&[ENABLE_FLAG])));
        let forwarded = args(&[ENABLE_FLAG, "--control", "stop", "--control-id", "f"]);
        assert_eq!(decision_for(&forwarded, false), Decision::Refuse { id: Some("f".into()) });
        assert_eq!(decision_for(&forwarded, true), Decision::Run { id: "f".into(), command: Command::Stop });
        assert!(!enabled_by_launch(&["/path/to/backchannel".to_string()]));
    }

    /// One state-changing command at a time; `status` takes no slot.
    #[test]
    fn a_second_state_change_is_refused_while_one_runs() {
        let slot = Mutex::new(None);
        assert_eq!(claim(&slot, "starting"), Ok(()));
        assert_eq!(claim(&slot, "setting-backend"), Err("starting"));
        assert_eq!(claim(&slot, "stopping"), Err("starting"));
        release(&slot);
        assert_eq!(claim(&slot, "setting-backend"), Ok(()));
        for command in [Command::Start { mic: "m".into(), system: "s".into(), meeting: "x".into() }, Command::Stop, Command::SetBackend("coreaudio".into())] {
            assert!(command.phase().is_some(), "{command:?} changes state and must take the slot");
        }
        assert_eq!(Command::Status.phase(), None);
    }

    /// One path: the dispatcher reaches the audio code only through the crate-root commands the
    /// buttons invoke and four named functions. Comments are stripped and `::` is matched with
    /// any spacing, and no `use` may bring audio items in under another name: the gate's
    /// adversary found the first version passed `crate::audio::stop_recording` (a re-export),
    /// `use … recording_commands as rc` and `recording_commands :: start_recording`.
    #[test]
    fn the_dispatcher_records_only_through_the_buttons_commands() {
        let source = include_str!("control.rs").replace("\r\n", "\n");
        let code: String = source[..source.find("#[cfg(test)]").expect("tests marker")]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        // Whitespace around `::` normalised away, so spacing cannot hide a path.
        let squeezed: String = {
            let mut out = String::new();
            let mut chars = code.chars().peekable();
            while let Some(c) = chars.next() {
                if c.is_whitespace() {
                    let rest: String = chars.clone().skip_while(|c| c.is_whitespace()).take(2).collect();
                    if rest == "::" || out.ends_with("::") {
                        continue;
                    }
                }
                out.push(c);
            }
            out
        };
        for needed in ["crate::start_recording_with_devices_and_meeting(", "crate::stop_recording("] {
            assert!(squeezed.contains(needed), "the dispatcher no longer calls {needed}");
        }
        for line in squeezed.lines().filter(|l| l.trim_start().starts_with("use ")) {
            assert!(!line.contains("audio"), "a `use` brings audio code in under another name: {line}");
        }
        let allowed = [
            "audio::recording_commands::is_recording",
            "audio::recording_commands::get_meeting_folder_path",
            "audio::recording_preferences::get_current_audio_backend",
            "audio::recording_preferences::set_audio_backend",
        ];
        for (i, _) in squeezed.match_indices("audio::") {
            let path: String = squeezed[i..].chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':').collect();
            assert!(allowed.contains(&path.as_str()), "the dispatcher reaches {path}, which bypasses the buttons' commands");
        }
        for forbidden in ["RecordingManager", "AudioPipeline", "AudioStream", "set_current_backend"] {
            assert!(!squeezed.contains(forbidden), "the dispatcher builds or sets {forbidden} itself");
        }
    }
}

//! Which cpal host the Linux audio paths run on, decided once per process.
//!
//! `cpal::default_host()` prefers the PulseAudio host over ALSA when the feature is on
//! (`cpal::platform::default_host`), and that preference is what makes sink monitors and
//! distinct microphone names exist at all on a PipeWire machine (#13). Two things make
//! calling it directly the wrong move:
//!
//! * It caches nothing, and the application calls it at sixteen sites. On a healthy machine
//!   that is sixteen client connections; on a machine whose PulseAudio socket exists but
//!   whose server never answers, it is sixteen two-second stalls and sixteen leaked
//!   threads, because cpal's `Host::new` gives up on a timeout and cannot join the thread
//!   it started (`cpal/src/host/pulseaudio/mod.rs`, "no other option than to leak the
//!   thread").
//! * Its availability check only stats the socket file, so a hung server is offered and
//!   then fails. Falling back is correct, but paying for the discovery every time is not.
//!
//! So the decision is made once and remembered: probe, and if the preferred host cannot be
//! constructed, record ALSA and never try again in this process.
//!
//! **The host itself is what is remembered, not its id** (#223). Remembering only the id meant
//! every call ran `cpal::host_from_id`, and on the PulseAudio host that opens a new client whose
//! reactor thread owns its socket and is never closed when the `Host` drops
//! (`pulseaudio-0.3.1/src/client/reactor.rs:61-67`). Measured on 2026-10-26: the product owner's
//! AppImage held 56 such clients after about 100 minutes, pipewire-pulse refused it 2242 times, and
//! four recordings started on ALSA with no system audio and no error. One host, built once and
//! shared, is one connection.
//!
//! A shared connection can die, when pipewire-pulse restarts. So the shared host is checked, at
//! most once a second, with one host-level request; a host that answers `StreamInvalidated` (what
//! cpal makes of a lost connection) is built again, once per dead host. If PulseAudio cannot be
//! constructed, ALSA serves in the meantime and PulseAudio is tried again at most once every 10 s:
//! ALSA has no sink monitors, so staying on it would record no other side until a restart, which is
//! what this module exists to stop. A refused or reset construction leaks nothing and is retried
//! without limit; one that times out leaks its thread, and possibly a connection
//! (`cpal/src/host/pulseaudio/mod.rs:138-141`), so after 3 of those the process stops retrying.
//! Streams already open on a dead host are not recovered here.
//!
//! The check has a 2 s deadline: a PulseAudio request has none (`pulseaudio-0.3.1`
//! `client/reactor.rs:72-91`), so a server that stays connected but stops answering would hold
//! every caller for ever. And the host never changes inside a recording: not while one runs, and
//! not in the 30 s after a start begins, because a start asks for the host several times and a
//! switch between two of those asks is the mixed start the 11:01 recording showed (#223). A start
//! makes a due retry first, so it does not begin on ALSA while PulseAudio is back.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};

/// What a factory built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The preferred value: checked for liveness and rebuilt when dead.
    Preferred,
    /// What serves while the preferred one cannot be built: the preferred one is retried.
    Fallback,
    /// There is nothing to prefer or fall back to (every platform but Linux): never checked.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    Only,
}

pub(crate) struct Built<T> {
    pub value: T,
    pub kind: Kind,
}

/// What a liveness check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Liveness {
    Alive,
    Dead,
}

/// What a retry of the preferred value gave.
pub(crate) enum Retry<T> {
    Got(T),
    Failed { timed_out: bool },
}

/// Timed-out retries after which the process stops retrying: each one leaks a thread.
const MAX_TIMED_OUT_RETRIES: u32 = 3;

struct Slot<T> {
    value: Arc<T>,
    kind: Kind,
    generation: u64,
    checked: Instant,
    retried: Instant,
    timed_out_retries: u32,
}

/// One value built on first use and shared, rebuilt only when a liveness check says the shared one
/// is dead, and while it is the fallback, the preferred one retried on an interval. Generic, and
/// given its factory, its check and its retry, so its rules are tested without a sound server.
/// (#223)
pub(crate) struct Shared<T> {
    slot: Mutex<Option<Slot<T>>>,
    check_every: Duration,
    retry_every: Duration,
}

impl<T> Shared<T> {
    pub(crate) const fn new(check_every: Duration, retry_every: Duration) -> Self {
        Self { slot: Mutex::new(None), check_every, retry_every }
    }

    /// The shared value. The lock is held while a check, a build or a retry runs, so concurrent
    /// callers that find one dead value build exactly one replacement.
    pub(crate) fn get(
        &self,
        hold: bool,
        build: impl Fn() -> Built<T>,
        check: impl Fn(&Arc<T>) -> Liveness,
        retry: impl Fn() -> Retry<T>,
    ) -> Arc<T> {
        let mut slot = self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        match slot.as_mut() {
            None => {
                let built = build();
                *slot = Some(Slot {
                    value: Arc::new(built.value),
                    kind: built.kind,
                    generation: 1,
                    checked: now,
                    retried: now,
                    timed_out_retries: 0,
                });
            }
            Some(s) if !hold && s.kind == Kind::Preferred && now.duration_since(s.checked) >= self.check_every => {
                s.checked = now;
                if check(&s.value) == Liveness::Dead {
                    let built = build();
                    s.value = Arc::new(built.value);
                    s.kind = built.kind;
                    s.generation += 1;
                    s.retried = now;
                    log::warn!(
                        "The shared audio host stopped answering; rebuilt it (generation {}){}",
                        s.generation,
                        if built.kind == Kind::Fallback { " on the fallback, retrying the preferred host" } else { "" }
                    );
                }
            }
            Some(s)
                if !hold
                    && s.kind == Kind::Fallback
                    && s.timed_out_retries < MAX_TIMED_OUT_RETRIES
                    && now.duration_since(s.retried) >= self.retry_every =>
            {
                Self::try_preferred(s, now, &retry);
            }
            Some(_) => {}
        }
        slot.as_ref().map(|s| s.value.clone()).expect("the slot was filled above")
    }

    /// Retry the preferred value now, whatever the interval, if the fallback is being served and
    /// the timeout cap is not reached. What a recording start does first. (#223)
    pub(crate) fn retry_now(&self, retry: impl Fn() -> Retry<T>) {
        let mut slot = self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(s) = slot.as_mut() {
            if s.kind == Kind::Fallback && s.timed_out_retries < MAX_TIMED_OUT_RETRIES {
                Self::try_preferred(s, Instant::now(), &retry);
            }
        }
    }

    fn try_preferred(s: &mut Slot<T>, now: Instant, retry: &impl Fn() -> Retry<T>) {
        s.retried = now;
        match retry() {
            Retry::Got(value) => {
                s.value = Arc::new(value);
                s.kind = Kind::Preferred;
                s.generation += 1;
                s.checked = now;
                log::info!("The preferred audio host is back; every device path uses it again (generation {})", s.generation);
            }
            Retry::Failed { timed_out: false } => {}
            Retry::Failed { timed_out: true } => {
                s.timed_out_retries += 1;
                if s.timed_out_retries == MAX_TIMED_OUT_RETRIES {
                    log::warn!("The preferred audio host timed out {MAX_TIMED_OUT_RETRIES} times; no more retries in this process");
                }
            }
        }
    }
}

/// `f`'s answer if it comes within `deadline`; `None` if not, leaving it to finish on its thread.
pub(crate) fn within<R: Send + 'static>(deadline: Duration, f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(deadline).ok()
}

/// cpal's `INIT_TIMEOUT` (`host/pulseaudio/mod.rs:26`), used as the deadline for a liveness check.
const CHECK_DEADLINE: Duration = Duration::from_secs(2);

/// Whether a failed construction timed out. A real timeout cannot return before cpal's 2 s, so
/// none is missed; a slow refusal is over-counted, which only stops retries early. cpal reports
/// `HostUnavailable` for a timeout and for a missing socket alike, so the kind cannot tell them.
/// The 1.5 s rests on a private cpal constant: a cpal update re-checks it.
pub(crate) fn construction_timed_out(elapsed: Duration) -> bool {
    elapsed >= Duration::from_millis(1500)
}

/// Until when the host may not change, as milliseconds since `EPOCH`: set when a start begins.
static HELD_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
const START_HOLD: Duration = Duration::from_secs(30);

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Whether the host may not change now: a recording runs, or a start began less than 30 s ago.
fn held() -> bool {
    crate::audio::recording_commands::is_recording_now() || now_ms() < HELD_UNTIL_MS.load(Ordering::SeqCst)
}

/// Called by a recording start before it asks for any device: a due retry happens now, so the
/// start does not begin on ALSA while PulseAudio is back, and then the host is held for the start.
pub fn prepare_for_recording() {
    HOST.retry_now(retry_preferred);
    HELD_UNTIL_MS.store(now_ms() + START_HOLD.as_millis() as u64, Ordering::SeqCst);
}

static HOST: Shared<cpal::Host> = Shared::new(Duration::from_secs(1), Duration::from_secs(10));

/// The host every device path in this crate should use: one host, built on the first call and
/// shared by every later one, so one sound-server connection per process (#223).
///
/// Equivalent to `cpal::default_host()` on the first call. A host that is advertised but unusable
/// costs one timeout per process rather than one per call site.
pub fn audio_host() -> Arc<cpal::Host> {
    HOST.get(held(), build_host, check_host, retry_preferred)
}

/// One host-level request on the shared host, within the deadline. Past it, the host counts as
/// dead: a server that stays connected and never answers is no use to a recording either.
fn check_host(host: &Arc<cpal::Host>) -> Liveness {
    let host = host.clone();
    within(CHECK_DEADLINE, move || liveness(host.output_devices().map(|_| ()))).unwrap_or(Liveness::Dead)
}

/// On Linux, PulseAudio, and ALSA if PulseAudio cannot be constructed (ADR 0015): each by its id,
/// not through `default_host()`, which hides PulseAudio's error behind ALSA and probes it twice
/// (`cpal/src/platform/mod.rs:833-847`). Elsewhere the default host is the only host.
fn build_host() -> Built<cpal::Host> {
    #[cfg(test)]
    tests::refuse_unless_opted_in();
    #[cfg(target_os = "linux")]
    let built = match cpal::host_from_id(cpal::HostId::PulseAudio) {
        Ok(host) => Built { value: host, kind: Kind::Preferred },
        Err(e) => {
            log::warn!("PulseAudio is unavailable ({e}); using ALSA and retrying PulseAudio every 10 s");
            let host = cpal::host_from_id(cpal::HostId::Alsa).unwrap_or_else(|_| cpal::default_host());
            Built { value: host, kind: Kind::Fallback }
        }
    };
    #[cfg(not(target_os = "linux"))]
    let built = Built { value: cpal::default_host(), kind: Kind::Only };
    log::info!("Audio host selected for this process: {:?}", built.value.id());
    built
}

/// One attempt at the preferred host. A construction that took most of cpal's 2 s `INIT_TIMEOUT`
/// timed out: cpal reports `HostUnavailable` for a timeout and a refusal alike, and only a timeout
/// leaks a thread.
fn retry_preferred() -> Retry<cpal::Host> {
    #[cfg(target_os = "linux")]
    {
        #[cfg(test)]
        tests::refuse_unless_opted_in();
        let started = Instant::now();
        match cpal::host_from_id(cpal::HostId::PulseAudio) {
            Ok(host) => Retry::Got(host),
            Err(_) => Retry::Failed { timed_out: construction_timed_out(started.elapsed()) },
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Retry::Failed { timed_out: true }
    }
}

/// A host-level request's outcome, as liveness: only a lost connection is death. A busy device or a
/// refused request on a live connection is not a reason to build another client.
pub(crate) fn liveness(result: Result<(), cpal::Error>) -> Liveness {
    match result {
        Err(e) if e.kind() == cpal::ErrorKind::StreamInvalidated => Liveness::Dead,
        _ => Liveness::Alive,
    }
}

/// Whether this device is a loopback of something being played, rather than a real input.
///
/// The identity used is the device **id**, not its display name. On the PulseAudio host the
/// id is the node name — `alsa_output.<card>.monitor` — while `description()` returns the
/// human string "Monitor of <sink>". Matching the description is what the previous code did
/// (`name.contains("monitor")`), and it matched nothing: `str::contains` is case-sensitive
/// and every PulseAudio description capitalises it. The id is also the part a user cannot
/// change, where the description follows the sink's name.
///
/// The description is still consulted as a fallback, case-insensitively, because the ALSA
/// host has no comparable id — an `.asoundrc` PCM is whatever it was written as, and the
/// repository's own Stage 2 harness writes one whose description carries "monitor".
pub fn is_monitor(device: &cpal::Device) -> bool {
    if let Ok(id) = device.id() {
        if id.id().to_ascii_lowercase().ends_with(".monitor") {
            return true;
        }
    }

    device
        .description()
        .map(|d| d.name().to_ascii_lowercase().contains("monitor"))
        .unwrap_or(false)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// Set by a test that means to reach the real sound server; every such test is `#[ignore]`d.
    static REAL_SOUND_SERVER: AtomicBool = AtomicBool::new(false);

    /// The default suite must not reach the user's sound server (#223): building the real host
    /// without this opt-in panics, so the next test that does is red.
    pub(crate) fn refuse_unless_opted_in() {
        assert!(
            REAL_SOUND_SERVER.load(Ordering::SeqCst),
            "a test reached the real sound server through audio_host(); such a test is #[ignore]d and calls tests::use_the_real_sound_server()"
        );
    }

    pub(crate) fn use_the_real_sound_server() {
        REAL_SOUND_SERVER.store(true, Ordering::SeqCst);
    }

    /// A counting factory over a plain value: `fallback_from` is the call number from which it
    /// returns the fallback, as a PulseAudio that refuses would make `default_host()` do.
    fn factory(count: &AtomicUsize, fallback_from: usize) -> impl Fn() -> Built<usize> + '_ {
        move || {
            let n = count.fetch_add(1, Ordering::SeqCst) + 1;
            Built { value: n, kind: if n >= fallback_from { Kind::Fallback } else { Kind::Preferred } }
        }
    }

    /// A counting retry that fails, fast or by timing out, or succeeds with `value`.
    fn retry(count: &AtomicUsize, outcome: Option<bool>, value: usize) -> impl Fn() -> Retry<usize> + '_ {
        move || {
            count.fetch_add(1, Ordering::SeqCst);
            match outcome {
                Some(timed_out) => Retry::Failed { timed_out },
                None => Retry::Got(value),
            }
        }
    }

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn a_hundred_calls_build_the_host_once() {
        let shared = Shared::new(HOUR, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let first = shared.get(false, factory(&count, usize::MAX), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        for _ in 0..99 {
            let next = shared.get(false, factory(&count, usize::MAX), |_| Liveness::Alive, retry(&retries, Some(false), 0));
            assert!(Arc::ptr_eq(&first, &next));
        }
        assert_eq!((count.load(Ordering::SeqCst), retries.load(Ordering::SeqCst)), (1, 0));
    }

    /// The fallback is remembered: a first construction that fell back is not rebuilt. Counted, not
    /// compared by id, since the fake and the fallback would be the same id either way.
    #[test]
    fn a_first_construction_that_fell_back_is_not_rebuilt() {
        let shared = Shared::new(Duration::ZERO, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        for _ in 0..100 {
            shared.get(false, factory(&count, 1), |_| Liveness::Dead, retry(&retries, Some(false), 0));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_dead_host_is_rebuilt_once_and_later_calls_get_the_new_one() {
        let shared = Shared::new(Duration::ZERO, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let first = shared.get(false, factory(&count, usize::MAX), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        let dead_first = |v: &Arc<usize>| if **v == 1 { Liveness::Dead } else { Liveness::Alive };
        let second = shared.get(false, factory(&count, usize::MAX), dead_first, retry(&retries, Some(false), 0));
        assert!(!Arc::ptr_eq(&first, &second));
        for _ in 0..100 {
            assert!(Arc::ptr_eq(&second, &shared.get(false, factory(&count, usize::MAX), dead_first, retry(&retries, Some(false), 0))));
        }
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_callers_that_find_one_dead_host_build_one_replacement() {
        let shared = Shared::new(Duration::ZERO, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        shared.get(false, factory(&count, usize::MAX), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    shared.get(
                        false,
                        factory(&count, usize::MAX),
                        |v: &Arc<usize>| if **v == 1 { Liveness::Dead } else { Liveness::Alive },
                        retry(&retries, Some(false), 0),
                    )
                });
            }
        });
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    /// While on the fallback, the preferred host is retried once per interval, not on every call.
    #[test]
    fn the_fallback_retries_the_preferred_host_at_most_once_per_interval() {
        let shared = Shared::new(Duration::ZERO, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        for _ in 0..100 {
            shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        }
        assert_eq!(retries.load(Ordering::SeqCst), 0, "no retry before the interval has passed");
    }

    #[test]
    fn a_retry_that_succeeds_makes_the_preferred_host_shared_again() {
        let shared = Shared::new(HOUR, Duration::ZERO);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let fallback = shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99));
        assert_eq!(*fallback, 1);
        let back = shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99));
        assert_eq!(*back, 99, "the preferred host is shared again");
        for _ in 0..100 {
            assert_eq!(*shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99)), 99);
        }
        assert_eq!((count.load(Ordering::SeqCst), retries.load(Ordering::SeqCst)), (1, 1));
    }

    /// Only a timed-out retry leaks a thread, so only those are capped; fast failures go on.
    #[test]
    fn timed_out_retries_stop_after_three_and_fast_failures_go_on() {
        let shared = Shared::new(HOUR, Duration::ZERO);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        for _ in 0..100 {
            shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, Some(true), 0));
        }
        assert_eq!(retries.load(Ordering::SeqCst), 3);

        let shared = Shared::new(HOUR, Duration::ZERO);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        for _ in 0..100 {
            shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        }
        assert_eq!(retries.load(Ordering::SeqCst), 100);
    }

    /// The check runs at most once per interval: a dead answer inside it changes nothing.
    #[test]
    fn the_liveness_check_runs_at_most_once_per_interval() {
        let shared = Shared::new(HOUR, HOUR);
        let (count, retries, checks) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
        let check = |_: &Arc<usize>| {
            checks.fetch_add(1, Ordering::SeqCst);
            Liveness::Dead
        };
        for _ in 0..100 {
            shared.get(false, factory(&count, usize::MAX), check, retry(&retries, Some(false), 0));
        }
        assert_eq!((count.load(Ordering::SeqCst), checks.load(Ordering::SeqCst)), (1, 0));
    }

    /// While a recording holds the host, neither a dead answer nor a due retry changes it; once
    /// released, both do (#223: a host change inside one start mixed hosts at 11:01).
    #[test]
    fn a_held_host_does_not_change_until_released() {
        let shared = Shared::new(Duration::ZERO, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let first = shared.get(false, factory(&count, usize::MAX), |_| Liveness::Alive, retry(&retries, Some(false), 0));
        for _ in 0..10 {
            let held = shared.get(true, factory(&count, usize::MAX), |_| Liveness::Dead, retry(&retries, Some(false), 0));
            assert!(Arc::ptr_eq(&first, &held), "the host changed while held");
        }
        let released = shared.get(false, factory(&count, usize::MAX), |_| Liveness::Dead, retry(&retries, Some(false), 0));
        assert!(!Arc::ptr_eq(&first, &released), "the dead host was not rebuilt once released");

        let shared = Shared::new(HOUR, Duration::ZERO);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99));
        assert_eq!(*shared.get(true, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99)), 1, "retried while held");
        assert_eq!(*shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99)), 99);
    }

    /// A start retries the preferred host at once, inside the interval, unless the cap is reached.
    #[test]
    fn a_start_retries_the_preferred_host_without_waiting_for_the_interval() {
        let shared = Shared::new(HOUR, HOUR);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99));
        shared.retry_now(retry(&retries, None, 99));
        assert_eq!(*shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, None, 99)), 99);

        let shared = Shared::new(HOUR, Duration::ZERO);
        let (count, retries) = (AtomicUsize::new(0), AtomicUsize::new(0));
        for _ in 0..10 {
            shared.get(false, factory(&count, 1), |_| Liveness::Alive, retry(&retries, Some(true), 0));
        }
        shared.retry_now(retry(&retries, Some(true), 0));
        assert_eq!(retries.load(Ordering::SeqCst), 3, "a start retried past the timeout cap");
    }

    /// The liveness check cannot hold its caller past the deadline, however long the request hangs.
    #[test]
    fn a_check_that_never_answers_gives_up_at_its_deadline() {
        let (never_tx, never_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let answer = within(Duration::from_millis(100), move || never_rx.recv().ok());
            let _ = done_tx.send(answer);
        });
        let answer = done_rx.recv_timeout(Duration::from_secs(2)).expect("the caller was held past the deadline");
        assert_eq!(answer, None);
        drop(never_tx);
    }

    #[test]
    fn a_construction_counts_as_timed_out_only_near_cpals_two_seconds() {
        assert!(!construction_timed_out(Duration::from_millis(1)));
        assert!(!construction_timed_out(Duration::from_millis(1400)));
        assert!(construction_timed_out(Duration::from_millis(2000)));
    }

    #[test]
    fn only_a_lost_connection_is_death() {
        assert_eq!(liveness(Ok(())), Liveness::Alive);
        assert_eq!(liveness(Err(cpal::Error::new(cpal::ErrorKind::StreamInvalidated))), Liveness::Dead);
        assert_eq!(liveness(Err(cpal::Error::new(cpal::ErrorKind::DeviceBusy))), Liveness::Alive);
        assert_eq!(liveness(Err(cpal::Error::new(cpal::ErrorKind::HostUnavailable))), Liveness::Alive);
    }

    /// No Linux code but this module picks a cpal host, so the one shared host cannot be bypassed.
    /// The three WASAPI sites compile on Windows only and are excused by name.
    #[test]
    fn no_other_module_picks_a_cpal_host() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") || path.ends_with("audio/devices/host.rs") {
                    continue;
                }
                let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
                for (i, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
                    let code = line.split("//").next().unwrap_or("");
                    let hit = ["cpal::default_host", "cpal::host_from_id", "cpal::available_hosts"].iter().any(|f| code.contains(f));
                    let windows_only = rel == "audio/devices/platform/windows.rs" || (rel == "audio/devices/speakers.rs" && code.contains("HostId::Wasapi"));
                    if hit && !windows_only {
                        found.push(format!("{rel}:{}: {}", i + 1, line.trim()));
                    }
                }
            }
        }
        assert!(found.is_empty(), "a cpal host picked outside audio/devices/host.rs:\n{}", found.join("\n"));
    }

    /// The real server: one connection for the whole process. Run by name, alone in its process, so
    /// the shared host is built by this test (#223 condition 2).
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a running PulseAudio or PipeWire server; selected by name in gopnik.json stage 1"]
    fn the_process_holds_one_sound_server_connection() {
        use_the_real_sound_server();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let sockets = || {
            std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .flatten()
                .filter(|e| std::fs::read_link(e.path()).is_ok_and(|t| t.to_string_lossy().starts_with("socket:")))
                .count()
        };
        // After the runtime exists: tokio opens sockets of its own.
        let base = sockets();
        let host = audio_host();
        assert_eq!(
            host.id(),
            cpal::HostId::PulseAudio,
            "the first construction fell back to {:?}: is the sound server down or full of clients?",
            host.id()
        );
        let first = sockets() - base;
        assert_eq!(first, 1, "the first call opened {first} sockets, expected one connection");
        for i in 0..100 {
            audio_host();
            rt.block_on(crate::audio::devices::discovery::list_audio_devices()).expect("devices are listed");
            let now = sockets() - base;
            assert!(now <= 1, "after {} calls the process holds {now} sockets more than before the first: a connection per call", i + 1);
        }
        assert_eq!(audio_host().id(), cpal::HostId::PulseAudio);
    }
}

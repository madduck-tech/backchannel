//! A pure Rust implementation of the PulseAudio protocol, suitable for writing
//! servers and clients.

#![warn(
    anonymous_parameters,
    missing_copy_implementations,
    missing_debug_implementations,
    missing_docs,
    nonstandard_style,
    rust_2018_idioms,
    single_use_lifetimes,
    trivial_casts,
    trivial_numeric_casts,
    unreachable_pub,
    unused_extern_crates,
    unused_qualifications,
    variant_size_differences
)]

use std::path::PathBuf;

mod client;
// Backchannel's fork (ADR 0033): rustc 1.98 flags 12 `value assigned to \`flags\` is never read` in
// protocol/command/{playback,record}_stream.rs. They are a real decode bug the published crate has too
// (a decoded stream command loses `early_requests`, `passthrough` and `fail_on_suspend`), harmless to a
// client, which only encodes those commands. From the registry the crate was built under
// `--cap-lints`; as a path dependency `-D warnings` reaches it. Allowed on this module only, so the
// protocol files stay the published ones and the lint still covers the cookie code.
#[allow(unused_assignments)]
pub mod protocol;
pub use client::*;

/// Attempts to determine the socket path from the runtime environment, checking
/// the following locations in order:
///   - $PULSE_SERVER
///   - $PULSE_RUNTIME_PATH/pulse/native
///   - $XDG_RUNTIME_DIR/pulse/native
///
/// Returns None if no socket can be found or if $PULSE_SERVER points to a
/// remote server, i.e. starts with a prefix other than 'unix:'.
pub fn socket_path_from_env() -> Option<PathBuf> {
    let paths = std::env::var("PULSE_SERVER")
        .ok()
        .filter(|s| s.starts_with("unix:"))
        .map(|s| PathBuf::from(&s[5..]))
        .into_iter()
        .chain(
            std::env::var("PULSE_RUNTIME_PATH")
                .ok()
                .map(|s| PathBuf::from(s).join("pulse/native")),
        )
        .chain(
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .map(|s| PathBuf::from(s).join("pulse/native")),
        );

    for path in paths {
        let stat = std::fs::metadata(&path).ok()?;
        if !stat.permissions().readonly() {
            return Some(path);
        }
    }

    None
}

/// The length of a PulseAudio authentication cookie. PipeWire's pulse server
/// refuses any other length, and libpulse sends this many zero bytes when it
/// can load no cookie.
pub const COOKIE_LENGTH: usize = 256;

/// The cookie [Client::from_env] sends, read from the
/// environment. See [cookie_from].
///
/// Backchannel's fork (ADR 0033): the published crate sent the file it found
/// as is, and an empty cookie when it found none, both of which PipeWire
/// refuses.
pub fn cookie_from_env() -> Vec<u8> {
    #[allow(deprecated)]
    let home = std::env::home_dir();
    cookie_from(
        std::env::var_os("PULSE_COOKIE").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        home.as_deref(),
    )
}

/// The cookie to send, from the values of `$PULSE_COOKIE`, `$XDG_CONFIG_HOME`
/// and the home directory. It is always exactly [COOKIE_LENGTH] bytes.
///
/// The files are tried in libpulse 16.1's order:
///
///   1. `$PULSE_COOKIE`;
///   2. `$XDG_CONFIG_HOME/pulse/cookie` when `XDG_CONFIG_HOME` is set and not
///      empty, and `$HOME/.config/pulse/cookie` otherwise;
///   3. `$HOME/.pulse-cookie`.
///
/// The first regular file that can be read decides: its first [COOKIE_LENGTH]
/// bytes if it holds that many, and [COOKIE_LENGTH] zero bytes otherwise. A
/// path that is missing, unreadable or not a regular file (a directory, a FIFO,
/// `/dev/zero`) is passed over, and at most [COOKIE_LENGTH] bytes are read, so
/// no path can block the audio host or fill its memory. With no file to read,
/// the cookie is zero bytes too, as libpulse sends. Nothing is written.
pub fn cookie_from(
    pulse_cookie: Option<&std::ffi::OsStr>,
    xdg_config_home: Option<&std::ffi::OsStr>,
    home: Option<&std::path::Path>,
) -> Vec<u8> {
    let config = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join("pulse/cookie")),
        None => home.map(|home| home.join(".config/pulse/cookie")),
    };
    let mut paths = pulse_cookie
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain(config)
        .chain(home.map(|home| home.join(".pulse-cookie")));
    match paths.find_map(|path| read_regular(&path)) {
        Some(mut bytes) if bytes.len() >= COOKIE_LENGTH => {
            bytes.truncate(COOKIE_LENGTH);
            bytes
        }
        _ => vec![0; COOKIE_LENGTH],
    }
}

/// At most [COOKIE_LENGTH] bytes of `path`, when it is a regular file that can be read.
fn read_regular(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::with_capacity(COOKIE_LENGTH);
    std::fs::File::open(path)
        .ok()?
        .take(COOKIE_LENGTH as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

/// Attempts to find the authentication cookie from the environment, checking
/// the following locations in order:
///
///   - $PULSE_COOKIE
///   - $HOME/.config/pulse/cookie
///   - $HOME/.pulse-cookie
pub fn cookie_path_from_env() -> Option<PathBuf> {
    #[allow(deprecated)]
    let home = std::env::home_dir()?;

    let mut paths = std::env::var("PULSE_COOKIE")
        .ok()
        .map(PathBuf::from)
        .into_iter()
        .chain(std::iter::once(home.join(".config/pulse/cookie")))
        .chain(std::iter::once(home.join(".pulse-cookie")));

    paths.find(|path| path.exists())
}

#[cfg(test)]
#[cfg(feature = "_integration-tests")]
mod integration_test_util {
    use std::{ffi::CString, io::BufReader, os::unix::net::UnixStream};

    use anyhow::Context;

    use super::*;
    use crate::protocol::*;

    #[test]
    fn socket_path() -> anyhow::Result<()> {
        let path = socket_path_from_env();
        assert!(path.is_some());
        assert!(path.unwrap().exists());

        Ok(())
    }

    pub(crate) fn connect_to_server() -> anyhow::Result<BufReader<UnixStream>> {
        let socket_path = socket_path_from_env().context("error finding pulse socket")?;
        let sock = UnixStream::connect(socket_path).context("error connecting to pulse socket")?;

        Ok(BufReader::new(sock))
    }

    pub(crate) fn init_client(mut sock: &mut BufReader<UnixStream>) -> anyhow::Result<u16> {
        let cookie = cookie_path_from_env()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        if cookie.is_empty() {
            eprintln!("warning: no pulseaudio cookie found");
        }

        let auth = AuthParams {
            version: MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        };

        write_command_message(sock.get_mut(), 0, &Command::Auth(auth), MAX_VERSION)
            .context("sending auth command failed")?;
        let (_, auth_reply) =
            read_reply_message::<AuthReply>(sock, MAX_VERSION).context("auth command failed")?;

        let protocol_version = std::cmp::min(MAX_VERSION, auth_reply.version);

        let mut props = Props::new();
        props.set(Prop::ApplicationName, CString::new("pulseaudio-rs-tests")?);
        write_command_message(
            sock.get_mut(),
            1,
            &Command::SetClientName(props),
            protocol_version,
        )
        .context("sending set_client_name command failed")?;
        let _ = read_reply_message::<SetClientNameReply>(&mut sock, protocol_version)
            .context("set_client_name command failed")?;

        Ok(protocol_version)
    }

    pub(crate) fn connect_and_init() -> anyhow::Result<(BufReader<UnixStream>, u16)> {
        let mut sock = connect_to_server()?;
        let protocol_version = init_client(&mut sock)?;

        Ok((sock, protocol_version))
    }
}

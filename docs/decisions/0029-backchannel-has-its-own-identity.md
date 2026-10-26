# 0029 — Backchannel has its own identity, and the old name stays only where it is not seen

Date: 2026-10-26
Status: accepted

## Context

The fork kept upstream's name in every string a person sees. It also kept upstream's identifier, `com.conversationaly.ai`, and `bykof/conversationaly` still ships under that identifier: seven releases from v1.0.0 to v1.4.1, the latest on 2026-08-26. Tauri names three things from the identifier:
- the data directories (`tauri-2.11.5/src/path/desktop.rs:238-290`);
- the webview's storage on Linux and Windows (`manager/webview.rs:534-545`);
- the single-instance lock (`tauri-plugin-single-instance-2.4.3`).

So on a machine with both apps:
- the first one running takes the other's launch;
- both use one meetings database;
- upstream would refuse that database, because it carries migrations upstream does not know.

Three constant directory names were upstream's as well, and `migrate.rs` moved Meetily's directories into this app at every start.

The product owner decided on 2026-10-26, before the first release (#228):
- Backchannel gets an identifier of its own;
- their own data is moved by hand, once, so no migration code ships. Backchannel had never been released, so no other install has data to move;
- the recordings folder for new installs is `backchannel-recordings`;
- the Windows publisher is `Backchannel`.

## Decision

1. **The identifier is `tech.madduck.backchannel`:** the reverse DNS of `madduck.tech`, the organisation's own domain (`gh api orgs/madduck-tech` → `blog`). It names the Linux single-instance lock's D-Bus name, the macOS socket, the Windows mutex and every data directory.
2. **What a person sees says Backchannel:**
   - `productName` and the window title;
   - the UI's strings, the tray tooltip and every notification;
   - the installer's publisher, descriptions and package metadata.

   `wix.upgradeCode` is pinned, so a later rename cannot install a second copy beside the first.
3. **The directories Backchannel names itself are its own:**
   - `Backchannel` for templates and the models fallbacks;
   - `backchannel` for notification settings;
   - `backchannel.log`;
   - `backchannel-recordings` as the default for new installs. A saved preference keeps its absolute path.
4. **`migrate.rs` is removed.** With an identifier of its own, it would move another product's library into this one.
5. **The old name stays only in a closed set of tokens, none of them seen in normal use:**
   - the webview storage keys `conversationaly.panes`, `conversationaly.theme` and `ConversationalyRecoveryDB`. They live inside the webview's directory, which now belongs to this identifier, and renaming them would drop a moved profile's layout, theme and recording recovery;
   - the crate and package names, which a local cargo build still names its binary after. The bundled binary is `backchannel` (`mainBinaryName`). Under upstream's name, each app's NSIS installer finds and offers to kill the other's running `conversationaly.exe` (`CheckIfAppIsRunning "${MAINBINARYNAME}.exe"` in CLI 2.11.4's template), and upstream's unattended updates run that installer;
   - the developer override `CONVERSATIONALY_LLAMA_HELPER`;
   - the credit to the direct upstream in About, under `LICENSE.md:4`.

   `the-app-calls-itself-backchannel.test.mjs` holds the set. Each token is bound to one file, and a line passes only if deleting its file's tokens leaves no match. Comments are exempt; there is no per-line excuse, and a token whose line is gone is red.

## Consequences

- The product owner's existing profile does not open in the renamed build until it is moved: `~/.local/share/com.conversationaly.ai` to `tech.madduck.backchannel`, and `~/.config/conversationaly` to `backchannel`. Nothing moves it automatically.
- Developer tools and CI artifact names that still say Conversationaly are #232. The mark is #231.

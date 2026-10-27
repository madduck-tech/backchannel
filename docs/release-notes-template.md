<!-- The description of every GitHub Release (ADR 0031). Copy it into the draft, fill every <…>, delete
     what does not apply, and keep the section order. Written by hand: a list of pull request titles is
     not a description. -->

<One sentence: Backchannel is a meeting copilot that records, transcribes and summarises meetings on your own machine.> It is a **pre-release**, for a first group of users.

<For a release that fixes or replaces an unpublished one, say so in one line.>

## Install

See [docs/INSTALL.md](https://github.com/madduck-tech/backchannel/blob/main/docs/INSTALL.md).

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Backchannel_<version>_aarch64.dmg` |
| Windows (x64) | `Backchannel_<version>_x64-setup.exe`, or the `.msi` |
| Linux (x86_64, Ubuntu 24.04 or newer) | `Backchannel_<version>_amd64.AppImage`, or the `.deb` (install with `sudo apt install ./Backchannel_<version>_amd64.deb`) |

**The installers are not code-signed:**
- **macOS** blocks the app on first open. Use **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine /Applications/Backchannel.app`.
- **Windows** SmartScreen warns. Use **More info → Run anyway**.

Check your download against `SHA256SUMS`. The app does not update itself; install each new version the same way.

## What has been tested

- **Linux:** <the gate, on what build; the attached files, through which checks; real meetings>.
- **macOS and Windows** are built by CI and have **not** been run by the project yet. Please report anything that breaks.

## Known limitations

**<What a person meets>** (#<issue>).
- <When it happens, and what they see.>
- <How to check for it.>
- <The workaround, as a command when there is one.>

<When the fix is planned, and which platforms are not affected.>

## In this release

- **<What a person notices, in their words.>** <One sentence on what was wrong before> (#<issue>).

<Checked against `git log --merges --oneline <previous tag>..<commit>`.>

**Full Changelog:** https://github.com/madduck-tech/backchannel/compare/<previous tag>...<tag> <once a previous published tag exists>

Backchannel is a fork of [Conversationaly](https://github.com/bykof/conversationaly) by Michael Bykovski, itself a fork of [Meetily](https://github.com/Zackriya-Solutions/meeting-minutes) by Zackriya Solutions, under the MIT license.

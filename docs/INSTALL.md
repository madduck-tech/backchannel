# Installing Conversationaly

Prebuilt installers are on the [Releases page](https://github.com/bykof/conversationaly/releases).

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `conversationaly_<version>_aarch64.dmg` |
| Windows (x64) | `conversationaly_<version>_x64-setup.exe` |
| Linux | `.deb` / `.rpm` / `.AppImage` |

Conversationaly is **not code-signed**, so both macOS and Windows will stop you
the first time you open it. Nothing is wrong with the download — the operating
system is telling you it cannot identify the publisher. Every release is built
in public by [GitHub Actions](../.github/workflows/release.yml) from this
repository, and ships a `SHA256SUMS` file you can check against
([how](#verifying-your-download)).

You only do this once. Updates are downloaded and verified by the app itself
against a signing key, so they install without any of the steps below.

## macOS

### Homebrew

```bash
brew install --cask --no-quarantine bykof/tap/conversationaly
```

`--no-quarantine` is what skips the warning. `brew upgrade` works normally
afterwards.

### From the .dmg

1. Open the `.dmg` and drag **conversationaly** to Applications.
2. Open it. macOS says it cannot be opened because Apple cannot check it for
   malicious software.
3. Open **System Settings → Privacy & Security**, scroll to the bottom, and
   click **Open Anyway** next to the Conversationaly entry.
4. Confirm with **Open**, then enter your admin password.

> Older guides tell you to right-click the app and choose Open. That stopped
> working in macOS 15 Sequoia — the Privacy & Security panel is now the only
> route.

Or do the same thing in one command:

```bash
xattr -dr com.apple.quarantine /Applications/conversationaly.app
```

Then open the app normally. macOS will ask for microphone and screen-recording
permission on first launch — it needs both, screen recording is how it captures
the audio of the other people in the call.

### If it stops hearing you after an update

Unsigned apps have no stable identity, so macOS occasionally loses track of
permissions it already granted — the toggle in Settings still looks enabled but
the app is refused. Reset it and grant again:

```bash
tccutil reset ScreenCapture com.conversationaly.ai
tccutil reset Microphone com.conversationaly.ai
```

Re-enable both in **System Settings → Privacy & Security**, then fully quit and
reopen the app.

## Windows

### From the installer

1. Run `conversationaly_<version>_x64-setup.exe`.
2. Windows shows **"Windows protected your PC"**.
3. Click **More info**, then **Run anyway**.

Or clear the download flag first and skip the warning entirely:

```powershell
Unblock-File .\conversationaly_1.3.0_x64-setup.exe
```

### Scoop

```powershell
scoop bucket add conversationaly https://github.com/bykof/conversationaly
scoop install conversationaly
```

### If Windows refuses outright

If you see **"Smart App Control has blocked this app"** rather than the usual
warning, there is no per-app override — Smart App Control only permits signed
or already-reputable software. Turning it off is a system-wide change we would
rather you not make on our account; [build from
source](BUILDING.md) instead, or wait until we ship signed installers.

The same applies to a work machine whose administrator has locked app
installation down. Ask them to allow it rather than working around it.

## Linux

```bash
sudo dpkg -i conversationaly_<version>_amd64.deb   # Debian, Ubuntu
sudo rpm -i conversationaly-<version>.x86_64.rpm   # Fedora, RHEL
chmod +x conversationaly_<version>_amd64.AppImage  # anything else
```

No signature prompts here. See [building_in_linux.md](building_in_linux.md) if
you would rather build it.

## Verifying your download

Every release includes `SHA256SUMS`. Download it next to your installer and
check that the hashes match:

```bash
# macOS, Linux
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
# Windows
(Get-FileHash .\conversationaly_1.3.0_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
# compare against the matching line in SHA256SUMS
```

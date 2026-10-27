# Installing Backchannel

Prebuilt installers are on the [Releases page](https://github.com/madduck-tech/backchannel/releases).
Releases are **pre-releases** for now, so the newest one is at the top of that page rather than
under "Latest".

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `Backchannel_<version>_aarch64.dmg` |
| Windows (x64) | `Backchannel_<version>_x64-setup.exe`, or `Backchannel_<version>_x64_en-US.msi` |
| Linux (x86_64) | `Backchannel_<version>_amd64.AppImage`, or `Backchannel_<version>_amd64.deb` |

The macOS release also carries `Backchannel_aarch64.app.tar.gz`, the same app bundle without a
disk image.

**What has been tested:**
- **Linux** is proven end to end.
- **macOS and Windows** are built by CI and have not been run by the project (ADR 0005). Please
  report what you find.
- **The Linux builds are made on Ubuntu 24.04** and need its C library (glibc 2.39) or newer.

Backchannel is **not code-signed**, so both macOS and Windows will stop you the first time you
open it. Nothing is wrong with the download: the operating system is telling you it cannot identify
the publisher. Every release is built in public by
[GitHub Actions](../.github/workflows/release.yml) from this repository, and ships a `SHA256SUMS`
file you can check against ([how](#verifying-your-download)).

The app does not update itself (the updater is off, #79). Each new version is installed the same
way as the first.

## macOS

### From the .dmg

1. Open the `.dmg` and drag **Backchannel** to Applications.
2. Open it. macOS says it cannot be opened because Apple cannot check it for malicious software.
3. Open **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway**
   next to the Backchannel entry.
4. Confirm with **Open**, then enter your admin password.

> Older guides tell you to right-click the app and choose Open. That stopped working in macOS 15
> Sequoia: the Privacy & Security panel is now the only route.

Or do the same thing in one command:

```bash
xattr -dr com.apple.quarantine /Applications/Backchannel.app
```

Then open the app normally. macOS asks for microphone and screen-recording permission on first
launch. It needs both: screen recording is how it captures the audio of the other people in the
call.

### If it stops hearing you after an update

Unsigned apps have no stable identity, so macOS occasionally loses track of permissions it already
granted. The toggle in Settings still looks enabled, but the app is refused. Reset it and grant
again:

```bash
tccutil reset ScreenCapture tech.madduck.backchannel
tccutil reset Microphone tech.madduck.backchannel
```

Re-enable both in **System Settings → Privacy & Security**, then fully quit and reopen the app.

## Windows

### From the installer

1. Run `Backchannel_<version>_x64-setup.exe`.
2. Windows shows **"Windows protected your PC"**.
3. Click **More info**, then **Run anyway**.

Or clear the download flag first and skip the warning entirely:

```powershell
Unblock-File .\Backchannel_0.1.1_x64-setup.exe
```

The `.msi` installs the same app, for machines where an MSI is what is allowed.

### If Windows refuses outright

If you see **"Smart App Control has blocked this app"** rather than the usual warning, there is no
per-app override. Smart App Control only permits signed or already-reputable software. Turning it
off is a system-wide change we would rather you not make on our account. [Build from
source](BUILDING.md) instead, or wait until we ship signed installers.

The same applies to a work machine whose administrator has locked app installation down. Ask them
to allow it rather than working around it.

## Linux

```bash
sudo apt install ./Backchannel_0.1.1_amd64.deb     # Debian, Ubuntu: pulls in its dependencies
chmod +x Backchannel_0.1.1_amd64.AppImage          # anything else
./Backchannel_0.1.1_amd64.AppImage
```

`dpkg -i` installs the package without its dependencies (for example `libopenblas0`), so use
`apt install ./…` as above. No signature prompts here. See
[building_in_linux.md](building_in_linux.md) if you would rather build it.

## Verifying your download

Every release includes `SHA256SUMS`. Download it next to your installer and check that the hashes
match:

```bash
# macOS, Linux
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
# Windows
(Get-FileHash .\Backchannel_0.1.1_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
# compare against the matching line in SHA256SUMS
```

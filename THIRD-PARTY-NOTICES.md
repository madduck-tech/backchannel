# Third-party notices

Backchannel's own code is under the MIT License in [`LICENSE.md`](LICENSE.md). These files in the repository, and in the app built from it, are under their own licences.

## Code

| what | where | licence |
| --- | --- | --- |
| The `pulseaudio` crate 0.3.1, © 2023 Colin Marc, with Backchannel's change to the cookie it sends (ADR 0034) | `vendor/pulseaudio/`, compiled into the app on Linux | MIT, in [`vendor/pulseaudio/LICENSE.md`](vendor/pulseaudio/LICENSE.md). [`BACKCHANNEL.md`](vendor/pulseaudio/BACKCHANNEL.md) records what was changed |

## Fonts

| font | where | licence |
| --- | --- | --- |
| IBM Plex Sans, Serif and Mono, © IBM Corp., with Reserved Font Name "Plex" | `frontend/src/app/fonts/`. They ship inside the app, and the licence ships beside them as `IBM-Plex-LICENSE.txt` | SIL Open Font License 1.1, in [`frontend/src/app/fonts/LICENSE.txt`](frontend/src/app/fonts/LICENSE.txt). The files are IBM's, unmodified; [`SOURCES.md`](frontend/src/app/fonts/SOURCES.md) records where each came from |
| Inter, by Rasmus Andersson | brought in by `@blocknote/core`, and shipped inside the app | SIL Open Font License 1.1. Its licence text does not ship with the app yet: #269 |

Showing these licences inside the app is #269.

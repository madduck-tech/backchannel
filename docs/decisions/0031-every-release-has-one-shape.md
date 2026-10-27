# 0031 — Every release has one shape: the same files, a written description, published on the product owner's word

Date: 2026-10-27
Status: accepted

## Context

0.1.0 was built, checked and drafted, and never published. 0.1.1 took its place (#254). While it was being built, the product owner compared it with the upstream release this project forked from, Conversationaly v1.4.1, and asked for every release to be made the same way from now on: "with assets, a description, and packages if needed".

That page has the installers, checksums and source archives, plus the files of Tauri's updater. A person downloading it can see what to take and check what they took. Its description is one generated "Full Changelog" link.

What 0.1.0 and 0.1.1 already did, and what was decided on 2026-10-27:
- `release.yml` builds macOS, Windows and Linux from one commit, and pins the tag to that commit (#229, #236).
- The description is written by hand, because a generated one is a list of pull request titles that says nothing about installing, about what was tested, or about what does not work yet.
- **No updater.** The product owner was asked whether the app should update itself, as upstream's does with `.sig` files and `latest.json`, and answered that it is not needed. Each version is installed by hand.
- **"Packages", for a desktop app, are the installers attached to the release.** GitHub Packages is a registry for libraries and container images, and has nothing to hold here. An apt repository, a Homebrew cask or winget would each be a decision of its own.

## Decision

1. **Every release is a GitHub Release made by `release.yml` from `main`,** with its tag pinned to the commit every leg built. While the version is `0.x`, it is marked a pre-release.
2. **Its files are exactly these,** plus the two source archives GitHub adds:

   | file | for |
   |---|---|
   | `Backchannel_<version>_aarch64.dmg` | macOS, Apple Silicon |
   | `Backchannel_aarch64.app.tar.gz` | the same app, as an archive |
   | `Backchannel_<version>_x64-setup.exe` | Windows |
   | `Backchannel_<version>_x64_en-US.msi` | Windows, for managed installs |
   | `Backchannel_<version>_amd64.AppImage` | Linux, no install |
   | `Backchannel_<version>_amd64.deb` | Linux, Ubuntu and Debian |
   | `SHA256SUMS` | a line for every other file |

   **No updater files.** There are no `.sig` files and no `latest.json` (`createUpdaterArtifacts: false`), and the app does not update itself. A change to that is a new decision, and its key needs a backup the product owner holds.
3. **Its description follows `docs/release-notes-template.md`,** written by hand. The sections:
   - what the app is, and that the release is a pre-release;
   - **Install:** the table of files, the steps past an unsigned installer on macOS and Windows, and the checksum check;
   - **What has been tested:** per platform, without overclaiming. macOS and Windows are built by CI and not run by the project, until they are (ADR 0005);
   - **Known limitations,** each with its workaround and its issue;
   - **In this release:** what a person notices, one line each, with issue numbers. It is checked against `git log --merges --oneline <previous tag>..<commit>`, and it ends with the "Full Changelog" compare link once a previous published tag exists;
   - the fork's attribution.
4. **The checks before publishing:**
   - the gate on the released commit's tree;
   - the launch checks and the version shown, on the downloaded Linux AppImage;
   - the `.deb` installed;
   - one real meeting by the product owner on the downloaded Linux file.
5. **Publishing is the product owner's** (ADR 0014). Every write to a draft sends `tag_name` and `target_commitish`, because the 0.1.0 draft lost its tag name after body-only writes. Immediately before publishing, `[.tag_name, .target_commitish, .draft, .prerelease]` is read back and confirmed.

## Consequences

- **What holds it:** `the-release-is-a-pre-release-on-three-platforms.test.mjs` holds the pre-release flag, the pinned commit, the checksum filter and the version carried everywhere. The template and the description are documentation, and nothing machine-checks the prose.
- Every release costs a hand-written description and one real meeting before it ships. That is the price of a page a colleague can act on without asking.
- Someone who installed a version has to install the next one by hand.

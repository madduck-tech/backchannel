#!/usr/bin/env python3
"""Regenerate TRANSCRIBE_MODEL_CATALOG in src/config.rs from transcribe.cpp's catalogue.

transcribe.cpp ships a machine-readable catalogue, `catalog/*.json` (schema
`transcribe-catalog-v1`): per variant, every published GGUF with its exact
`size_bytes`, the languages the port advertises, its licence, and accuracy
benchmarks by dataset, split, language and quantisation. That is every column
the catalog needs, so the catalog is generated rather than hand-typed. (#175)

Every row and the speaker diarizer are pinned to the Hugging Face commit whose
file is exactly the catalogue's `size_bytes`, with that file's sha256 (#179). The
commits come from `scripts/hf_revisions.json`, which `--walk` writes from the HF
API; without `--walk` the generator reads only that committed record, so it and
its tests run offline.

Usage:
    python3 scripts/gen_model_catalog.py [--walk] [path/to/transcribe.cpp checkout]

With no checkout it finds cargo's checkout of the revision Cargo.lock pins. A
checkout at any other revision, found or given, is refused: regenerating from
the wrong one reproduces a stale catalogue and every "rows that changed" check
then passes vacuously. Rewrites the region between the GENERATED markers in
src/config.rs, the diarizer's pin between its own markers, and
scripts/download_urls.tsv.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_RS = REPO_ROOT / "src" / "config.rs"
CARGO_LOCK = REPO_ROOT.parent.parent / "Cargo.lock"
BEGIN = "    // BEGIN GENERATED — see scripts/gen_model_catalog.py\n"
END = "    // END GENERATED\n"
# The diarizer's pin, inside `SPEAKER_DIARIZER`, which is otherwise hand-written.
PIN_BEGIN = "    // BEGIN GENERATED PIN — see scripts/gen_model_catalog.py\n"
PIN_END = "    // END GENERATED PIN\n"
HF_REVISIONS = REPO_ROOT / "scripts" / "hf_revisions.json"
DOWNLOAD_URLS = REPO_ROOT / "scripts" / "download_urls.tsv"
HF = "https://huggingface.co"
# The key the diarizer's commits are recorded under in hf_revisions.json, beside the row names.
DIARIZER_KEY = "SPEAKER_DIARIZER"
DIARIZER_FILE = "diar_streaming_sortformer_4spk-v2.1-Q8_0.gguf"

# Every row downloads from this owner (`config::TRANSCRIBE_MODEL_BASE_URL`).
OWNER = "handy-computer"

# Only records published for transcription yield rows. The speaker diarizer
# (`role: diarize`) emits speaker turns, never text, so it must never reach the
# picker: it lives as config.rs::SPEAKER_DIARIZER instead, downloaded on demand
# by the post-hoc labelling pass in audio/diarization.rs. The language
# identifier and the VAD are not transcription models either.
ROLE = "asr"

# ASR variants deliberately kept out of the catalog, each with its reason.
EXCLUDED = {
    # Upstream google/medasr is gated behind the Health AI Developer
    # Foundations terms, so the download 401s for most users.
    "medasr": "gated upstream",
    # 24B. Even Q4_K_M is far past what a meeting app should pull down.
    "voxtral-small-24b-2507": "too large",
    # Its repository answers 401 on `resolve` and on the API (#175), so a
    # listed `published_repo` does not prove the files can be downloaded.
    "phonon-2": "repository answers 401",
    # Offered by the product owner's decision of 2026-10-26, once the licence is
    # shown where a model is chosen (ADR 0030).
    "granite-speech-5.0-470m-turboctc-nc": "waits on its licence being shown, #227",
    "orukeet": "waits on its licence being shown, #227",
    # The product owner's decision of 2026-10-26 (ADR 0030): the Moonshine AI
    # Community License binds the app, not only the person. It asks the product
    # for "Powered by Moonshine AI", requires registration for commercial use,
    # and its use policy forbids recording people without their knowledge. The
    # English moonshine rows are MIT and stay.
    **{
        f"moonshine-{size}-{lang}": "Moonshine AI Community License binds the app: excluded by decision, ADR 0030"
        for size in ("base", "tiny")
        for lang in ("ar", "ja", "ko", "uk", "vi", "zh")
    },
}

# Every licence a shipped row or the diarizer names, each read from its text on
# 2026-10-26 (ADR 0030, and #197's licence table). Keyed by the record's SPDX id,
# or by `license.name` when the id is "other". `mark` is what a person must see
# where the model is chosen: none, non-commercial only, or a revenue limit in US
# dollars. A licence nobody has read stops the generator (`licence_of`).
NONE = ("none", None)
NON_COMMERCIAL = ("non_commercial", None)
LICENCES = {
    "apache-2.0": ("Apache License 2.0", "https://www.apache.org/licenses/LICENSE-2.0", NONE),
    "mit": ("MIT License", "https://opensource.org/license/mit", NONE),
    "cc-by-4.0": ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", NONE),
    "cc-by-sa-4.0": ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", NONE),
    "cc-by-nc-4.0": ("CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/", NON_COMMERCIAL),
    "cc-by-nc-sa-4.0": ("CC BY-NC-SA 4.0", "https://creativecommons.org/licenses/by-nc-sa/4.0/", NON_COMMERCIAL),
    "nvidia-open-model-license": (
        "NVIDIA Open Model License",
        "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
        NONE,
    ),
    "openmdw-1.1": ("OpenMDW 1.1", "https://openmdw.ai/license/1-1/", NONE),
    # §3's "for reference and learning purposes only" is read as a disclaimer, not a
    # use restriction (the product owner, 2026-10-26). FunAudioLLM's own cards for
    # both Fun-ASR Nano repositories say apache-2.0; the catalog's stricter licence
    # is the one followed, and the mark is none under either.
    "funasr-model-license-v1.1": (
        "FunASR Model License v1.1",
        "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
        NONE,
    ),
    # SenseVoice names the same text under another key.
    "model-license": (
        "FunASR Model License v1.1",
        "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
        NONE,
    ),
}

# A record whose licence carries neither an SPDX id nor a name, by its display.
# The diarizer's: its card names `nvidia-open-model-license` (read 2026-10-26).
LICENCE_ALIASES = {"NVIDIA Open Model License": "nvidia-open-model-license"}


def licence_key(licence):
    """The key a record's licence is looked up by: its SPDX id, else its name, else an alias."""
    licence = licence or {}
    spdx = licence.get("spdx")
    if spdx and spdx != "other":
        return spdx
    return licence.get("name") or LICENCE_ALIASES.get(licence.get("display"))


def licence_of(record):
    """The read licence for a record, or the generator stops naming the record and the key."""
    licence = record.get("license") or {}
    key = licence_key(licence)
    if key not in LICENCES:
        named = key or licence.get("display")
        raise SystemExit(
            f"{record.get('variant')}: its licence {named!r} has not been read. Read it, add it to "
            f"LICENCES with its mark, and record the reading (ADR 0030)."
        )
    entry = LICENCES[key]
    # A known key is not proof of a known text: upstream can reuse a generic name such as
    # "model-license" for another licence. Where the record links its text, it must be the one read.
    link = licence.get("link")
    if link and link != entry[1]:
        raise SystemExit(
            f"{record.get('variant')}: its licence {key!r} links {link}, but LICENCES read {entry[1]} "
            f"under that key. Read the linked text before it ships (ADR 0030)."
        )
    return entry

# Streaming-capable variants, for the pre-download "live-capable" label only.
#
# ponytail: hand-maintained because no source marks this reliably —
# parakeet-unified-en-0.6b is a unified streaming/offline model whose name says
# nothing. These are the models that stream natively. Runtime dispatch reads
# the GGUF's capabilities instead (`audio::transcription::live_path`), so a
# stale entry here mislabels a row but cannot pick the wrong decode path.
# Recheck against the family table in transcribe.cpp's README when bumping the
# pinned rev.
STREAMING = {
    "moonshine-streaming-tiny",
    "moonshine-streaming-small",
    "moonshine-streaming-medium",
    "nemotron-speech-streaming-en-0.6b",
    "nemotron-3.5-asr-streaming-0.6b",
    "multitalker-parakeet-streaming-0.6b-v1",
    "parakeet-unified-en-0.6b",
    "voxtral-mini-4b-realtime-2602",
}

# Rows that stream natively but whose stream is capped (`max_audio_ms` 81 920 for
# moonshine_streaming), so the application decodes them in VAD segments and the
# `streaming` field, which labels how text arrives, is false for them (#200).
# Their speed label and their place in the file (which Settings renders in
# order) still read the native streaming above: neither change was anybody's
# decision. `live_path` reads the cap from the GGUF, and the drift
# guard in `transcribe_engine::measurements` holds the two in agreement.
CAPPED_STREAMS = {
    "moonshine-streaming-tiny",
    "moonshine-streaming-small",
    "moonshine-streaming-medium",
}

# (variant prefix, display family, accuracy when no WER is published).
# Longest prefix wins, so order matters.
FAMILIES = [
    ("moonshine-streaming-", "Moonshine Streaming", "Good"),
    ("moonshine-", "Moonshine", "Good"),
    ("nemotron-3.5-asr-streaming-", "Nemotron 3.5", "High"),
    ("nemotron-speech-streaming-", "Nemotron Speech", "High"),
    ("multitalker-parakeet-streaming-", "Multitalker Parakeet", "Good"),
    ("parakeet-tdt-0.6b-v3", "Parakeet TDT v3", "High"),
    ("parakeet-unified-en-", "Parakeet Unified", "High"),
    ("parakeet-", "Parakeet", "High"),
    ("canary-1b-v2", "Canary v2", "High"),
    ("canary-qwen-", "Canary-Qwen", "High"),
    ("canary-", "Canary", "High"),
    ("breeze-asr-", "Breeze ASR", "Good"),
    ("whisper-", "Whisper", "Good"),
    ("gigaam-", "GigaAM", "Good"),
    ("qwen3-asr-", "Qwen3-ASR", "High"),
    ("cohere-transcribe-", "Cohere Transcribe", "High"),
    ("sensevoice-", "SenseVoice", "Good"),
    ("fun-asr-mlt-nano-", "FunASR Nano MLT", "Good"),
    ("fun-asr-nano-", "FunASR Nano", "Good"),
    ("granite-", "Granite Speech", "Good"),
    ("voxtral-mini-4b-realtime-", "Voxtral Realtime", "Good"),
    ("voxtral-", "Voxtral", "Good"),
    ("moss-transcribe-diarize", "MOSS Transcribe-Diarize", "Good"),
    ("sensevoicesmall", "SenseVoice", "Good"),
]

# The benchmark a row's WER is read from: LibriSpeech test-clean, English, at
# the row's own quantisation, except where a family names its own set.
# GigaAM's four are Russian models scored on FLEURS ru.
DEFAULT_SET = ("librispeech", "test-clean", "en")
FAMILY_SETS = {"GigaAM": ("fleurs", "test", "ru")}
SET_LABELS = {
    ("librispeech", "test-clean", "en"): "LibriSpeech test-clean",
    ("fleurs", "test", "ru"): "FLEURS ru (Russian)",
}

# Quantization suffix -> catalog name suffix. Q8_0 is the default download;
# Q4_K_M is offered as well once Q8_0 grows past this many MB.
Q8, Q4 = "Q8_0", "Q4_K_M"
Q4_THRESHOLD_MB = 500

# Rows whose `size_mb` stays at a value other than `round(size_bytes / 10⁶)`,
# each keyed by the `size_bytes` it was written against. The generator refuses
# an entry whose row is gone or whose bytes changed, so a hold cannot outlive
# the file it was written for. #193 deletes these.
#
# name -> (size_bytes written against, size_mb held, reason)
HOLD = {
    # The August export, the only root file that ever existed before the
    # repository's 2026-09-12 removal: 734 123 712 and 477 812 416 bytes, sha256
    # 4748deea…15c7 and d9f05f95…bb4f. Both load and decode jfk.wav to its words
    # on transcribe.cpp 0.4.1 (#175 condition 3a), so a profile holding one is
    # not damaged and must not read so. At the decimal floor of the new size it
    # would.
    "multitalker-parakeet-streaming-0.6b-v1-q8": (873_443_456, 734, "the August export, held until #193"),
    "multitalker-parakeet-streaming-0.6b-v1-q4": (617_132_160, 478, "the August export, held until #193"),
}


def size_mb_of(size_bytes):
    """The catalog's unit: decimal MB of the file's bytes, as the floor reads it."""
    return round(size_bytes / 1_000_000)


def family_of(variant):
    for prefix, name, fallback in FAMILIES:
        if variant.startswith(prefix):
            return name, fallback
    raise SystemExit(f"no family mapping for variant {variant!r} — add one to FAMILIES")


def accuracy_of(wer, fallback):
    """Map measured WER to the three tiers the UI renders as icons.

    Cutoffs come from the actual spread across all cards (n=370 quant rows:
    p25 1.63%, median 2.07%, p75 3.33%, long tail to 26.8%). Textbook-looking
    thresholds like 5%/10% would label ~85% of the catalog "High" and make the
    icon meaningless.

    ponytail: WER is not comparable across families — GigaAM's number is on a
    Russian set, Whisper's on LibriSpeech test-clean. Good enough to sort a
    model into three buckets, not to rank two models against each other.
    """
    if wer is None:
        return fallback
    if wer < 2.0:
        return "High"
    if wer < 4.5:
        return "Good"
    return "Decent"


def speed_of(size_mb, streaming):
    """ponytail: size stands in for parameter count, which stands in for speed.

    The catalogue publishes per-backend speed benchmarks but no single
    comparable RTF, and this only feeds a three-word label.
    """
    # Streaming models are real-time native by construction — but only the small
    # ones. voxtral-mini-4b-realtime is streaming and 4.8 GB at Q8; calling that
    # "Very Fast" would be a lie, so size still gets the last word above 1 GB.
    if streaming and size_mb < 1000:
        return "Very Fast"
    if size_mb < 150:
        return "Very Fast"
    if size_mb < 400:
        return "Fast"
    if size_mb < 1000:
        return "Medium"
    return "Slow"


def benchmark_wer(record, quant, wanted):
    """The WER `record` publishes for `quant` on the set `wanted`, or None."""
    dataset, split, language = wanted
    found = {
        b["err_pct"]
        for b in record["accuracy_benchmarks"]
        if (b["dataset"], b["split"], b["language"], b["quant"], b["metric"])
        == (dataset, split, language, quant, "wer")
    }
    if len(found) > 1:
        raise SystemExit(f"{record['variant']} publishes {sorted(found)} for {quant} on {wanted}")
    return found.pop() if found else None


def pinned_revision(lock=None):
    """`transcribe-cpp`'s revision in Cargo.lock, the one the application builds against. Two entries
    at different revisions are refused rather than resolved by taking the first."""
    lock = CARGO_LOCK.read_text(encoding="utf-8") if lock is None else lock
    found = set(re.findall(r'name = "transcribe-cpp"\nversion = "[^"]*"\nsource = "git\+[^#]+#([0-9a-f]{40})"', lock))
    if len(found) != 1:
        raise SystemExit(f"Cargo.lock pins transcribe-cpp at {sorted(found) or 'no git revision'}, not exactly one")
    return found.pop()


def checkout_revision(path):
    got = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True)
    if got.returncode != 0:
        raise SystemExit(f"{path} is not a git checkout: {got.stderr.strip()}")
    return got.stdout.strip()


def find_checkout(revision, cargo_home=None):
    """Cargo's checkout of `revision`, found by its short-revision directory name.

    Never by sort order: cargo names a checkout by its short revision, and once
    two exist, `"553f109" > "4d7c1cc"` picked the old one.
    """
    home = Path(cargo_home or os.environ.get("CARGO_HOME") or Path.home() / ".cargo")
    hits = sorted(
        d for d in (home / "git" / "checkouts").glob("transcribe.cpp-*/*")
        if d.is_dir() and revision.startswith(d.name)
    )
    if not hits:
        raise SystemExit(f"no transcribe.cpp checkout at {revision[:7]} under {home} — run `cargo fetch` first")
    return hits[0]


def verified(path, revision, revision_of=checkout_revision):
    """`path`, if it is checked out at `revision`; otherwise refuse, naming both."""
    got = revision_of(path)
    if got != revision:
        raise SystemExit(
            f"{path} is at {got}, but Cargo.lock pins transcribe-cpp at {revision}; "
            "refusing to generate the catalog from another revision"
        )
    return path


def load_records(checkout):
    """Every catalogue record, by variant. `_schema.json` and the like are not records."""
    records = {}
    for path in sorted((Path(checkout) / "catalog").glob("*.json")):
        if path.name.startswith("_"):
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        records[record["variant"]] = record
    if not records:
        raise SystemExit(f"no catalogue records under {checkout}/catalog")
    return records


def entries_for(record):
    """Pick the quantizations to ship for one variant."""
    if record.get("role", ROLE) != ROLE or record["variant"] in EXCLUDED:
        return []
    downloads = {d["quant"]: d for d in record["downloads"]}
    if Q8 not in downloads:
        return []
    owner, repo = record["published_repo"].split("/")
    if owner != OWNER:
        raise SystemExit(f"{record['variant']} is published by {owner}, not {OWNER}")

    # The name comes from the filename, never from `variant`: `sensevoice-small`'s
    # file is SenseVoiceSmall, and its row has always been `sensevoicesmall-q8`.
    # Renaming a row renames a storage key.
    slug = downloads[Q8]["filename"][: -len(f"-{Q8}.gguf")].lower()
    family, fallback = family_of(slug)
    licence_name, licence_url, (mark, revenue_usd) = licence_of(record)
    wanted = FAMILY_SETS.get(family, DEFAULT_SET)
    native = slug in STREAMING
    streaming = native and slug not in CAPPED_STREAMS
    picked = [("q8", downloads[Q8])]
    if size_mb_of(downloads[Q8]["size_bytes"]) > Q4_THRESHOLD_MB and Q4 in downloads:
        picked.append(("q4", downloads[Q4]))

    out = []
    for suffix, download in picked:
        quant = Q8 if suffix == "q8" else Q4
        wer = benchmark_wer(record, quant, wanted)
        size_mb = size_mb_of(download["size_bytes"])
        # No languages here — that has its own field, and repeating it produced
        # "Nemotron 3.5 — Multilingual — 39 locales".
        note = " — smaller download, lower memory use" if suffix == "q4" else ""
        out.append(
            {
                "name": f"{slug}-{suffix}",
                "family": family,
                "hf_repo": repo,
                "filename": download["filename"],
                "size_bytes": download["size_bytes"],
                "size_mb": size_mb,
                "accuracy": accuracy_of(wer, fallback),
                "wer": wer,
                "wer_set": SET_LABELS[wanted] if wer is not None else "",
                "speed": speed_of(size_mb, native),
                "streaming": streaming,
                "native": native,
                "languages": record["languages"],
                "license": record["license"]["spdx"],
                "license_name": licence_name,
                "license_url": licence_url,
                "license_mark": mark,
                "license_revenue_usd": revenue_usd,
                "upstream_repo": record["upstream_repo"],
                "description": f"{family}{note}",
            }
        )
    return out


def apply_holds(entries, hold=None):
    """Hold each listed row's `size_mb`, refusing an entry that is stale."""
    hold = HOLD if hold is None else hold
    by_name = {e["name"]: e for e in entries}
    for name, (size_bytes, size_mb, reason) in hold.items():
        if name not in by_name:
            raise SystemExit(f"HOLD names {name}, which is no longer a row — delete the entry")
        if by_name[name]["size_bytes"] != size_bytes:
            raise SystemExit(
                f"HOLD for {name} was written against {size_bytes} bytes, but the catalogue "
                f"now says {by_name[name]['size_bytes']} — the file changed, so the hold is stale ({reason})"
            )
        by_name[name]["size_mb"] = size_mb
    return entries



# --- the pin: which Hugging Face commit each row and the diarizer download (#179) -------------
#
# `size_bytes` is the only thing upstream's catalogue says about the bytes it measured, so a row is
# pinned to the newest commit, dated on or before the transcribe.cpp commit Cargo.lock pins, at
# which its file is exactly that long. Two things can make that choice need a person, and each
# needs an entry below, keyed so that an old entry cannot approve a new pin unseen:
#
# - a row whose chosen commit is not its repository's head (OFF_HEAD, keyed by row and revision);
# - a row whose eligible commits hold more than one sha256 at `size_bytes` (COLLISIONS, keyed by row
#   and the sha256 chosen). The rule still chooses, the newest; the entry approves those bytes.
#
# An entry that no longer applies is refused, as `ignored-tests-are-run.test.mjs` refuses a stale
# excuse.

# Off head, by row and revision. Two re-exports came after the size_bytes v0.4.1 records:
REEXPORTED_0927 = "v0.4.1's size_bytes is the export before upstream's 2026-09-27 re-export at a new length"
REEXPORTED_1026 = "re-exported on 2026-10-26, after the pinned commit, with every capability KV stated (weights unchanged)"
OFF_HEAD = {
    ("fun-asr-mlt-nano-2512-q4", "5db7c5bcebbc70d6c372e825399c3019f6089af7"): REEXPORTED_1026,
    ("fun-asr-mlt-nano-2512-q8", "5db7c5bcebbc70d6c372e825399c3019f6089af7"): REEXPORTED_1026,
    ("fun-asr-nano-2512-q4", "b0637e253b8805ce23e7e815a6673bed7ed6914b"): REEXPORTED_1026,
    ("fun-asr-nano-2512-q8", "b0637e253b8805ce23e7e815a6673bed7ed6914b"): REEXPORTED_1026,
    ("granite-4.0-1b-speech-q4", "9f243e662e448e8bcc64c3b1195413e106002334"): REEXPORTED_0927,
    ("granite-4.0-1b-speech-q8", "9f243e662e448e8bcc64c3b1195413e106002334"): REEXPORTED_0927,
    ("granite-speech-4.1-2b-nar-q4", "97fd42ae95532f13f119f78e048f46b5f5f1eee3"): REEXPORTED_1026,
    ("granite-speech-4.1-2b-nar-q8", "97fd42ae95532f13f119f78e048f46b5f5f1eee3"): REEXPORTED_1026,
    ("granite-speech-4.1-2b-plus-q4", "fc98d5c650f77eaa6210f0d70aac73c3c567f38c"): REEXPORTED_0927,
    ("granite-speech-4.1-2b-plus-q8", "fc98d5c650f77eaa6210f0d70aac73c3c567f38c"): REEXPORTED_0927,
    ("granite-speech-4.1-2b-q4", "8636dae5eebb011a3d9b56215944ed0925a0d035"): REEXPORTED_0927,
    ("granite-speech-4.1-2b-q8", "8636dae5eebb011a3d9b56215944ed0925a0d035"): REEXPORTED_0927,
    ("moss-transcribe-diarize-q4", "bfa3d24438711391d8713c6ab0efd6264527757c"): REEXPORTED_0927,
    ("moss-transcribe-diarize-q8", "bfa3d24438711391d8713c6ab0efd6264527757c"): REEXPORTED_0927,
}

# Collisions, by row and the sha256 chosen. The newest export at the row's length is chosen in each.
REQUANTISED_0628 = "2026-06-28's re-quantisation kept the length of 2026-06-27's conversion"
REUPLOADED_0912 = "2026-09-12's upload replaced 2026-09-11's at the same length"
COLLISIONS = {
    ("moonshine-streaming-medium-q8", "f7c9564249b508f6012927ec4f9e536087da53a7047f858ca9975bea5f75299e"): REQUANTISED_0628,
    ("moonshine-streaming-small-q8", "d03670f69629b649085d0f44a63d97668b4119117cc9611a4e4ad94341713dfc"): REQUANTISED_0628,
    ("moonshine-streaming-tiny-q8", "930e4622ad3a24158b91406c30c977fa6a26b34cb32d6ac3e57cfb23383a869e"): REQUANTISED_0628,
    ("voxtral-mini-4b-realtime-2602-q4", "39dc1f65539373a406edea7490505822d77c12edff521744678717eef4da4723"): REQUANTISED_0628,
    ("voxtral-mini-4b-realtime-2602-q8", "6fb22249463c1e7a600d920ad732e2dd0a231510e9db59fb8061d3d1d48d0c67"): REQUANTISED_0628,
    ("canary-1b-v2-q4", "49e0a67e219bec95a254c2348460b6350e75a7ac6f93a131e48244b4c7cb53b9"): REQUANTISED_0628,
    ("canary-1b-v2-q8", "224f83d1bc487b3303b495a7d6874912fdece93de19d1a04b550829c30a5d289"): REQUANTISED_0628,
    ("canary-qwen-2.5b-q4", "db5162229d6fa22597d06a613bd9b543eddb3ee02e6afc5e759120fde02bebf7"): REQUANTISED_0628,
    ("canary-qwen-2.5b-q8", "d89aad1285d5bd5aa441c464d3a4cf37bd5474f70705408e71558d8627415b34"): REQUANTISED_0628,
    ("cohere-transcribe-03-2026-q4", "0ea56826d8bd5d74b7143a4a04e022dc1bb75452cfae49d98b6acb0c1d16a1fb"): REQUANTISED_0628,
    ("cohere-transcribe-03-2026-q8", "931916663432fd895423a4291a8400221802b288967ca2d435fc5e3141c9e71e"): REQUANTISED_0628,
    ("fun-asr-mlt-nano-2512-q4", "9232584a27a7dcbcaf13640de8f9c2e7375178ea11e587f90a5328ecf06d58a1"): REQUANTISED_0628,
    ("fun-asr-mlt-nano-2512-q8", "d12476d8d9f2baa0ebf738fa955fa05ed33a654f1567289033a810c45d9d9002"): REQUANTISED_0628,
    ("fun-asr-nano-2512-q4", "444885fb7a16211a721e265dfe08c31b31e81fb9e2c4f21ab1079210cd038408"): REQUANTISED_0628,
    ("fun-asr-nano-2512-q8", "681caef6df15a2c0e153b40ca7fe4087fdf65751fa5e6fe605d8a75dff969e61"): REQUANTISED_0628,
    ("gigaam-v3-ctc-q8", "71e5c82890e9e243a6bd7575f129f5d1bd2c3ca3ae79aab75cfb1a6934c6a62b"): REQUANTISED_0628,
    ("gigaam-v3-e2e-ctc-q8", "9ccce4750dc813a493d96ca15ee251712bedec15ac9a02fa3d2bd732f08ae5eb"): REQUANTISED_0628,
    ("gigaam-v3-e2e-rnnt-q8", "78d63b47723b7f8d78c6113a6ef983b5a86e2a86f6c273e1f5cb6967b1c4467a"): REQUANTISED_0628,
    ("gigaam-v3-rnnt-q8", "130d54450be2922144b265d90d453b781fc2b5adaee52a16954b00f3686201f7"): REQUANTISED_0628,
    ("granite-4.0-1b-speech-q4", "eacd9bc06063a3fdb6bf904a2a82c2646d504922c6e4e5eb1988d61e780884d1"): REQUANTISED_0628,
    ("granite-4.0-1b-speech-q8", "1a48716efce9468bc99f33619e15942ae6a262f7ef51883c3c39b519302a533f"): REQUANTISED_0628,
    ("granite-speech-4.1-2b-plus-q4", "5d52b6bb9bc2b504120448b4da61aeb383da3c1bcfe88b22c6ed667f2520206f"): REQUANTISED_0628,
    ("granite-speech-4.1-2b-plus-q8", "a2ffe6c8db730f3eb3719ad0ac27016cad30c87b18cd33e214c7b2083e38ce10"): REQUANTISED_0628,
    ("granite-speech-4.1-2b-q4", "3171de08a99315481f0eac1979cbc0684911631d59907b2fe1e189dbcdce135f"): REQUANTISED_0628,
    ("granite-speech-4.1-2b-q8", "8c0b2dce2861feb1dba91e9d59f2ab4a9c23ad808bff86465151576e096ec7a6"): REQUANTISED_0628,
    ("granite-speech-5.0-470m-turboctc-q4", "3f30525381d72246b7f99e49b6cb66b249cf1b990c6c3d0e031a7765735f513e"): REUPLOADED_0912,
    ("granite-speech-5.0-470m-turboctc-q8", "0408fe0b33be19af5be423d8ba6b43768608b6f065e1ac97b78c84b55c140738"): REUPLOADED_0912,
    ("moonshine-base-q8", "7f0027dfd857d310b63a85ef57cadf183da712cc374f85a648f8bc18aaa2efc8"): REQUANTISED_0628,
    ("moonshine-tiny-q8", "2fd348d7b38f97d309cc3ec6848f3f57f537b80244950f07d2637e463f95a3a1"): REQUANTISED_0628,
    ("parakeet-ctc-0.6b-q4", "2a0dc545d06184b30cd3441a38811f09867a1d6b7b89f008f16bd75c1030ccdb"): REQUANTISED_0628,
    ("parakeet-ctc-0.6b-q8", "e47ae86c1b34dbaf054334592575c29aee7de3546e75d1f0ccee05904c5c49ae"): REQUANTISED_0628,
    ("parakeet-ctc-1.1b-q4", "9e4c104086067ee3afefbf7d41929024261682926cf0a57cc5a1f557fc5b69e5"): REQUANTISED_0628,
    ("parakeet-ctc-1.1b-q8", "4f66c66bdef2c6901384a218a01d8a614698010e880bbdfe44f3bcf0b11ae0f2"): REQUANTISED_0628,
    ("parakeet-rnnt-0.6b-q4", "70b32229e2b576a3be66176ebc484476f3d715d911c11a4e17167790ce378cf7"): REQUANTISED_0628,
    ("parakeet-rnnt-0.6b-q8", "06da5ba773736984e0513037b27ff9300e95c55eaa2b79dbc688efc34b25df51"): REQUANTISED_0628,
    ("parakeet-rnnt-1.1b-q4", "9e8636f491867751ca5b5c18ca91adf52014b1ae406b46516a9a8680ba1049a1"): REQUANTISED_0628,
    ("parakeet-rnnt-1.1b-q8", "e1918556aa0e2b857c12cb365cff4f33b0f1cbcc0e0769499ec38948c8363775"): REQUANTISED_0628,
    ("parakeet-tdt-0.6b-v2-q4", "4853f9653f641d376e6f7de65d73c7a34a73677704a606727bf51acc83f999f3"): REQUANTISED_0628,
    ("parakeet-tdt-0.6b-v2-q8", "f0d0e99cebb6d3b83f1f7069b82b5d3c2e39a54545b0da039cb4bafd9c4e5caa"): REQUANTISED_0628,
    ("parakeet-tdt-0.6b-v3-q4", "b68557be1e3c40207fd7c4bd9d63f1d3316b963f15325bfb0cc16a8bb0ffd181"): REQUANTISED_0628,
    ("parakeet-tdt-0.6b-v3-q8", "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7"): REQUANTISED_0628,
    ("parakeet-tdt-1.1b-q4", "38e85773763afe7b79c8538fbd091367b4644123358ea209eeb665879e3fcb13"): REQUANTISED_0628,
    ("parakeet-tdt-1.1b-q8", "8479e1ed0b7244e293ed81f547c69074a38c00e17511d8ecae2d273bc7b2ceda"): REQUANTISED_0628,
    ("parakeet-tdt_ctc-1.1b-q4", "5c27d9289e23019c459b1cef87baa5b672343733ccd3762796e68aec447169cd"): REQUANTISED_0628,
    ("parakeet-tdt_ctc-1.1b-q8", "56e826b96d0a625eb41f18d8f51d8600e8ec5959bf5278fe3929e5efefe787d6"): REQUANTISED_0628,
    ("parakeet-tdt_ctc-110m-q8", "7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296"): REQUANTISED_0628,
    ("qwen3-asr-0.6b-q4", "5b58f32a58ffa2c8783e0b0963485623e286e6272d953dfc9e28bc3447dee0c0"): REQUANTISED_0628,
    ("qwen3-asr-0.6b-q8", "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8"): REQUANTISED_0628,
    ("qwen3-asr-1.7b-q4", "b7afe3674f653fa84f712ed2440353c6e7cf7f93697fef76b05a26538b24844e"): REQUANTISED_0628,
    ("qwen3-asr-1.7b-q8", "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7"): REQUANTISED_0628,
    ("voxtral-mini-3b-2507-q4", "3a6717aa8f8989108d260cbd237584289eec43cc987e10133c33643515936205"): REQUANTISED_0628,
    ("voxtral-mini-3b-2507-q8", "06b4dd04e32953ccab0d417125bdd728ec031431596ed5e80123c3c66f29ddc2"): REQUANTISED_0628,
    ("whisper-base-q8", "81c069428bc8a24551a8169cf31cf09bcfd9d4cf50389ae281323c9aa9648c81"): REQUANTISED_0628,
    ("whisper-base.en-q8", "3b46ca40bccbf7609c68d88a36d96077a04ca7c87f2060ede06f129fac3e7652"): REQUANTISED_0628,
    ("whisper-large-q4", "7d7693afc06096de46f2a41309ac479909e131824e78dae4e205f35463aaec09"): REQUANTISED_0628,
    ("whisper-large-q8", "0b9c63f73c68327d6ba2386e40c4a4dc46a9e7114a78c93a464b48b72c001547"): REQUANTISED_0628,
    ("whisper-large-v2-q4", "76aa37b205abc1fb7a9e7aaf0655b8747995b81e6bb72c18f4b1acf59e222f79"): REQUANTISED_0628,
    ("whisper-large-v2-q8", "704603cff0f82ddd7f7f51045e12e5c8f85a37a9edec72ab10fd8ede32220702"): REQUANTISED_0628,
    ("whisper-large-v3-q4", "6fe933811cec4cd3159debc46520ecd3aac6c7e322ece2ac61fcfdab184e1fe0"): REQUANTISED_0628,
    ("whisper-large-v3-q8", "2fa1a5f179f8a511a53e2108db270aa4af3ce08cd976af4180e2854666bb4ba3"): REQUANTISED_0628,
    ("whisper-medium-q4", "6c9cad9c41d1fa0fcc624898f7ee3485b66127627878081a5655c6f6f3ce20ab"): REQUANTISED_0628,
    ("whisper-medium-q8", "09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf"): REQUANTISED_0628,
    ("whisper-medium.en-q4", "8a0eb0bb20019af88fc0ccda06d97dc949a6a0cdf35d3f2c316b967e76cd4077"): REQUANTISED_0628,
    ("whisper-medium.en-q8", "03d7257fef498750ce272631bc6a34de322fc2b438aab5c268ff49dfd1b64c49"): REQUANTISED_0628,
    ("whisper-small-q8", "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860"): REQUANTISED_0628,
    ("whisper-small.en-q8", "9614e6b7fda2d26018e4f268aece8ca25a83296ea0b534169a585b740bfd71ef"): REQUANTISED_0628,
    ("whisper-tiny-q8", "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834"): REQUANTISED_0628,
    ("whisper-tiny.en-q8", "e8c9b73c06344307d8b346e07fbe93dd88d894627854bcff31523f1ce44394fa"): REQUANTISED_0628,
}


def instant(stamp):
    """An ISO 8601 date as an aware datetime. HF writes `…000Z` and git `+08:00`; compared as strings
    the pin's `2026-10-22T21:34:40+08:00` would admit commits up to 21:34:40Z that day."""
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def pin_date(checkout):
    got = subprocess.run(["git", "-C", str(checkout), "log", "-1", "--format=%cI"], capture_output=True, text=True)
    if got.returncode != 0:
        raise SystemExit(f"cannot read {checkout}'s commit date: {got.stderr.strip()}")
    return got.stdout.strip()


def hf_json(path, attempts=3):
    """GET `HF/api/…` as (JSON, headers). urllib follows a GET's 307, so a renamed repository (MOSS)
    is read under the name it redirects to. A transient failure is retried; one that persists is
    raised."""
    request = urllib.request.Request(f"{HF}/api/{path}", headers={"User-Agent": "backchannel-catalog-walk"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response), response.headers
        except urllib.error.HTTPError as e:
            if attempt == attempts - 1 or not (e.code == 429 or e.code >= 500):
                raise SystemExit(f"HF answered {e.code} for {path}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == attempts - 1:
                raise SystemExit(f"HF could not be reached for {path}: {e}")
        time.sleep(2 * (attempt + 1))


def walk(targets, revision, date):
    """Read each target's repository: the head of `main`, and the target file at every commit dated on
    or before `date`. `targets` is `[(key, repo, filename)]`. `select` applies the date bound again,
    so its fixture test can be shown red without it."""
    by_repo = {}
    for key, repo, filename in targets:
        by_repo.setdefault(repo, []).append((key, filename))
    heads, rows = {}, {key: [] for key, _, _ in targets}
    for repo in sorted(by_repo):
        commits, page, total = [], 0, None
        while total is None or len(commits) < total:
            batch, headers = hf_json(f"models/{OWNER}/{repo}/commits/main?p={page}")
            total = int(headers["X-Total-Count"])
            if not batch:
                raise SystemExit(f"{OWNER}/{repo}: page {page} is empty at {len(commits)} of {total} commits")
            commits.extend(batch)
            page += 1
        if len(commits) != total or len({c["id"] for c in commits}) != total:
            raise SystemExit(f"{OWNER}/{repo}: read {len(commits)} commits, HF counts {total}")
        heads[repo] = {"commit": commits[0]["id"], "date": commits[0]["date"]}
        for commit in commits:
            if instant(commit["date"]) > instant(date):
                continue
            tree = {e["path"]: e for e in hf_json(f"models/{OWNER}/{repo}/tree/{commit['id']}")[0]}
            for key, filename in by_repo[repo]:
                entry = tree.get(filename)
                if entry and entry.get("lfs"):
                    rows[key].append({"commit": commit["id"], "date": commit["date"], "size": entry["size"], "sha256": entry["lfs"]["oid"]})
        print(f"  {repo}: {len(commits)} commits, head {commits[0]['id'][:10]}")
    return {"transcribe_cpp": revision, "pin_date": date, "heads": heads, "rows": rows}


def select(key, size_bytes, commits, head, pin, off_head, collisions):
    """The commit a row is pinned to, as (revision, sha256). Pure, over the recorded commits: the newest
    one dated on or before `pin` whose file is exactly `size_bytes` long, refused when none is, when it
    is not `head` and not listed, or when the eligible commits hold more than one sha256 at that size
    and the chosen one is not listed."""
    eligible = [c for c in commits if instant(c["date"]) <= instant(pin)]
    matching = [c for c in eligible if c["size"] == size_bytes]
    if not matching:
        raise SystemExit(f"{key}: no commit dated on or before {pin} holds its file at {size_bytes} bytes")
    chosen = max(matching, key=lambda c: instant(c["date"]))
    shas = sorted({c["sha256"] for c in matching})
    if len(shas) > 1 and (key, chosen["sha256"]) not in collisions:
        seen = "; ".join(f"{s[:12]} at {', '.join(c['commit'][:10] for c in matching if c['sha256'] == s)}" for s in shas)
        raise SystemExit(f"{key}: {len(shas)} different files at {size_bytes} bytes ({seen}); the newest is "
                         f"{chosen['sha256']} at {chosen['commit']}. List it in COLLISIONS with a reason, or not at all")
    if chosen["commit"] != head and (key, chosen["commit"]) not in off_head:
        raise SystemExit(f"{key}: pinned to {chosen['commit']}, which is not its repository's head {head}. "
                         "List it in OFF_HEAD with a reason")
    return chosen["commit"], chosen["sha256"], len(shas) > 1


def check_lists(pins, heads_by_key, off_head, collisions):
    """Refuse an entry that no longer applies. `pins` is key -> (revision, sha256, collided)."""
    for (key, revision), reason in off_head.items():
        if key not in pins:
            raise SystemExit(f"OFF_HEAD names {key}, which is not a row ({reason})")
        if pins[key][0] != revision:
            raise SystemExit(f"OFF_HEAD lists {key} at {revision}, but it is now pinned to {pins[key][0]}: stale ({reason})")
        if revision == heads_by_key[key]:
            raise SystemExit(f"OFF_HEAD lists {key} at {revision}, which is its repository's head again: stale ({reason})")
    for (key, sha256), reason in collisions.items():
        if key not in pins:
            raise SystemExit(f"COLLISIONS names {key}, which is not a row ({reason})")
        if not pins[key][2]:
            raise SystemExit(f"COLLISIONS lists {key}, whose file has one sha256 at its size: stale ({reason})")
        if pins[key][1] != sha256:
            raise SystemExit(f"COLLISIONS lists {key} at {sha256}, but its pin is {pins[key][1]}: stale ({reason})")


def load_revisions(path=None):
    path = HF_REVISIONS if path is None else path
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"{path} is missing — run `gen_model_catalog.py --walk` once")


def diarizer_size(records):
    for record in records.values():
        for download in record.get("downloads", []):
            if download["filename"] == DIARIZER_FILE:
                return record["published_repo"].split("/")[1], download["size_bytes"]
    raise SystemExit(f"no catalogue record publishes {DIARIZER_FILE}")


def report(key, size_bytes, commits, pin, head):
    """Print the rule's choice for one row; for a collision, every sha256 at that size and its commits."""
    revision, sha256, collided = pin
    where = "head" if revision == head else f"off head {head[:10]}"
    print(f"  {key}: {revision} ({where}), {size_bytes} bytes, sha256 {sha256}")
    if collided:
        for sha in sorted({c["sha256"] for c in commits if c["size"] == size_bytes}):
            at = ", ".join(f"{c['commit'][:10]} {c['date'][:10]}" for c in commits if c["size"] == size_bytes and c["sha256"] == sha)
            print(f"      {'chosen' if sha == sha256 else 'older '} {sha} at {at}")


def pin_rows(targets, revisions, off_head, collisions, verbose=False):
    """Select every target's pin from a recorded walk, then refuse a list entry that no longer applies.
    `targets` is `[(key, repo, size_bytes)]`; returns key -> (revision, sha256, collided)."""
    pins, heads_by_key = {}, {}
    for key, repo, size_bytes in targets:
        if key not in revisions["rows"]:
            raise SystemExit(f"{key} is not in {HF_REVISIONS.name} — run `--walk` again")
        head = revisions["heads"][repo]["commit"]
        heads_by_key[key] = head
        pins[key] = select(key, size_bytes, revisions["rows"][key], head, revisions["pin_date"], off_head, collisions)
        if verbose:
            report(key, size_bytes, revisions["rows"][key], pins[key], head)
    check_lists(pins, heads_by_key, off_head, collisions)
    return pins


def pin_all(entries, records, revisions, off_head=None, collisions=None, verbose=False):
    """Pin every entry and the diarizer from the recorded walk. Returns the diarizer's pin."""
    off_head = OFF_HEAD if off_head is None else off_head
    collisions = COLLISIONS if collisions is None else collisions
    if revisions["transcribe_cpp"] != pinned_revision():
        raise SystemExit(f"{HF_REVISIONS.name} was walked for transcribe.cpp {revisions['transcribe_cpp']}, "
                         f"but Cargo.lock pins {pinned_revision()} — run `--walk` again")
    diar_repo, diar_bytes = diarizer_size(records)
    targets = [(e["name"], e["hf_repo"], e["size_bytes"]) for e in entries] + [(DIARIZER_KEY, diar_repo, diar_bytes)]
    pins = pin_rows(targets, revisions, off_head, collisions, verbose)
    for e in entries:
        e["revision"], e["sha256"] = pins[e["name"]][:2]
    revision, sha256, _ = pins[DIARIZER_KEY]
    return {"hf_repo": diar_repo, "filename": DIARIZER_FILE, "revision": revision, "size_bytes": diar_bytes, "sha256": sha256}


def generate(records, hold=None, revisions=None):
    """The catalogue's entries, pinned. The diarizer's pin is `generate_with_diarizer`'s second value."""
    return generate_with_diarizer(records, hold, revisions)[0]


def generate_with_diarizer(records, hold=None, revisions=None, verbose=False):
    entries = []
    for record in records.values():
        entries.extend(entries_for(record))
    # Recommended-first ordering is a UI concern; keep the file deterministic.
    entries.sort(key=lambda e: (not e["native"], e["name"]))
    entries = apply_holds(entries, hold)
    diarizer = pin_all(entries, records, load_revisions() if revisions is None else revisions, verbose=verbose)
    return entries, diarizer


def rust_mark(mark, revenue_usd):
    if mark == "none":
        return "LicenceMark::None"
    if mark == "non_commercial":
        return "LicenceMark::NonCommercial"
    if mark == "revenue_limit":
        return f"LicenceMark::RevenueLimit {{ usd: {revenue_usd:_} }}"
    raise SystemExit(f"unknown licence mark {mark!r}")


def render(entries):
    lines = [BEGIN]
    for e in entries:
        lines.append("    TranscribeModel {\n")
        lines.append(f'        name: "{e["name"]}",\n')
        lines.append(f'        family: "{e["family"]}",\n')
        lines.append(f'        hf_repo: "{e["hf_repo"]}",\n')
        lines.append(f'        filename: "{e["filename"]}",\n')
        lines.append(f'        size_mb: {e["size_mb"]},\n')
        lines.append(f'        revision: "{e["revision"]}",\n')
        lines.append(f'        size_bytes: {e["size_bytes"]},\n')
        lines.append(f'        sha256: "{e["sha256"]}",\n')
        lines.append(f'        accuracy: "{e["accuracy"]}",\n')
        wer = "None" if e["wer"] is None else f'Some({e["wer"]:.2f})'
        lines.append(f"        wer: {wer},\n")
        lines.append(f'        wer_set: "{e["wer_set"]}",\n')
        lines.append(f'        speed: "{e["speed"]}",\n')
        lines.append(f'        streaming: {"true" if e["streaming"] else "false"},\n')
        codes = ", ".join(f'"{c}"' for c in e["languages"])
        lines.append(f"        languages: &[{codes}],\n")
        lines.append(f'        license: "{e["license"]}",\n')
        lines.append(f'        license_name: "{e["license_name"]}",\n')
        lines.append(f'        license_url: "{e["license_url"]}",\n')
        lines.append(f"        license_mark: {rust_mark(e['license_mark'], e['license_revenue_usd'])},\n")
        lines.append(f'        upstream_repo: "{e["upstream_repo"]}",\n')
        lines.append(f'        description: "{e["description"]}",\n')
        lines.append("    },\n")
    lines.append(END)
    return "".join(lines)


def render_diarizer_pin(pin):
    return (PIN_BEGIN
            + f'    revision: "{pin["revision"]}",\n'
            + f'    size_bytes: {pin["size_bytes"]},\n'
            + f'    sha256: "{pin["sha256"]}",\n'
            + PIN_END)


def download_url(repo, revision, filename):
    """The URL the engine's `file_url` builds for a row; the Rust test holds the two to one form."""
    return f"{HF}/{OWNER}/{repo}/resolve/{revision}/{filename}"


def render_urls(entries, diarizer):
    """Every URL the application downloads, one per row in catalogue order and the diarizer last, with
    the size and sha256 the download must have. `test_every_download_url_resolves` reads only this."""
    rows = [(e["hf_repo"], e["revision"], e["filename"], e["size_bytes"], e["sha256"]) for e in entries]
    rows.append((diarizer["hf_repo"], diarizer["revision"], diarizer["filename"], diarizer["size_bytes"], diarizer["sha256"]))
    return "".join(f"{download_url(r, v, f)}\t{n}\t{s}\n" for r, v, f, n, s in rows)


def main():
    args = sys.argv[1:]
    walking = "--walk" in args
    args = [a for a in args if a != "--walk"]
    revision = pinned_revision()
    checkout = verified(Path(args[0]) if args else find_checkout(revision), revision)
    print(f"reading {checkout}/catalog at {revision}")
    records = load_records(checkout)
    if walking:
        entries = []
        for record in records.values():
            entries.extend(entries_for(record))
        diar_repo, _ = diarizer_size(records)
        targets = [(e["name"], e["hf_repo"], e["filename"]) for e in entries] + [(DIARIZER_KEY, diar_repo, DIARIZER_FILE)]
        print(f"walking {len({t[1] for t in targets})} repositories on {HF}")
        record = walk(targets, revision, pin_date(checkout))
        HF_REVISIONS.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {HF_REVISIONS}")
    entries, diarizer = generate_with_diarizer(records, verbose=True)

    source = CONFIG_RS.read_text(encoding="utf-8")
    start, end = source.index(BEGIN), source.index(END) + len(END)
    source = source[:start] + render(entries) + source[end:]
    start, end = source.index(PIN_BEGIN), source.index(PIN_END) + len(PIN_END)
    CONFIG_RS.write_text(source[:start] + render_diarizer_pin(diarizer) + source[end:], encoding="utf-8")
    DOWNLOAD_URLS.write_text(render_urls(entries, diarizer), encoding="utf-8")
    off = sum(1 for (k, _r) in OFF_HEAD)
    print(f"pinned {len(entries)} rows and the diarizer; {off} off head, {len(COLLISIONS)} collisions listed")

    live = sum(1 for e in entries if e["streaming"])
    print(f"{len(entries)} entries written to {CONFIG_RS} ({live} live-capable)")
    print(f"skipped by name: {', '.join(sorted(EXCLUDED))}")


if __name__ == "__main__":
    main()

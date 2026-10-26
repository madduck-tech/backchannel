#!/usr/bin/env python3
"""Regenerate TRANSCRIBE_MODEL_CATALOG in src/config.rs from transcribe.cpp's catalogue.

transcribe.cpp ships a machine-readable catalogue, `catalog/*.json` (schema
`transcribe-catalog-v1`): per variant, every published GGUF with its exact
`size_bytes`, the languages the port advertises, its licence, and accuracy
benchmarks by dataset, split, language and quantisation. That is every column
the catalog needs, so the catalog is generated rather than hand-typed. (#175)

Usage:
    python3 scripts/gen_model_catalog.py [path/to/transcribe.cpp checkout]

With no argument it finds cargo's checkout of the revision Cargo.lock pins. A
checkout at any other revision, found or given, is refused: regenerating from
the wrong one reproduces a stale catalogue and every "rows that changed" check
then passes vacuously. Rewrites only the region between the GENERATED markers
in src/config.rs.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_RS = REPO_ROOT / "src" / "config.rs"
CARGO_LOCK = REPO_ROOT.parent.parent / "Cargo.lock"
BEGIN = "    // BEGIN GENERATED — see scripts/gen_model_catalog.py\n"
END = "    // END GENERATED\n"

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
    # Community License asks for registration and ends above US$1M in annual
    # revenue. The English moonshine rows are MIT and stay.
    **{
        f"moonshine-{size}-{lang}": "Moonshine AI Community License, excluded by decision, ADR 0030"
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
    key = licence_key(record.get("license"))
    if key not in LICENCES:
        raise SystemExit(
            f"{record.get('variant')}: its licence {key!r} has not been read. Read it, add it to "
            f"LICENCES with its mark, and record the reading (ADR 0030)."
        )
    return LICENCES[key]

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


def generate(records, hold=None):
    entries = []
    for record in records.values():
        entries.extend(entries_for(record))
    # Recommended-first ordering is a UI concern; keep the file deterministic.
    entries.sort(key=lambda e: (not e["native"], e["name"]))
    return apply_holds(entries, hold)


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


def main():
    revision = pinned_revision()
    checkout = verified(Path(sys.argv[1]) if len(sys.argv) > 1 else find_checkout(revision), revision)
    print(f"reading {checkout}/catalog at {revision}")
    entries = generate(load_records(checkout))

    source = CONFIG_RS.read_text(encoding="utf-8")
    start, end = source.index(BEGIN), source.index(END) + len(END)
    CONFIG_RS.write_text(source[:start] + render(entries) + source[end:], encoding="utf-8")

    live = sum(1 for e in entries if e["streaming"])
    print(f"{len(entries)} entries written to {CONFIG_RS} ({live} live-capable)")
    print(f"skipped by name: {', '.join(sorted(EXCLUDED))}")


if __name__ == "__main__":
    main()

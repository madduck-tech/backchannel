"""Tests for gen_model_catalog.py, over the committed catalog and upstream's records at the pin. (#175)

Run from the repository root, as Stage 1 and CI do:

    python3 -I -m unittest discover -s frontend/src-tauri/scripts -p 'test_*.py'

Everything here reads the transcribe.cpp checkout cargo made for Cargo.lock's revision. Its absence
fails the run rather than skipping it: a test that returns early on a missing input reads as a pass.
"""

import concurrent.futures
import http.client
import json
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

import gen_model_catalog as gen

REVISION = gen.pinned_revision()
CHECKOUT = gen.verified(gen.find_checkout(REVISION), REVISION)
RECORDS = gen.load_records(CHECKOUT)
CONFIG = gen.CONFIG_RS.read_text(encoding="utf-8")

# Every row name before #175. Each stays a row unless it is named in LEAVERS, with its reason
# and a test that fails while it is present (ADR 0023): a row's name is a storage key.
NAMES_BEFORE_175 = [
    "canary-180m-flash-q8",
    "canary-1b-flash-q4",
    "canary-1b-flash-q8",
    "canary-1b-q4",
    "canary-1b-q8",
    "canary-1b-v2-q4",
    "canary-1b-v2-q8",
    "canary-qwen-2.5b-q4",
    "canary-qwen-2.5b-q8",
    "cohere-transcribe-03-2026-q4",
    "cohere-transcribe-03-2026-q8",
    "fun-asr-mlt-nano-2512-q4",
    "fun-asr-mlt-nano-2512-q8",
    "fun-asr-nano-2512-q4",
    "fun-asr-nano-2512-q8",
    "gigaam-v3-ctc-q8",
    "gigaam-v3-e2e-ctc-q8",
    "gigaam-v3-e2e-rnnt-q8",
    "gigaam-v3-rnnt-q8",
    "granite-4.0-1b-speech-q4",
    "granite-4.0-1b-speech-q8",
    "granite-speech-4.1-2b-nar-q4",
    "granite-speech-4.1-2b-nar-q8",
    "granite-speech-4.1-2b-plus-q4",
    "granite-speech-4.1-2b-plus-q8",
    "granite-speech-4.1-2b-q4",
    "granite-speech-4.1-2b-q8",
    "moonshine-base-q8",
    "moonshine-streaming-medium-q8",
    "moonshine-streaming-small-q8",
    "moonshine-streaming-tiny-q8",
    "moonshine-tiny-q8",
    "moss-transcribe-diarize-q4",
    "moss-transcribe-diarize-q8",
    "multitalker-parakeet-streaming-0.6b-v1-q4",
    "multitalker-parakeet-streaming-0.6b-v1-q8",
    "nemotron-3.5-asr-streaming-0.6b-q4",
    "nemotron-3.5-asr-streaming-0.6b-q8",
    "nemotron-speech-streaming-en-0.6b-q4",
    "nemotron-speech-streaming-en-0.6b-q8",
    "parakeet-ctc-0.6b-q4",
    "parakeet-ctc-0.6b-q8",
    "parakeet-ctc-1.1b-q4",
    "parakeet-ctc-1.1b-q8",
    "parakeet-rnnt-0.6b-q4",
    "parakeet-rnnt-0.6b-q8",
    "parakeet-rnnt-1.1b-q4",
    "parakeet-rnnt-1.1b-q8",
    "parakeet-tdt-0.6b-v2-q4",
    "parakeet-tdt-0.6b-v2-q8",
    "parakeet-tdt-0.6b-v3-q4",
    "parakeet-tdt-0.6b-v3-q8",
    "parakeet-tdt-1.1b-q4",
    "parakeet-tdt-1.1b-q8",
    "parakeet-tdt_ctc-1.1b-q4",
    "parakeet-tdt_ctc-1.1b-q8",
    "parakeet-tdt_ctc-110m-q8",
    "parakeet-unified-en-0.6b-q4",
    "parakeet-unified-en-0.6b-q8",
    "qwen3-asr-0.6b-q4",
    "qwen3-asr-0.6b-q8",
    "qwen3-asr-1.7b-q4",
    "qwen3-asr-1.7b-q8",
    "sensevoicesmall-q8",
    "voxtral-mini-3b-2507-q4",
    "voxtral-mini-3b-2507-q8",
    "voxtral-mini-4b-realtime-2602-q4",
    "voxtral-mini-4b-realtime-2602-q8",
    "whisper-base-q8",
    "whisper-base.en-q8",
    "whisper-large-q4",
    "whisper-large-q8",
    "whisper-large-v2-q4",
    "whisper-large-v2-q8",
    "whisper-large-v3-q4",
    "whisper-large-v3-q8",
    "whisper-large-v3-turbo-q4",
    "whisper-large-v3-turbo-q8",
    "whisper-medium-q4",
    "whisper-medium-q8",
    "whisper-medium.en-q4",
    "whisper-medium.en-q8",
    "whisper-small-q8",
    "whisper-small.en-q8",
    "whisper-tiny-q8",
    "whisper-tiny.en-q8",
]
LEAVERS = {}

# Every repository a row downloads from: those before #175, plus each one #175 added, which was
# decoded on the CPU before it was listed (#175 condition 5; the decodes are in its verdict).
REPOSITORIES_BEFORE_175 = [
    "Fun-ASR-MLT-Nano-2512-gguf",
    "Fun-ASR-Nano-2512-gguf",
    "MOSS-Transcribe-Diarize-gguf",
    "Qwen3-ASR-0.6B-gguf",
    "Qwen3-ASR-1.7B-gguf",
    "SenseVoiceSmall-gguf",
    "Voxtral-Mini-3B-2507-gguf",
    "Voxtral-Mini-4B-Realtime-2602-gguf",
    "canary-180m-flash-gguf",
    "canary-1b-flash-gguf",
    "canary-1b-gguf",
    "canary-1b-v2-gguf",
    "canary-qwen-2.5b-gguf",
    "cohere-transcribe-03-2026-gguf",
    "gigaam-v3-ctc-gguf",
    "gigaam-v3-e2e-ctc-gguf",
    "gigaam-v3-e2e-rnnt-gguf",
    "gigaam-v3-rnnt-gguf",
    "granite-4.0-1b-speech-gguf",
    "granite-speech-4.1-2b-gguf",
    "granite-speech-4.1-2b-nar-gguf",
    "granite-speech-4.1-2b-plus-gguf",
    "moonshine-base-gguf",
    "moonshine-streaming-medium-gguf",
    "moonshine-streaming-small-gguf",
    "moonshine-streaming-tiny-gguf",
    "moonshine-tiny-gguf",
    "multitalker-parakeet-streaming-0.6b-v1-gguf",
    "nemotron-3.5-asr-streaming-0.6b-gguf",
    "nemotron-speech-streaming-en-0.6b-gguf",
    "parakeet-ctc-0.6b-gguf",
    "parakeet-ctc-1.1b-gguf",
    "parakeet-rnnt-0.6b-gguf",
    "parakeet-rnnt-1.1b-gguf",
    "parakeet-tdt-0.6b-v2-gguf",
    "parakeet-tdt-0.6b-v3-gguf",
    "parakeet-tdt-1.1b-gguf",
    "parakeet-tdt_ctc-1.1b-gguf",
    "parakeet-tdt_ctc-110m-gguf",
    "parakeet-unified-en-0.6b-gguf",
    "whisper-base-gguf",
    "whisper-base.en-gguf",
    "whisper-large-gguf",
    "whisper-large-v2-gguf",
    "whisper-large-v3-gguf",
    "whisper-large-v3-turbo-gguf",
    "whisper-medium-gguf",
    "whisper-medium.en-gguf",
    "whisper-small-gguf",
    "whisper-small.en-gguf",
    "whisper-tiny-gguf",
    "whisper-tiny.en-gguf",
]
REPOSITORIES_ADDED_BY_175 = [
    "Breeze-ASR-25-gguf",
    "cohere-transcribe-arabic-07-2026-gguf",
    "granite-speech-5.0-470m-turboctc-gguf",
    "parakeet-primeline-gguf",
    "parakeet-ultra-gguf",
]


def mark_of(rust):
    """A rendered `LicenceMark` as the generator's (mark, revenue) pair."""
    if rust == "LicenceMark::None":
        return ("none", None)
    if rust == "LicenceMark::NonCommercial":
        return ("non_commercial", None)
    m = re.fullmatch(r"LicenceMark::RevenueLimit \{ usd: ([0-9_]+) \}", rust)
    return ("revenue_limit", int(m[1].replace("_", ""))) if m else None


def committed_rows():
    """The committed catalog's rows, field by field, as the generator wrote them."""
    region = CONFIG[CONFIG.index(gen.BEGIN) : CONFIG.index(gen.END)]
    rows = []
    for block in re.findall(r"TranscribeModel \{\n(.*?)\n    \},", region, re.S):
        fields = dict(re.findall(r"^\s+(\w+): (.*),$", block, re.M))
        wer = fields["wer"]
        rows.append(
            {
                "name": fields["name"].strip('"'),
                "hf_repo": fields["hf_repo"].strip('"'),
                "filename": fields["filename"].strip('"'),
                "size_mb": int(fields["size_mb"]),
                "wer": None if wer == "None" else float(wer[len("Some(") : -1]),
                "wer_set": fields["wer_set"].strip('"'),
                "upstream_repo": fields["upstream_repo"].strip('"'),
                "licence": (fields["license_name"].strip('"'), fields["license_url"].strip('"'), mark_of(fields["license_mark"])),
            }
        )
    return rows


ROWS = committed_rows()


def record_of(row):
    """The record and download a row comes from, joined on repository and filename."""
    for record in RECORDS.values():
        if record["published_repo"] != f"{gen.OWNER}/{row['hf_repo']}":
            continue
        for download in record["downloads"]:
            if download["filename"] == row["filename"]:
                return record, download
    return None, None


class TheSource(unittest.TestCase):
    def test_the_checkout_is_found_by_its_revision_not_by_sort_order(self):
        # Two checkouts side by side, as on a machine that built both pins. Sorting the names picks
        # "553f109", which is greater than "4d7c1cc" and is the older pin.
        with tempfile.TemporaryDirectory() as home:
            for short in ("553f109", "4d7c1cc"):
                (Path(home) / "git" / "checkouts" / "transcribe.cpp-0f9edbe501cad03c" / short).mkdir(parents=True)
            found = gen.find_checkout("4d7c1cc" + "0" * 33, cargo_home=home)
            self.assertEqual(found.name, "4d7c1cc")

    def test_a_checkout_at_another_revision_is_refused_naming_both(self):
        other = "553f1099a2b3a5bc4421894be171f09960fc0f3a"
        with self.assertRaises(SystemExit) as refused:
            gen.verified(Path("/checkout"), REVISION, revision_of=lambda _: other)
        self.assertIn(other, str(refused.exception))
        self.assertIn(REVISION, str(refused.exception))

    def test_an_explicit_checkout_at_another_revision_is_refused_before_anything_is_read(self):
        """The generator run on a path, as `gen_model_catalog.py <checkout>`, with a real git repository at
        another revision: refused for its revision, by git's own answer, before `catalog/` is read."""
        with tempfile.TemporaryDirectory() as checkout:
            git = lambda *a: subprocess.run(["git", "-C", checkout, *a], check=True, capture_output=True, text=True).stdout.strip()
            git("init", "-q")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "another revision")
            head = git("rev-parse", "HEAD")
            before = gen.CONFIG_RS.read_text(encoding="utf-8")
            with mock.patch.object(sys, "argv", ["gen_model_catalog.py", checkout]), self.assertRaises(SystemExit) as refused:
                gen.main()
            self.assertIn(head, str(refused.exception))
            self.assertIn("Cargo.lock pins", str(refused.exception))
            self.assertEqual(gen.CONFIG_RS.read_text(encoding="utf-8"), before)

    def test_two_lock_entries_at_different_revisions_are_refused(self):
        entry = 'name = "transcribe-cpp"\nversion = "0.4.1"\nsource = "git+https://github.com/handy-computer/transcribe.cpp?rev={0}#{0}"\n'
        with self.assertRaises(SystemExit):
            gen.pinned_revision(entry.format("4d7c1cc" + "0" * 33) + entry.format("553f109" + "0" * 33))
        self.assertEqual(gen.pinned_revision(entry.format("4d7c1cc" + "0" * 33) * 2), "4d7c1cc" + "0" * 33)

    def test_the_committed_catalog_is_what_the_records_generate(self):
        """The committed array, the diarizer's pin and the download list are the generator's output from
        the records and the committed walk alone, so no card, header or hand edit contributes to them.
        Offline: the pins are selected from `hf_revisions.json`, and its two lists are applied (#179)."""
        entries, diarizer = gen.generate_with_diarizer(RECORDS)
        region = CONFIG[CONFIG.index(gen.BEGIN) : CONFIG.index(gen.END) + len(gen.END)]
        self.assertEqual(region, gen.render(entries), "the catalogue region of config.rs")
        pin = CONFIG[CONFIG.index(gen.PIN_BEGIN) : CONFIG.index(gen.PIN_END) + len(gen.PIN_END)]
        self.assertEqual(pin, gen.render_diarizer_pin(diarizer), "the diarizer's pin in config.rs")
        self.assertEqual(gen.DOWNLOAD_URLS.read_text(encoding="utf-8"), gen.render_urls(entries, diarizer), "download_urls.tsv")


# The pinned transcribe.cpp commit's date as git prints it, and a commit HF dates seven hours earlier
# by the clock but after it as an instant: 14:00Z is after 13:34:40Z, and before "21:34:40" as text.
PIN = "2026-10-22T21:34:40+08:00"
AFTER_THE_PIN = "2026-10-22T14:00:00.000Z"
SIZE = 1000


def commit(name, date, sha="a" * 64, size=SIZE):
    """A recorded commit: `name` padded to 40 characters, as a revision is."""
    return {"commit": name.ljust(40, "0"), "date": date, "size": size, "sha256": sha}


def walked(rows, heads):
    """A recorded walk over fixture rows. `rows` is key -> commits; `heads` is key -> the head commit's
    name. Each key is its own repository."""
    return {
        "pin_date": PIN,
        "rows": rows,
        "heads": {key: {"commit": name.ljust(40, "0"), "date": "2026-10-29T00:00:00.000Z"} for key, name in heads.items()},
    }


def pins(rows, heads, off_head=None, collisions=None):
    targets = [(key, key, SIZE) for key in rows]
    return gen.pin_rows(targets, walked(rows, heads), off_head or {}, collisions or {})


class TheSelection(unittest.TestCase):
    """The rule over recorded fixtures (#179 condition 2). Each refusal is asserted by its own message."""

    def test_the_date_bound_is_compared_as_instants(self):
        """The newest commit holding the file is after the pin, so the older one is chosen. Deleting the
        date filter chooses the later one, and so does comparing the two dates as strings. The pure
        selection alone, so the list checks after it cannot answer first."""
        commits = [commit("later", AFTER_THE_PIN), commit("older", "2026-10-01T00:00:00.000Z")]
        older = "older".ljust(40, "0")
        got = gen.select("row", SIZE, commits, "later".ljust(40, "0"), PIN, {("row", older): "fixture"}, {})
        self.assertEqual(got[0], older)

    def test_no_commit_at_the_size_is_refused(self):
        rows = {"row": [commit("other", "2026-10-01T00:00:00.000Z", size=SIZE + 1)]}
        with self.assertRaisesRegex(SystemExit, r"^row: no commit dated on or before .* holds its file at 1000 bytes"):
            pins(rows, {"row": "other"})

    def test_two_files_at_the_size_unlisted_are_refused(self):
        rows = {"row": [commit("newer", "2026-10-02T00:00:00.000Z", sha="b" * 64), commit("older", "2026-10-01T00:00:00.000Z")]}
        with self.assertRaisesRegex(SystemExit, r"^row: 2 different files at 1000 bytes .*List it in COLLISIONS"):
            pins(rows, {"row": "newer"})

    def test_a_listed_collision_is_accepted_by_its_bytes_not_its_revision(self):
        """(w): the entry names the newest bytes. It still approves them when a later commit holding the
        same bytes becomes head, which an entry keyed by revision would not. Listed oldest first, so
        "newest" is chosen by date, not by the order the walk recorded."""
        listed = {("row", "b" * 64): "fixture"}
        rows = {"row": [commit("older", "2026-10-01T00:00:00.000Z"), commit("newer", "2026-10-02T00:00:00.000Z", sha="b" * 64)]}
        self.assertEqual(pins(rows, {"row": "newer"}, collisions=listed)["row"][:2], ("newer".ljust(40, "0"), "b" * 64))
        rows["row"].append(commit("card", "2026-10-03T00:00:00.000Z", sha="b" * 64))
        self.assertEqual(pins(rows, {"row": "card"}, collisions=listed)["row"][:2], ("card".ljust(40, "0"), "b" * 64))

    def test_a_collision_entry_for_a_row_with_one_file_is_stale(self):
        """(x)"""
        rows = {"row": [commit("only", "2026-10-01T00:00:00.000Z")]}
        with self.assertRaisesRegex(SystemExit, r"^COLLISIONS lists row, whose file has one sha256 at its size: stale"):
            pins(rows, {"row": "only"}, collisions={("row", "a" * 64): "fixture"})

    def test_a_collision_entry_for_other_bytes_is_stale_beside_the_right_one(self):
        """(y): the older bytes listed first, the chosen ones after."""
        rows = {"row": [commit("newer", "2026-10-02T00:00:00.000Z", sha="b" * 64), commit("older", "2026-10-01T00:00:00.000Z")]}
        listed = {("row", "a" * 64): "the older bytes", ("row", "b" * 64): "the chosen bytes"}
        with self.assertRaisesRegex(SystemExit, rf"^COLLISIONS lists row at {'a' * 64}, but its pin is {'b' * 64}: stale"):
            pins(rows, {"row": "newer"}, collisions=listed)

    def test_an_off_head_entry_for_a_row_back_on_head_is_stale(self):
        rows = {"row": [commit("head", "2026-10-01T00:00:00.000Z")]}
        with self.assertRaisesRegex(SystemExit, rf"^OFF_HEAD lists row at {'head'.ljust(40, '0')}, which is its repository's head again: stale"):
            pins(rows, {"row": "head"}, off_head={("row", "head".ljust(40, "0")): "fixture"})

    def test_an_off_head_entry_at_another_revision_is_stale_beside_the_right_one(self):
        """(t): the earlier revision listed first, the one now chosen after it."""
        rows = {"row": [commit("chosen", "2026-10-02T00:00:00.000Z"), commit("earlier", "2026-10-01T00:00:00.000Z", size=SIZE + 1)]}
        listed = {("row", "earlier".ljust(40, "0")): "an old pin", ("row", "chosen".ljust(40, "0")): "the pin"}
        with self.assertRaisesRegex(SystemExit, rf"^OFF_HEAD lists row at {'earlier'.ljust(40, '0')}, but it is now pinned to {'chosen'.ljust(40, '0')}: stale"):
            pins(rows, {"row": "head"}, off_head=listed)


class TheWalk(unittest.TestCase):
    """`walk` over a fake Hugging Face API (#179's gate adversary): what it records is what `select` reads."""

    def test_the_walk_records_every_eligible_lfs_file_across_pages(self):
        dates = ["2026-10-25T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-10T00:00:00.000Z",
                 "2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]
        commits = [{"id": f"c{i}".ljust(40, "0"), "date": d} for i, d in enumerate(dates)]
        lfs = lambda sha: {"path": "f.gguf", "size": SIZE, "lfs": {"oid": sha}}
        trees = {
            "c0": [lfs("0" * 64)],                         # after the pin
            "c1": [lfs("1" * 64), {"path": "README.md", "size": 10}],
            "c2": [{"path": "f.gguf", "size": SIZE}],      # the file is not in LFS here
            "c3": [{"path": "README.md", "size": 10}],     # the file is absent
            "c4": [lfs("4" * 64)],
        }
        asked = []

        def fake(path, attempts=3):
            asked.append(path)
            if "/commits/main?p=" in path:
                page = int(path.rsplit("p=", 1)[1])
                return commits[page * 2 : page * 2 + 2], {"X-Total-Count": str(len(commits))}
            return trees[path.rsplit("/tree/", 1)[1][:2]], {}

        with mock.patch.object(gen, "hf_json", fake), mock.patch("builtins.print"):
            record = gen.walk([("row", "repo", "f.gguf")], "r" * 40, PIN)
        self.assertEqual(record["heads"], {"repo": {"commit": commits[0]["id"], "date": dates[0]}})
        self.assertEqual(
            [(c["commit"][:2], c["sha256"][:1]) for c in record["rows"]["row"]],
            [("c1", "1"), ("c4", "4")],
            "the walk recorded other commits than the eligible ones holding the file in LFS",
        )
        self.assertEqual(sum("/commits/main" in p for p in asked), 3, "the walk did not read every page")
        self.assertEqual((record["transcribe_cpp"], record["pin_date"]), ("r" * 40, PIN))

    def test_a_record_walked_for_another_transcribe_cpp_is_refused(self):
        entries = []
        for record in RECORDS.values():
            entries.extend(gen.entries_for(record))
        revisions = dict(gen.load_revisions(), transcribe_cpp="0" * 40)
        with self.assertRaisesRegex(SystemExit, r"was walked for transcribe\.cpp 0{40}, but Cargo\.lock pins"):
            gen.pin_all(entries, RECORDS, revisions)


class TheUnit(unittest.TestCase):
    def test_every_size_is_decimal_mb_of_its_bytes_unless_held(self):
        wrong = []
        for row in ROWS:
            _, download = record_of(row)
            if download is None:
                wrong.append(f"{row['name']}: no record")
                continue
            held = gen.HOLD.get(row["name"])
            expected = held[1] if held else round(download["size_bytes"] / 1_000_000)
            if row["size_mb"] != expected:
                wrong.append(f"{row['name']}: size_mb {row['size_mb']}, expected {expected} for {download['size_bytes']} bytes")
        self.assertEqual(wrong, [])

    def test_a_hold_is_refused_once_its_file_changed_or_its_row_is_gone(self):
        entries = gen.generate(RECORDS, hold={})
        name = "multitalker-parakeet-streaming-0.6b-v1-q8"
        real = next(e for e in entries if e["name"] == name)["size_bytes"]
        with self.assertRaises(SystemExit):
            gen.apply_holds([dict(e) for e in entries], {name: (real + 1, 734, "a changed file")})
        with self.assertRaises(SystemExit):
            gen.apply_holds([dict(e) for e in entries], {"no-such-row-q8": (real, 734, "a gone row")})

    def test_the_q4_threshold_reads_decimal_mb(self):
        # granite-5.0's Q8 is 505.6 MB but 482.2 MiB: its Q4 exists only under decimal MB.
        self.assertIn("granite-speech-5.0-470m-turboctc-q4", {r["name"] for r in ROWS})


class TheNames(unittest.TestCase):
    def test_every_name_before_175_is_still_a_row(self):
        missing = sorted(set(NAMES_BEFORE_175) - {r["name"] for r in ROWS} - set(LEAVERS))
        self.assertEqual(missing, [])


class TheWordErrorRate(unittest.TestCase):
    def test_every_row_carries_upstreams_benchmark_on_its_set(self):
        """Every row's WER is the record's own, at the row's quantisation, on LibriSpeech test-clean or
        on the set its family names; a missing one fails, and the covered count is every row."""
        labels = {label: key for key, label in gen.SET_LABELS.items()}
        wrong, covered = [], 0
        for row in ROWS:
            record, download = record_of(row)
            if record is None:
                wrong.append(f"{row['name']}: no record")
                continue
            family, _ = gen.family_of(row["name"])
            wanted = gen.FAMILY_SETS.get(family, gen.DEFAULT_SET)
            published = gen.benchmark_wer(record, download["quant"], wanted)
            if published is None:
                wrong.append(f"{row['name']}: the record publishes no {download['quant']} WER on {wanted}")
                continue
            covered += 1
            if row["wer"] is None or round(row["wer"], 2) != round(published, 2):
                wrong.append(f"{row['name']}: wer {row['wer']}, the record says {published}")
            if labels.get(row["wer_set"]) != wanted:
                wrong.append(f"{row['name']}: wer_set {row['wer_set']!r}, the record's set is {wanted}")
        self.assertEqual(wrong, [])
        self.assertEqual(covered, len(ROWS), f"covered {covered} of {len(ROWS)} rows")
        self.assertGreater(covered, 0)


def diarizer_licence():
    block = CONFIG[CONFIG.index("pub const SPEAKER_DIARIZER: DiarizerModel") :]
    block = block[: block.index("};")]
    field = lambda name: re.search(rf"^\s+{name}: (.*),$", block, re.M)[1]
    return field("license_name").strip('"'), field("license_url").strip('"'), mark_of(field("license_mark")), field("upstream_repo").strip('"')


class TheLicences(unittest.TestCase):
    """#197, ADR 0030: every licence is read before a row ships, and the diarizer's is its record's."""

    def test_an_unread_licence_stops_the_generator_naming_the_record_and_the_key(self):
        record = json.loads(json.dumps(RECORDS["canary-1b"]))
        record["license"] = {"spdx": "other", "display": "Unread Licence", "name": "unread-licence"}
        with self.assertRaises(SystemExit) as raised:
            gen.generate({"canary-1b": record}, hold={})
        self.assertIn("canary-1b", str(raised.exception))
        self.assertIn("unread-licence", str(raised.exception))

    def test_the_key_is_the_spdx_id_else_the_name_else_an_alias(self):
        self.assertEqual(gen.licence_key({"spdx": "mit", "display": "MIT"}), "mit")
        self.assertEqual(gen.licence_key({"spdx": "other", "name": "openmdw-1.1"}), "openmdw-1.1")
        self.assertEqual(gen.licence_key({"spdx": "other", "display": "NVIDIA Open Model License"}), "nvidia-open-model-license")
        self.assertIsNone(gen.licence_key({"spdx": "other", "display": "Something else"}))

    def test_every_row_carries_its_records_licence_and_repository(self):
        # Presence alone let a row credit the wrong repository, or another licence's text, with every
        # test green (#197's gate: `published_repo` written as `upstream_repo`; NVIDIA's URL swapped).
        wrong = []
        for row in ROWS:
            record, _ = record_of(row)
            name, url, mark = gen.LICENCES[gen.licence_key(record["license"])]
            if row["upstream_repo"] != record["upstream_repo"]:
                wrong.append(f"{row['name']}: upstream_repo {row['upstream_repo']}, record {record['upstream_repo']}")
            if row["licence"] != (name, url, mark):
                wrong.append(f"{row['name']}: licence {row['licence']}, map {(name, url, mark)}")
        self.assertGreater(len(ROWS), 0)
        self.assertEqual(wrong, [])

    def test_a_known_key_linking_another_text_stops_the_generator(self):
        record = json.loads(json.dumps(RECORDS["canary-1b"]))
        record["license"]["link"] = "https://example.org/another-licence"
        with self.assertRaises(SystemExit) as raised:
            gen.generate({"canary-1b": record}, hold={})
        self.assertIn("canary-1b", str(raised.exception))
        self.assertIn("https://example.org/another-licence", str(raised.exception))

    def test_the_diarizer_carries_its_records_licence(self):
        record = RECORDS["diar_streaming_sortformer_4spk-v2.1"]
        name, url, mark = gen.LICENCES[gen.licence_key(record["license"])]
        self.assertEqual(diarizer_licence(), (name, url, mark, record["upstream_repo"]))


class TheRepositories(unittest.TestCase):
    def test_every_repository_is_listed_and_every_listed_one_is_used(self):
        self.assertEqual(
            sorted({r["hf_repo"] for r in ROWS}),
            sorted(REPOSITORIES_BEFORE_175 + REPOSITORIES_ADDED_BY_175),
        )


def diarizer():
    block = CONFIG[CONFIG.index("pub const SPEAKER_DIARIZER: DiarizerModel") :]
    return re.search(r'hf_repo: "([^"]+)"', block)[1], re.search(r'filename: "([^"]+)"', block)[1]


class _Unfollowed(urllib.request.HTTPRedirectHandler):
    """Hand every redirect back as its answer: `x-linked-*` ride on the hop that redirects to the CDN."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(_Unfollowed)


def hop(url, attempts=3):
    """One HEAD, as (status, headers), without following a redirect.

    A transient failure is retried, up to `attempts` in all, with a pause between: a connection reset or
    refusal at send or at the response (measured on 2026-10-26: Hugging Face reset one of 97 parallel
    HEADs in three runs out of ten), and a 429 or 5xx. A failure that persists is raised, or its status
    returned, never turned into a skip. Any other status is an answer, and is returned at once.
    """
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "backchannel-catalog-check"})
    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            with OPENER.open(request, timeout=60) as response:
                return response.status, response.headers
        except urllib.error.HTTPError as e:
            e.close()
            if last or not (e.code == 429 or e.code >= 500):
                return e.code, e.headers
        except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError):
            if last:
                raise
        time.sleep(2 * (attempt + 1))


def chain(url, limit=10):
    """Every hop from `url`, as (url, status, headers), each `Location` followed by hand."""
    hops = []
    while len(hops) < limit:
        status, headers = hop(url)
        hops.append((url, status, headers))
        if not (300 <= status < 400 and headers.get("Location")):
            return hops
        url = urllib.parse.urljoin(url, headers["Location"])
    raise AssertionError(f"more than {limit} redirects from {hops[0][0]}")


def final_status(url):
    """The status a HEAD ends on after following every redirect."""
    return chain(url)[-1][1]


def check_line(line):
    """What is wrong with one line of `download_urls.tsv` against Hugging Face, or None: the chain must end
    in 200, and the hop carrying `x-linked-*` must give the line's size and sha256. MOSS's first hop is a
    rename's 307 without them, so the hop is found, not assumed to be the first."""
    url, size, sha256 = line.split("\t")
    hops = chain(url)
    if hops[-1][1] != 200:
        return f"{url}: the chain ends in {hops[-1][1]}, after {len(hops)} hop(s)"
    linked = [h for _, _, h in hops if h.get("x-linked-size")]
    if not linked:
        return f"{url}: no hop carries x-linked-size"
    got_size, got_etag = linked[0]["x-linked-size"], linked[0].get("x-linked-etag", "").strip('"')
    if got_size != size:
        return f"{url}: x-linked-size {got_size}, the list says {size}"
    if got_etag != sha256:
        return f"{url}: x-linked-etag {got_etag}, the list says {sha256}"
    return None


class TheRetry(unittest.TestCase):
    def test_a_connection_dropped_at_the_response_is_retried_and_a_persistent_one_raised(self):
        import http.server
        import threading

        served = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_HEAD(self):
                served.append(self.path)
                if self.path == "/busy" and served.count("/busy") == 1:
                    self.send_response(503)  # an overloaded server, once
                    self.end_headers()
                    return
                if self.path != "/busy" and (len(served) == 1 or self.path == "/always"):
                    self.close_connection = True  # read the request, answer nothing
                    return
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{server.server_address[1]}"
            with mock.patch("time.sleep"):
                self.assertEqual(final_status(f"{base}/once"), 200)
                self.assertEqual(served, ["/once", "/once"])
                with self.assertRaises((http.client.HTTPException, ConnectionError)):
                    final_status(f"{base}/always")
                self.assertEqual(final_status(f"{base}/busy"), 200, "a 503 is retried")
        finally:
            server.shutdown()


# The summary engine's 9 files (#191). Written by hand from `summary_engine/models.rs`, which the Rust test
# `the_summary_download_list_is_what_the_engine_requests` holds it to, since the generator writes only the
# transcription catalogue's list.
SUMMARY_URLS = gen.DOWNLOAD_URLS.parent / "summary_download_urls.tsv"


class TheDownloads(unittest.TestCase):
    def test_every_download_url_resolves(self):
        """Every line of `download_urls.tsv` (#179) and of `summary_download_urls.tsv` (#191), each held by a
        Rust test to the URLs its engine builds: the file at its pinned revision is the length and sha256
        the line says, and the chain ends in 200. A network error fails this, never skips it, so every gate
        that runs it depends on Hugging Face answering."""
        texts = [gen.DOWNLOAD_URLS.read_text(encoding="utf-8"), SUMMARY_URLS.read_text(encoding="utf-8")]
        lines = [line for text in texts for line in text.splitlines()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            problems = list(pool.map(check_line, lines))
        self.assertEqual([p for p in problems if p], [])
        # Counted apart from the reader, each list read again by its own path: a reader that dropped a line,
        # or a list, would check fewer URLs.
        on_disk = sum(p.read_text(encoding="utf-8").count("\n") for p in (gen.DOWNLOAD_URLS, SUMMARY_URLS))
        self.assertEqual(len(problems), on_disk, "the URLs checked are not every line of both lists")
        self.assertEqual(len(problems), len(ROWS) + 1 + 9, "the transcription catalogue, the diarizer and the 9 summary files")


if __name__ == "__main__":
    unittest.main()

"""Tests for gen_model_catalog.py, over the committed catalog and upstream's records at the pin. (#175)

Run from the repository root, as Stage 1 and CI do:

    python3 -I -m unittest discover -s frontend/src-tauri/scripts -p 'test_*.py'

Everything here reads the transcribe.cpp checkout cargo made for Cargo.lock's revision. Its absence
fails the run rather than skipping it: a test that returns early on a missing input reads as a pass.
"""

import concurrent.futures
import http.client
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
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
        """The committed array is the generator's output from the records alone, so no card, header
        or hand edit contributes to it."""
        region = CONFIG[CONFIG.index(gen.BEGIN) : CONFIG.index(gen.END) + len(gen.END)]
        self.assertEqual(region, gen.render(gen.generate(RECORDS)))


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


class TheRepositories(unittest.TestCase):
    def test_every_repository_is_listed_and_every_listed_one_is_used(self):
        self.assertEqual(
            sorted({r["hf_repo"] for r in ROWS}),
            sorted(REPOSITORIES_BEFORE_175 + REPOSITORIES_ADDED_BY_175),
        )


def base_url():
    return re.search(r'pub const TRANSCRIBE_MODEL_BASE_URL: &str = "([^"]+)";', CONFIG)[1]


def diarizer():
    block = CONFIG[CONFIG.index("pub const SPEAKER_DIARIZER: DiarizerModel") :]
    return re.search(r'hf_repo: "([^"]+)"', block)[1], re.search(r'filename: "([^"]+)"', block)[1]


def final_status(url, attempts=3):
    """The status a HEAD ends on after following every redirect.

    A transient failure is retried, up to `attempts` in all, with a pause between: a connection reset or
    refusal at send or at the response (measured on 2026-10-26: Hugging Face reset one of 97 parallel
    HEADs in three runs out of ten), and a 429 or 5xx. A failure that persists is raised, or its status
    returned, never turned into a skip. Any other status is an answer, and is returned at once.
    """
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "backchannel-catalog-check"})
    for attempt in range(attempts):
        last = attempt == attempts - 1
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status
        except urllib.error.HTTPError as e:
            if last or not (e.code == 429 or e.code >= 500):
                return e.code
        except (urllib.error.URLError, http.client.HTTPException, ConnectionError, TimeoutError):
            if last:
                raise
        time.sleep(2 * (attempt + 1))


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


class TheDownloads(unittest.TestCase):
    def test_every_download_url_resolves(self):
        """Every row's file and the diarizer's, at the URL the engine builds, ends on a 200. Every gate
        that runs this depends on Hugging Face answering."""
        files = [(r["hf_repo"], r["filename"]) for r in ROWS] + [diarizer()]
        urls = [f"{base_url()}/{repo}/resolve/main/{filename}" for repo, filename in files]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(final_status, urls))
        bad = [f"{status} {url}" for status, url in zip(statuses, urls) if status != 200]
        self.assertEqual(bad, [])
        self.assertEqual(len(statuses), len(ROWS) + 1)


if __name__ == "__main__":
    unittest.main()

-- Which capture channel a transcript row's audio came from: 'you' (microphone)
-- or 'others' (system audio).
--
-- Its own column rather than reusing `speaker`, because a post-hoc diarization
-- pass rewrites `speaker` on every row of a meeting (audio/diarization.rs) and
-- would erase it. `speaker` stays what a model guessed; this is what was
-- captured. NULL means the decoder could not say -- today the streaming path,
-- which is fed the two channels summed.

ALTER TABLE transcripts ADD COLUMN channel TEXT;

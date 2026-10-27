# 0030 — Every model is offered, and shows its licence

Date: 2026-10-26
Status: accepted

## Context

The model catalogue offers models under very different licences, and showed none of them (#197). Today's rows come under seven licence texts, named by eight keys: SenseVoice's `model-license` is the FunASR text. Two rows carry a mark a person must see. A third population, the summary models, adds a revenue-limited licence. Two licences ask for credit: FunASR §2.2 on use, and NVIDIA a notice on distribution.

The product owner was shown a table of each licence's terms, quoted from the texts fetched on 2026-10-26 (#197's thread; not legal advice), and decided on 2026-10-26:
1. **Nothing is removed for its licence.** Each model shows its licence where it is chosen, "non-commercial only" included, and the person decides. This was the product owner's choice of three: the others were to keep only licences that allow work use, or only Apache, MIT, CC-BY and OpenMDW.
2. **Attribution lives on a Licences screen in About** (#241), with a prototype first.
3. **`granite-speech-5.0-470m-turboctc-nc` (CC BY-NC-SA 4.0) and orukeet (CC BY-SA 4.0) are offered,** once their licence is shown (#227). **The twelve moonshine language variants stay excluded,** because their licence binds the app, not only the person. The Moonshine AI Community License asks the product itself for "Powered by Moonshine AI", requires registration for commercial use, and its use policy forbids recording people without their knowledge. The English moonshine rows are MIT.
4. **LFM2.5 2.6B gets its own mark.** Its LFM Open License v1.0, §5, leaves commercial use unlicensed for an organisation with US$10M or more in annual revenue, and "non-commercial only" would misstate that.
5. **The licence is shown wherever a model is chosen** (#227).
6. **Two readings, confirmed:**
   - FunASR §3's "for reference and learning purposes only" is a disclaimer, not a use restriction;
   - CC BY-SA's share-alike applies only to adaptations, not to the app that downloads the model.

## Decision

1. **The licence is data.** The generator holds a `LICENCES` map: one entry per licence a row or the diarizer names, and the two that #227's arriving rows name (`cc-by-sa-4.0`, `cc-by-nc-sa-4.0`), ten keys in all, keyed by the record's SPDX id, or by `license.name` when the id is "other". Each entry is the name shown, the text's `https://` URL, and a mark:
   - `none`;
   - `non_commercial`;
   - `revenue_limit` with its amount in US dollars.

   **A licence nobody has read stops the generator,** naming the record and the key. So does a known key whose record links a text other than the one read under it: upstream can reuse a generic name such as `model-license`. Excluded records, and the VAD and language-id records, are not looked up.
2. **Every row carries `license_name`, `license_url`, `license_mark` and `upstream_repo`.** The diarizer carries the same four, written by hand and held equal to its record by a generator test. Each summary model carries the licence its card names, with the card's link, and its definition names the card it was read from. LFM2.5's link is relative on its card, so its URL is the repository's `LICENSE`.
3. **The marks, held by tests over all three populations:**
   - `non_commercial` is exactly `canary-1b-q4` and `canary-1b-q8` (CC BY-NC 4.0);
   - `revenue_limit` is exactly `lfm2.5:2.6b`, at US$10 000 000.
4. **FunASR's two keys are one text.** The Fun-ASR rows' `funasr-model-license-v1.1` and SenseVoice's `model-license` both map to the FunASR Model License v1.1, unmarked. FunAudioLLM's own cards for both Fun-ASR Nano repositories say apache-2.0; the catalog's stricter licence is the one followed, and the mark is `none` under either.

## Consequences

- **A new licence in a transcribe.cpp bump stops the regeneration,** and so does a known name linking another text, until someone reads it and records the reading here or in a successor. Every row's licence and upstream repository are held equal to its record, so the Licences screen (#241) credits the right owner.
- **The data reaches no screen yet:** #227 is the surfaces and the two rows, and #241 the Licences screen.
- **Not covered:**
  - the software notices for `llama-helper`, `ffmpeg`, crates and npm packages;
  - cloud providers and agent CLIs, which download nothing;
  - legal review.

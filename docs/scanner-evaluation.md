# Scanner evaluation log

Measurements for the card scanner, so a change can be called an improvement or
not. Numbers without a harness behind them are guesses.

## Corpus

Shared, outside the repository: `~/.local/share/pokecollector/card-corpus/`
(override with `POKECOLLECTOR_CARD_CORPUS`).

| Set | Images | What it covers |
| --- | --- | --- |
| `clean/` | 60 | TCGdex reference images: 26 Japanese, the rest English, spanning 1999–2025 and Pokemon/Trainer/Energy. |
| `augmented/` | 720 | 12 degradations × 60 cards: blur, motion, glare, low light, finger over the card, far/close framing, sleeve, tilt, clutter, the combined "realistic" case. |
| `photos/` | 16 | Real phone photos: sleeves and top loaders, one empty loader, one F1 card, several multi-card pages. |

The regression run used for the figures below is a fixed 48-image subset: 24
clean and 24 augmented (one English and one Japanese image per degradation).

## Metrics

Field accuracy is the wrong target on its own: a wrong illustrator is harmless
when the card is right. Score what the product decides.

| Metric | Meaning |
| --- | --- |
| `sameCard` | The first candidate is the right card (name + collector number), ignoring which printing. |
| `exact` | The first candidate is the exact printing in the corpus. |
| `accept` | The pipeline auto-accepted without asking for review. |
| `wrongCard` | Accepted, but the wrong card. **Must stay 0.** |
| `wrongExact` | Accepted, but a different printing of the right card. |

## Results

### Fresh images (2025–2026 cards, unseen in training)

16 images: promos, Japanese printings, Trainers and Energy from the newest sets,
plus blurred and badly framed copies. Scored at field level (the model is called
directly, so no catalogue is involved).

| Prompt | Name | English name (ja) | Collector no. | Illustrator | HP | Reg. mark | Language | Median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Upstream prompt | 14/16 | 0/6 | 16/16 | 6/16 | 12/16 | 5/16 | 16/16 | 3.9 s |
| Our rewritten prompt | 13/16 | 0/6 | 16/16 | 7/16 | 11/16 | 6/16 | 16/16 | 2.0 s |
| Transcribe first, then parse | 10/16 | 0/6 | 12/16 | 7/16 | 12/16 | 5/16 | 9/16 | 2.4 s |
| Evidence first, name last | 12/16 | 0/6 | 16/16 | 6/16 | 12/16 | 5/16 | 15/16 | 2.4 s |

Conclusions:

- The rewrite buys **speed**, not accuracy, on new cards. Its earlier gains were
  measured on older printings where the fields were already readable.
- **Transcribing first is worse**: name, number and language all drop, so a
  transcription prompt invites paraphrase rather than copying.
- **English-name translation fails universally** for Japanese cards (0/6 in every
  variant), while the native name is read correctly. This is a lookup problem.
- **Reasoning on**: four images produced no record in ten minutes, at a 240 s
  budget each. Disabling reasoning is what makes the request finish.

### Catalogue coverage

Measured by `tcg_card_id` (note: `cards.id` carries a language suffix, so comparing
against it reports every card as missing): **35 of the 64 unused corpus cards are
present**. What is absent is systematic rather than general staleness:

- **All Japanese printings** — the catalogue holds zero `ja` rows, because sync
  languages are `en,de`. A Japanese card can only be matched through the live
  TCGdex lookup.
- **The `DLR` set entirely** (12 corpus cards), plus a few scattered cards from
  `30C` and SV-era sets.

The 16-image fresh sample happened to be weighted towards those two gaps (the
newest promos and Japanese printings), which is why end-to-end matching looked
broken on it while the field reading was accurate. Measure matching changes on
cards the catalogue actually contains.

### In-catalogue regression set (48 images, post-import)

Measured after the Japanese import, on the current code:

| Measure | Result |
| --- | --- |
| Correct card | 32/48 |
| Correct printing | 32/48 |
| Auto-accepted | 37/48 |
| Wrong card accepted | 8/37 accepted |
| Median response | 7.9 s |

**Correction:** an earlier version of this document reported 48/48 and
31/48 for the same set. Those figures were produced by a scoring script that
looked cards up by `cards.id` (which carries a language suffix) instead of
`tcg_card_id`, so every comparison degenerated to `None == None` and counted as
a match. The corrected figures below are the real ones; treat any earlier number
in this file that came from that script as void.

Error taxonomy of the 8 wrong accepts:

- **6 are read errors, not matching errors.** The pipeline accepted a card that
  genuinely matched what the model read: Pikachu 115 read as 025, Blaziken 3 as
  146, Ampharos 1 as 111, Pineco 1 as 005, M Venusaur EX 2 as 141, and a blurred
  Charizard read as "Charizard V #041". Fixing these needs better reading, not
  better ranking.
- **2 are a gallery-prefix matcher bug.** A Flareon printed as `TG01` was read
  correctly (`number_local=TG01`, `set_code=TG`) and the right card
  `swsh9tg-TG01` *is* in the candidate list — at position 2, behind `base2-3`
  (Base Set 2 Flareon, number 3). Diagnosis: `normalize_scanner_card_number`
  turns `TG01` into `tg1`, so the gallery printing is admitted as a *gallery
  alternative* rather than as a number match; that path appends it after the
  main rows and `_metadata_decision` discards the `number` signal for gallery
  candidates, so no unique-number acceptance fires. Ranking then leaves a
  contradictory row first, the decision blocks, and visual verification picks
  the wrong Flareon. Reproduce with `read={"name":"Flareon","number_local":"TG01",
  "set_code":"TG","regulation_mark":"D","artist":"You Iribi","language":"en"}`
  against the local catalogue.
- The other 8 incorrect results were **not** accepted, so they reached review —
  which is the designed behaviour.

### Model comparison (14-card sample)

| Arm | Names | Median | Max | Empty responses |
| --- | --- | --- | --- | --- |
| Qwen3.5-9B Q6, `reasoning_effort:"none"` | 12/14 | 1.5–2.2 s | 2.8 s | 0 |
| Qwen3.8-27B Q3, default (reasoning on) | 12/14 | 44 s | 198 s | 0 |
| Qwen3.8-27B Q3, `reasoning_effort:"none"` | 9/14 | 4.6 s | 6.9 s | 0 |
| Qwen3.5-9B Q6, default (reasoning on) | 8/14 | 64 s | 95 s | 6 |
| Gemma-4-12B `it-qat` | 6/14 | 32 s | 110 s | 1 |

## Negative results, so they are not retried

- **Catalogue fuzzy-snapping to fix a near-miss name.** "Venusaur EX" read for
  *M* Venusaur EX has "Venusaur EX" at edit distance 0 in the catalogue — a
  real, different card. No threshold separates them safely.
- **Prompt rules telling the model not to guess an illustrator.** Fabrications
  went 9 → 11 across 96 requests.
- **`max_tokens` to cap runaway reasoning.** Produces an empty response, not
  truncated JSON.
- **`think: false`.** Honoured unreliably by the Ollama `/v1` endpoint;
  `reasoning_effort: "none"` is the switch that works.
- **Naive bottom-strip crop.** Cropping the bottom 18% of the *photo* assumes
  the card fills the frame; on far, realistic and multi-card photos it reads
  nothing. Rectification or card detection must come first.
- **Set-symbol template matching for printing choice.** Tried and not adopted.
  A reprint prints the same name, number and artwork as its original; only the set
  symbol differs. Matching the symbol region against each candidate set's symbol
  image gave 1/3 correct on the presence question and 0/1 on a two-symbol family,
  with correlations of 0.24–0.56 and margins under 0.06 — indistinguishable from
  noise. The symbol is roughly 15 px on a 640 px scan and the region also holds the
  collector-number text, so this needs real symbol localisation (rectification plus
  a fixed-scale crop) before the idea can be judged, not a bigger threshold.
- **Catalogue symbol URLs are stale.** Every stored `images_symbol` uses an
  `/univ/` path that returns 404; rewriting to the language path (`/en/base/base4/`)
  works. Worth fixing independently of any matcher.
  card does fill the frame, the crop was upscaled to 1024 px and asked only for the
  small print. Result over the same images: collector number identical (16/16 both),
  regulation mark identical (6/7 both), illustrator slightly worse (6/16 cropped
  versus 7/16 full card). The crop is ten times faster (0.9 s against 2 s) but buys
  no accuracy, so the small-print limit is the model, not resolution or token
  allocation.
- **Asking the model for `name_en` on Japanese cards.** 5 of 24 matched the
  English catalogue name; the native name was right 21 of 24. The local
  catalogue also contains no `ja` rows by default (`tcgdex_sync_languages` is
  `en,de`), so Japanese matching depends on the live API fallback.

## Reproducing

The harness lives outside the repository (it needs the corpus). Inside the
backend container it needs the corpus mounted or copied to `/tmp/e2e`, then:

```bash
E2E_TAG=baseline python /tmp/e2e/e2e.py
```

Each run appends to `/tmp/e2e/results-<tag>.jsonl`; the re-scoring step joins
candidate ids back to the catalogue so both `sameCard` and `exact` are reported.

### Japanese import, and what it changed

Japanese sets were added to the sync languages and 12,507 `ja` cards were
imported (the sync was stopped in its slow per-card tail, with the corpus
covered). Effect on a 7-card end-to-end sample of catalogue cards:

| Measure | Result |
| --- | --- |
| Correct card | 5/7 |
| Correct printing | 5/7 |
| Auto-accepted | 6/7 |
| Wrong card accepted | 1/7 |

The two Japanese cards matched exactly (`ストライク #001`, `ガラル ニャース #063`),
which the catalogue could not do before the import. The wrong accept was an
English Pikachu: number 115 was read as 25, so a different printing won.

**Throughput caveat:** that sample took ~15 minutes for 7 images (2–19 s each,
but gaps of minutes between some), while an identical run earlier averaged 5 s
per image. The cause was not identified before stopping; it needs a trace-level
look, and every timing number above should be read as "measured under whatever
else was running".

### Model and prompt comparison at scale (100 images, 400 requests)

Same 100 images per run: 40 clean, 30 `blur-strong`, 30 `realistic`; 50 English,
50 Japanese. Field-level scoring, no catalogue.

| Run | Name | English name (ja) | No. | Illustrator | HP | Reg. | Lang | Median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.8-27B · our prompt | 75/100 | 0/50 | 40/100 | 22/100 | 69/100 | 23/100 | 97/100 | 4.3 s |
| Qwen3.8-27B · upstream prompt | 71/100 | 0/50 | 41/100 | 30/100 | 67/100 | 14/100 | 92/100 | 4.2 s |
| Qwen3.5-9B · our prompt | 73/100 | 0/50 | 41/100 | 31/100 | 64/100 | 26/100 | 99/100 | 2.0 s |
| Qwen3.5-9B · upstream prompt | 72/100 | 0/50 | 43/100 | 30/100 | 65/100 | 16/100 | 98/100 | 2.5 s |

Card-name accuracy by condition:

| Condition | 27B ours | 27B upstream | 9B ours | 9B upstream |
| --- | --- | --- | --- | --- |
| clean (40) | 37 | 38 | 37 | 35 |
| realistic (30) | 26 | 25 | 27 | 26 |
| blur-strong (30) | 12 | 8 | 9 | 11 |

Conclusions:

- **The 27B does not justify its latency.** Name 75 vs 73 and number 40 vs 41 are
  inside the noise for n=100, at more than twice the response time. It is *worse*
  on illustrator (22 vs 31), which is the field where fluency fabricates.
- **Heavy blur is a wall.** Under `blur-strong`, both models read ~1/3 of names
  and essentially zero collector numbers (0–1 of 30). Such scans cannot be
  matched to a printing regardless of ranking.
- **The prompt rewrite's durable win is the regulation mark** (26 vs 16 on the
  9B; 23 vs 14 on the 27B), consistent with the fresh-card set.
- **Japanese English names remain 0/50 everywhere** while native names are read
  correctly; this is a catalogue lookup problem, not a model or prompt problem.

### Recovery experiments after the model comparison (2026-11-06)

**Preprocessing does not rescue blurred images.** 30 `blur-strong` images, 9B, our
prompt:

| Variant | Name | Number | Illustrator | Median |
| --- | --- | --- | --- | --- |
| raw | 11/30 | 1/30 | 0/30 | 1.6 s |
| contrast + unsharp | 12/30 | 0/30 | 1/30 | 1.6 s |
| unsharp only | 10/30 | 0/30 | 0/30 | 1.6 s |
| 2x upscale + unsharp | 10/30 | 1/30 | 2/30 | 2.5 s |
| denoise + unsharp | 9/30 | 0/30 | 0/30 | 4.1 s |
| 3x upscale | 4/10 | 0/10 | 0/10 | 5.8 s |

Differences are noise; there is no variant worth adding to the pipeline.

**Card rectification is not ready.** Classical Canny + quad detection found a
card in 12/31 clean, 10/30 realistic and 11/16 real photos, and successful warps
read *worse* than the original (a warped Pikachu returned a name and no number).
Needs a trained detector or a fiducial jig before it is worth building on.

**Constrained number decode does not survive real candidates.** Asking the model
to choose the printed number from a short list looked promising offline (14/30
vs 7/30 on `realistic`) — but that list held the truth plus four *random*
same-width distractors. With the catalogue's real printings as options, on 23
`realistic` images:

| Measure | Result |
| --- | --- |
| free-text number correct | 8/23 |
| re-asked with real printings | 12 asked |
| recovered by the choice list | **1** |
| answered "unreadable" | 7 |

The model honestly declines when the printings are genuinely confusable, so the
choice list adds a model call for no gain. Implemented in `2af12c8`, measured,
**reverted in `1b2af99`/`e627067`**. The lesson: an option list of plausible
distractors flatters the method; only real candidate sets are evidence.

**Acceptance faults fixed** (commit `806e5c7`): gallery subset codes no longer
contradict full abbreviations, a visual pick that contradicts the read goes to
review, and blurred scans need two confirmed signals before accepting.

## Card straightening (2026-11-10)

Goal: a prerequisite for set-symbol matching and a fixed-scale bottom-strip crop.

**Corpus counts corrected.** The real figures are **88** clean renders, **1,056**
augmented (88 × 12 variants) and **44** photos (16 original + 28 session) — earlier
text here said 60/720/16. The augmenter lives in the standalone
`pc-card-corpus` repository (`scripts/augment_test_card_corpus.py`), not this
checkout.

**Ground truth is free for the synthetic set.** The augmenter is deterministic
(seeded by `card_id:variant`), so replaying a transform on a magenta-filled card and
recovering the quad yields exact corners: visible corners matched the generator's own
numbers to **0.5–1.5 px** (0.14% of the diagonal); corners the generator placed
outside the frame are clipped and recorded as `null`. 1,144 rows exported, 0 skipped,
198 with at least one clipped corner. The 44 photos were hand-annotated (see
`corners-photos.jsonl`; all verify against the corpus SHA-256 manifest).

**Classical detection is not viable.** Scored-quad detector (multi-scale Canny +
adaptive threshold, area/convexity/right-angle/aspect≈0.716 scoring):

| Split | detect @2% diag | NMCE mean | IoU |
| --- | --- | --- | --- |
| far | 96.6% | 2.58% | 0.956 |
| sleeve | 37.5% | 2.89% | 0.888 |
| realistic | 30.9% | 14.14% | 0.666 |
| clutter | 26.4% | 17.72% | 0.660 |
| tilt | 17.7% | 4.00% | 0.881 |
| finger | 10.1% | 21.84% | 0.459 |
| **real photos (39 cards)** | **5.1%** | 16.3% | 0.57 |
| naive largest-quad (photos) | 2.5% | 38.7% | 0.10 |

Where it fires the geometry is right; it rarely fires, and it **never declines** —
so it cannot be used as a gate.

**But straightening is worth having, if the geometry is roughly right.** Using the
hand-placed corners (no detector), 28 photos with known numbers:

| Corner error | Number correct |
| --- | --- |
| 0% | 28/28 |
| 2% of diagonal | 28/28 |
| 5% of diagonal | 26/28 |
| 10% of diagonal | 20/28 |
| full-frame control | 26/28 |

So the requirement is **≤2–5% of the diagonal**, not pixel accuracy. The bottom strip
alone loses nothing (28/28) — it is not a lossy crop — which makes it the cheap path
for number/set re-reads. Set codes remain unreadable in every arm (`POR` → `PQR`,
`Porsche`, `PBI`), so no arm fixes set-code reading.

**Set-symbol matching parked.** Whole-band multi-scale NCC over set symbols: **top-1
1/27** (4/27 top-3), degenerate (one template wins nearly everything at a constant
score). Stored symbol URLs are also stale — they end `.webp` under `/univ/` and 404;
the working pattern varies by series and must be `.png`. A localised, aligned crop
with a shape metric would be needed.

**Artwork channel (new, off by default).** `services/artwork_index.py` embeds a photo
with an ONNX DINOv2 ViT-S/14 (384-d, ~145 ms CPU) and cosine-matches a prebuilt
catalogue index; `scripts/build_artwork_index.py` builds it offline. Wired into
candidate retrieval behind `ARTWORK_CANDIDATES_ENABLED` (default off), appending up to
5 hits before ranking. Added candidates obey the same ranking and uniqueness rules, so
the channel can only widen the candidate set — it cannot make an unconfirmed match
easier to accept. Absent index, absent photo bytes or any error leaves behaviour
unchanged.

### Artwork index at catalogue scale (2026-11-11)

The 3k-gallery result was measured on a hand-picked 17-set index. To test whether it
survives a realistic gallery, 21,986 English reference images were downloaded
(`low.webp`, 445 MB) and embedded with DINOv2 ViT-S/14 at 224 px.

Two gallery sizes are now measured on the 27 real photos that have a catalogue id:

| Gallery | Query | top-1 | top-5 |
| --- | --- | --- | --- |
| 3,043 (17 sets, hand-picked) | centre crop | 24/26 (92%) | 25/26 |
| 4,352 (test-card sets first, then random distractors) | centre crop | 24/27 (89%) | 25/27 (93%) |
| 7,424 | centre crop | 23/27 (85%) | 25/27 (93%) |
| 11,520 | centre crop | 23/27 (85%) | 25/27 (93%) |
| 18,432 | centre crop | 23/27 (85%) | 25/27 (93%) |
| **21,986 (full English catalogue)** | centre crop | **23/27 (85%)** | **25/27 (93%)** |
| 21,986 | whole frame | 12/27 (44%) | 20/27 (74%) |

Two conclusions that hold at both sizes:

1. **Cropping to the card matters far more than gallery size.** Whole-frame queries
   lose ~33 points; the centre crop is worth more than any embedding choice. This
   matches the literature (rectification 13% → 74% in the Armanet ablation).
2. **Recall plateaus and stays there**: top-1 92% → 89% → 85% and then flat at 85%
   for 7.4k, 11.5k, 18.4k and the **full 21,986-card catalogue**; top-5 is 93% at
   every size from 4.4k on. Gallery size is not the limiting factor — six-fold growth
   from 3k to 22k costs 7 points of top-1 and nothing on top-5.

**Full 22k measurement blocked by host capacity, not by the method.** Embedding ran at
36 images/s on an idle machine but collapsed to ~1/s with the host at load average
14–16 on 16 cores, and shard jobs stalled for minutes at a time (decode was measured
at 0.2 s for 244 images, so the stall is CPU contention, not I/O). Rather than grind
for hours, the run was stopped at 30 of 86 shards.

Everything is resumable and deterministic:
- reference images: `/tmp/opencode/straightening/refs22k` (21,986 files)
- fixed embedding order (test-card sets first): `/tmp/opencode/straightening/order.json`
- shards: `/tmp/opencode/straightening/chunks2/emb_*.npy` + `ids_*.json`
- scripts: `embed_small.py` (256-image shards, `EMB_THREADS=4`), `merge_query.py`

To finish: run `embed_small.py` on an idle machine (≈10 min at 36/s, ~45 min at 10/s),
then `merge_query.py` — it prints top-1/top-5 for whatever shards exist.

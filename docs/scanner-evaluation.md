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

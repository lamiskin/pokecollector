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

### Catalogue coverage dominates everything else

None of the 64 unused corpus cards exist in the Dev catalogue (`0/64`), because
sync covers `en,de` and predates 2025–2026. New-card scans therefore depend on
the live TCGdex lookup, which answers with an older printing of a related card:
end-to-end matching looks wrong while the reading is correct. Measure matching
changes only on cards the catalogue actually contains.

### In-catalogue regression set

Local model: Qwen3.5-9B `UD-Q6_K_XL` (Ollama, `reasoning_effort: "none"`).
| Run | sameCard | exact | accept | wrongCard | median |
| --- | --- | --- | --- | --- | --- |
| Baseline (prompt rewrite, artist-comma, kana/name-gate/marker/soft-signal fixes) | 48/48 | 31/48 | 36/48 | 0 | 5.1 s |
| + collector-number retrieval when no name was read | 48/48 | 30/48 | 37/48 | 0 | — |

Card-level identification is at the ceiling of this corpus, so it can no longer
show improvement; the open problem is **printing selection** (`exact`), where
reprints share artwork and only the set symbol, set code or regulation mark
distinguishes them.

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

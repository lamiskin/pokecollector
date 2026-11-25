# Graduating live capture from the lab

Status: planned, not started. Fork-only work (`personal/*`), never upstream.

The capture lab (`/capture-lab`, `CAPTURE_LAB_ENABLED`) proved the capture path.
This plan turns it into a capture mode real collectors use, on the scanner they
already have. Measured state of the lab, for context:

- on-device card detection (Cornelius 2.12, wasm, ~300 ms/frame on an Android phone)
- native-resolution capture of a padded box around the tracked card, capped at 2048
- continuous eased outline, ring and blur; one automatic capture per presentation with
  appearance-based re-arm (measured card-to-card signature distance 1.0–1.4 against a
  0.12 threshold)
- auto-capture after ~800 ms of steady framing, corroborated by the detector or by
  12+ consecutive tracked frames; one capture per card presentation
- capture tray, batch submit, per-item recognition, focus score recorded
- server-side deskew was built, measured as a net loss (originals 48/50 complete
  identities vs 44/49 and 46/50 for rectified crops), and deleted

## Decisions (settled 2026-11-25)

| Question | Decision |
|---|---|
| Where it lives | Third mode on the Scanner page, beside photo upload and guided webcam |
| Auto-capture default | On, with a visible toggle; the choice is remembered |
| Captures reach the scanner | Tray, then one job (as the lab does) |
| Duplicate printings | Flag **consecutive** duplicates in review and ask which copy — never silently drop; a repeat that comes back later in a batch is not flagged |
| Detector delivery | Fetch on first use |
| iOS | Offered everywhere; failure must be visible and actionable |

## Open sub-decision

"Fetch on first use" fixes *when* the ~4 MB of model and runtime arrive, not *from
where*. Two viable sources, and the rest of the plan differs slightly between them:

1. **From the app's own image** (`/detector/`, baked at build). Keeps one origin, no
   supply chain, works offline after first load, and costs image size. The CSP
   widening stays a deployment flag, because a policy cannot be widened at runtime.
2. **From a pinned external host** (GitHub release asset with an integrity hash).
   Images stay small, but adds a runtime dependency, a `connect-src` entry, an
   integrity check, and a failure mode that looks like "the feature is broken".

Recommendation: (1). The 4 MB is paid once per deployment rather than once per user,
and it removes an external failure mode from a feature whose whole point is that it
just works. Decide before Phase 3.

## Phases

Each phase ends at a gate; nothing starts before the previous gate passes.

### Phase 1 — capability probe and honest failure
- Probe camera, `Worker`, wasm and the detector's runtime *before* offering live
  capture; show live capture only where the probe passes, and a one-line explanation
  where it does not (rather than a dead button).
- Probe on iOS specifically, since it is untested: report what an iPhone actually
  does, and treat that finding as the input to whether "show everywhere" survives.
- Gate: probe correct on desktop Chromium, Android Firefox, Android Chrome, Safari
  (iOS). No page errors when the detector is unavailable.

### Phase 2 — production route
- Add live capture as the third mode on the Scanner page; the lab page keeps working
  for development but is not the user path.
- Reuse the existing tray and `POST /api/cards/recognize/jobs` submit; no new dev
  endpoints, no capture-lab storage dependency.
- Persist the auto-capture toggle; respect reduced-motion; translations in every
  locale the app ships.
- Gate: a collector can scan 20 cards end to end on Dev with no lab endpoints in the
  network log; visual tests for the new mode pass desktop and mobile.

### Phase 3 — detector delivery
- Implement the chosen source from "Open sub-decision": fetch on first use, show
  progress, verify integrity, cache, and fail with an actionable message.
- Keep the CSP widening deployment-gated (`DETECTOR_ENABLED`), documented in
  `docs/` so an operator knows the trade.
- Gate: first-use download measured on a phone (time, bytes); a second visit loads
  from cache; offline behaviour defined; an instance without the flag never widens
  its policy.

### Phase 4 — review hand-off and duplicates
- Captures land in the tray and submit as one job (already true).
- In review, flag an item only when it resolves to the same printing as the item
  **immediately before it** in the tray order, and ask which copy (or both) — never
  merge silently. A collector working through a stack legitimately owns several of
  the same card: a repeat that comes back after other cards have been scanned is a
  second copy, not a duplicate, and must not be flagged.
- Consecutive is the whole rule. It catches the accidental re-capture (the same card
  presented twice in a row, which appearance re-arm makes rare but not impossible)
  without second-guessing a deliberate second copy found later in the box.
- Gate: measured false-merge rate against real consecutive pairs; no silent drops; the
  prompt is one tap; a repeat three items later is left alone.

### Phase 5 — hardening and rollout
- Permissions and HTTPS messaging; camera denied/absent; backgrounded tab; power
  saving and thermals (previously measured: detection 300 ms → 759 ms under
  throttling).
- Device matrix: Android Chrome/Firefox, iOS Safari, desktop Chrome, plus top loader,
  holo glare, landscape, small-in-frame.
- Rollout: flag off in released images → on in Dev → opt-in on Prod with the
  measurement in Phase 6 attached.

### Phase 6 — measurement that decides whether it stays
Run on real captures, not synthetic ones:

- **capture precision**: share of automatic captures containing one complete card
  (clipping, blur, glare, wrong object)
- **false accepts**: captures whose recognition commits a wrong identity — the only
  failure class that corrupts a collection
- **duplicates**: captures per card presented, after the appearance re-arm
- **effort**: retakes per card, time from presentation to staged capture
- **recognition outcome**: complete identity rate, stratified by sleeve, top loader,
  glare, rotation

If precision or false accepts are worse than the guided webcam's, live capture does
not graduate: the lab stays and the experiment is written up as a negative result,
as the deskew was.

## Risks worth naming up front

- **iOS unknown.** "Show everywhere" is a promise about a browser this has never run
  in. Phase 1 exists to find out cheaply.
- **The detector is the flakiest part.** Roughly 40% of model results are rejected as
  soft at typical framing; auto-capture now tolerates that via tracker corroboration,
  which is a judgement call that Phase 6 must confirm did not lower precision.
- **Duplicates move from the camera to review.** Appearance re-arm prevents most, not
  all; the review-time prompt is the real safety net.
- **Shared code.** Phase 4 touches scan review, which is shared with upstream. It is
  the only phase with a meaningful chance of conflicting with a future sync.

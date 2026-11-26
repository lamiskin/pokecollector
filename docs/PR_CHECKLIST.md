# Behavioral change and PR checklist

Use this for nontrivial changes, not as a requirement to investigate every
subsystem on every PR. Mark irrelevant areas out of scope with a brief reason.
Consult `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `docs/BACKEND.md`,
`docs/FRONTEND.md`, and `docs/CARD_SYSTEM.md` as applicable.

## 1. Map the contract before implementing

State the user-visible outcome, what must remain true, and the existing shared
helpers or components that own those rules. Inspect relevant callers and
consumers, not just the function where the problem was found.

Check the relevant boundaries:

- **Collection writes:** single add, bulk add, import, scan acceptance, and any
  other writer sharing identity, language, variant, or quantity rules.
- **Deferred work:** enqueue, claim, execution, retry, cancellation, and restart.
  Revalidate mutable configuration when executing persisted decisions; inspect
  event-loop, thread, process, and transaction ownership where relevant.
- **Photos and attachments:** upload, replacement, removal, parent deletion,
  account deletion, and custom-to-official migration. Define collision and
  retention policies; bound both uploaded bytes and decoded image dimensions.
- **Shared semantics:** valuation and price preferences, provider/model
  resolution, identity matching, diagnostics attempt identity, and cache
  invalidation for every relevant mutation. Avoid parallel implementations of
  established rules.
- **Request budgets:** browser, proxy, backend, retries, verification calls,
  and background leases. Derive budgets from current contracts; do not widen
  unrelated downloads or routes merely because a client is shared.
- **UI consumers:** relevant collection, binder, search, trade, product, and
  analytics surfaces. Reuse dialog/focus behavior and artwork loading, error,
  retry, and interactive-action contracts. Check filtered navigation and badges,
  not just the primary screen.

If behavior changes a default, fallback priority, privacy policy, selection
scope, or navigation model, make that decision explicit. Agree upstream-facing
policy before expanding a feature to suit personal-fork preferences.

## 2. Design tests that can disprove the claim

Ask: **could these tests pass while the reported problem still exists?**

- Exercise a stable integration boundary as well as helpers where needed.
  Cover sibling writers, state transitions, and interacting rules identified
  above. Use the existing verification-planning workflow proportionately.
- Cross the earliest actual pipeline limit with data in the relevant sort
  order. A test beyond a downstream selector limit may still miss a SQL cap.
- Use nondefault settings, partial or legacy data, confusing identities, and
  relevant failure/replay cases. Pin environment values that affect results;
  do not let fixtures silently encode the implementation's assumptions.
- For optional fallbacks, test preparation failures and unsuccessful secondary
  results, not only successful network responses. For logical user actions
  spanning writes, check atomicity and concurrent/repeated submission behavior.
- For interactive changes, exercise the affected browser flow, including
  relevant touch, keyboard, focus, retry, and small-viewport behavior. A build
  or helper test alone does not establish that the page works.
- For recognition changes, provide privacy-safe, authorized examples linking
  capture conditions, extracted fields, expected identity, candidate pool, and
  before/after final decisions. Distinguish handheld photos from controlled
  crops and candidate narrowing from confident identification. Do not publish
  private photos or traces without permission.

Prefer a regression that fails before the fix and passes afterward. If that
cannot be demonstrated, state the weaker evidence and its limitation. Run the
repository's required gates; added test source is not evidence of execution.

## 3. Check upstream fit and hand off evidence

- Recheck changed contracts against the current intended base before review.
  After a dependency is squash-merged or rewritten, reconcile dependent work
  against the actual merged implementation and revalidate affected evidence.
- Follow current contribution and version/release requirements. Historical PRs
  do not establish today's policy, and later policies do not explain earlier
  omissions. Clarify release ownership rather than assuming always/never bump.
- Separate demonstrated defects from optional scope, product preferences,
  upstream drift, author self-fixes, and maintainer-introduced intermediate
  errors. Do not add unrelated cleanup to satisfy this checklist.
- Use the existing reviewer and final-check owner; this checklist does not
  require additional agents or repeated full-suite runs. Reuse still-valid
  evidence and rerun only checks invalidated by changes, alongside required
  final gates.

Include a compact handoff in the PR or task result:

- **Claim:** the behavior now established and the invariant preserved.
- **Coverage:** relevant paths, consumers, and transitions checked.
- **Evidence:** exact commands, exit statuses, and relevant results, including
  before/after evidence where available.
- **Limits:** unverified cases, accepted tradeoffs, and decisions needing
  maintainer agreement. Do not describe unexecuted tests or inferred outcomes
  as verified.

## Why these checks exist

The November 2026 upstream review-history audit found recurring contract-boundary
gaps, not a universal style problem. Examples include incomplete language-rule
coverage ([#379](https://github.com/Git-Romer/pokecollector/pull/379)), photo
migration ([#375](https://github.com/Git-Romer/pokecollector/pull/375)), testing
the wrong candidate cap ([#371](https://github.com/Git-Romer/pokecollector/pull/371)),
and fallback configuration ([#376](https://github.com/Git-Romer/pokecollector/pull/376)).
These examples explain the questions; current code determines the answers.

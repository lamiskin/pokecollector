# Japanese Card Pricing — Source Research

**Status:** Research only, nothing implemented. Findings from live-testing
six candidate pricing sources against real cards pulled from the local
`cards` table (`lang='ja'`), 2026-08-26.

## Why this is needed

TCGdex — the project's only current pricing source (`services/pokemon_api.py`)
— exposes exactly two markets: **Cardmarket (EUR)** and **TCGPlayer (USD)**.
Confirmed against TCGdex's own docs (`tcgdex.dev/markets-prices`): no JPY
market, no Japanese source, and no stated plans to add one.

The local DB backs this up. Of the 12,608 `lang='ja'` cards synced locally,
**only 253 (2.0%) have any price at all**, and every one of those 253 got its
price by copying an English/German printing's Cardmarket/TCGPlayer price via
the `price_source_lang` fallback in `price_utils.py` — e.g. `neo2-1_ja`
(Espeon) shows `price_market: 198.53, price_source_lang: en`. Cards with no
English/German equivalent (JP-exclusive promos, and — per prior
investigation into this local sync's data quality — most of the vintage
1996–2001 catalog) have **zero** pricing and no fallback available. This is the gap a second, real-JPY source would close.

## Test method

Pulled two card samples straight from the running local Postgres instance
(`podman exec pokemon-postgres psql ...`):

- **Vintage** — `PMCG1` (1996 Base Set, "旧裏面"/old-back era): Venusaur
  (フシギバナ #011), Charizard (リザードン #021), Blastoise (カメックス
  #032), Pikachu (ピカチュウ #035). Chosen because these are exactly the
  cards flagged as having zero price *and* zero TCGdex fallback available.
- **Modern** — `S8b` (VMAX Climax, 2021): Pikachu VMAX (#046/184), Mimikyu
  VMAX (#077/184), Sylveon VMAX (#075/184). Chosen as a control — a set
  popular enough that both JP retailers should carry it, to sanity-check
  matching quality before trusting the vintage results.

Then searched each card by its Japanese printed name directly against
**yuyu-tei.jp** and **cardrush-pokemon.jp** through a real browser (not just
an HTTP fetch, since both are JS-enhanced storefronts), and recorded what
came back.

## Finding 1 — Yuyu-tei has no vintage inventory at all

Yuyu-tei (遊々亭) is a real, well-structured shop: searching
`/sell/poc/s/search?search_word=...` returns clean server-rendered listings —
card number, rarity, JPY sell price, live stock count — and it matched all
three modern `S8b` cards perfectly by number+set-total (`046/184`, `077/184`,
`075/184`).

But it is a **tournament-singles shop**, not a collectibles shop. Its oldest
listed set is BW-era (2010+). Searching any of the four base-set names
(フシギバナ/リザードン/カメックス/ピカチュウ) returns only modern reprints
and promo variants of that Pokémon — never the 1996 card. There's no
"vintage" or "旧裏" category anywhere on the site; I confirmed this both by
browsing the top-level set list and by web-searching `site:yuyu-tei.jp` for
vintage terms. **Yuyu-tei cannot price any of the cards this project
actually needs pricing for** — it's solid for modern sets, but that's exactly
the set of cards TCGdex/Cardmarket/TCGPlayer already covers today.

## Finding 2 — Cardrush has real vintage pricing, condition-tiered

Cardrush (カードラッシュ) does carry 1996–2001 cards, under a dedicated
`旧裏` ("old-back") category — confirmed by searching e.g.
`product-list?keyword=リザードン　旧裏`, which returned 76 distinct listings
for Charizard alone. All four vintage test cards were found. Two structural
differences from TCGdex/Yuyu-tei worth flagging for anyone building a
matcher:

1. **No set/number key** — vintage listings carry `{旧裏}` instead of a
   `number/total` pair, and are keyed by **printed name + level + attack
   variant** instead (Japanese Base Set had several print runs of the same
   Pokémon with different attack text — e.g. Charizard alone splits into
   "LV.76(かえん/マークあり)", "LV.76(とりかえっこプリーズ!)", and plain
   "LV.78"). Matching a TCGdex/local-DB row to the right Cardrush listing
   needs name+level, not number+set, and is inherently fuzzier for this era.
2. **Every card is sold in multiple condition tiers** (状態A-/B/C/D, plus
   separately-listed PSA/ARS graded slabs), each a different price — there
   is no single "the price" the way Cardmarket's `avg` gives one. An
   integration would need to pick a reference tier (ungraded/near-mint "no
   condition tag" listing looks like the closest analog to what TCGdex's
   `price_market` represents) and treat the rest as optional extra data.

Modern `S8b` cards matched Cardrush cleanly too, on the same `number/total`
key as Yuyu-tei, confirming the matching logic that already works for modern
sets doesn't need to change — only vintage needs the name+level fallback.

## Finding 3 — the two sources roughly agree on modern-set prices

Not a given, since Yuyu-tei and Cardrush are competing shops, not the same
company:

| Card | Yuyu-tei (RRR) | Cardrush (RRR) |
|---|---:|---:|
| ピカチュウVMAX S8b 046/184 | ¥1,980 | ¥1,580 |
| ミミッキュVMAX S8b 077/184 | ¥680 | ¥980 |
| ニンフィアVMAX S8b 075/184 | ¥500 | ¥680 |

Same ballpark, 20–40% apart — normal retail-shop spread, not noise. This is
a reasonable cross-check signal for future validation logic.

## Finding 4 — Suruga-ya: the cleanest vintage match of everything tested

駿河屋 (suruga-ya.jp) is a major, long-established (since 1998) used-goods
retailer, not TCG-specific. Searching `search?search_word=<name>　旧裏`
returns a normal server-rendered product list (a brief Cloudflare JS check
passes automatically, no manual challenge). It found all four vintage test
cards, and its listings carry a field none of the other sources have: **the
actual release date of that specific printing** (発売日), e.g.

```
No.006[★]：(キラ)リザードン LV.76（Cランク）
ポケモンカードゲーム(旧裏面)/★/炎/第1弾拡張パック＆スターターパック
[発売日：1996/10/20]
中古：￥79,800　税込
```

That release date is a much stronger disambiguator than Cardrush's
name+level alone — "第1弾拡張パック＆スターターパック [1996/10/20]" pins a
listing to the exact same set/printing our local `PMCG1` rows represent,
even when multiple prints share the same Pokémon+level (Cardrush's listings
don't carry this, so a matcher built on Cardrush alone has to guess between
same-name variants). Suruga-ya also shows a condition-range price
(`￥9,980 ～ ￥39,800`) plus a separate third-party marketplace price
(マケプレ) on the same listing, so it's effectively two price points per
card in one page. Modern cards match the same way the other sources do, on
`number/total` (confirmed with `ピカチュウVMAX 046/184`, ¥610–¥980, release
date 2021/12/03 — matches `S8b` exactly). Of everything tested, **this is
the cleanest single-source match for vintage**, condition-tier problem
aside (same caveat as Cardrush — no single reference price).

## Finding 5 — Hareruya2: browse-by-set structure, but stock/freshness gap

晴れる屋2 (hareruya2.com) — mostly known for Magic: the Gathering, but runs a
dedicated Pokémon storefront. Unlike every other source here (all
searched by card name), Hareruya2 organizes vintage inventory **by set**,
much closer to how TCGdex/the local `sets` table works:
`hareruya2.com/collections/1` is literally "拡張パック第1弾（初版）" — the
exact same set as local `PMCG1` — listing all 122 cards in it with one
price each, no per-card search needed. Found all four test cards
(フシギバナ ¥150,000, リザードン ¥900,000, カメックス ¥150,000, ピカチュウ
¥400,000). Two catches: every single item on this page was **SOLD OUT**
(在庫なし) — so these look like the last-listed price, not necessarily a
live current one — and these particular prices are the rarest "初版"
(true first-print, no rarity-mark-at-all) tier specifically, a step above
Cardrush's/Suruga-ya's "マークあり/マークなし" tiers, so they're not directly
comparable to the other two sources' numbers in the table below. Worth a
second look if a set-level browse structure ends up mattering more than
per-card search, but the stock/freshness question needs resolving first.

## Finding 6 — two aggregator/comparison sites, both weaker than expected

- **みんなのポケカ相場** (pokeca-chart.com) markets itself as a
  comprehensive Pokémon price tracker (2,500+ updates/day) and does pull
  from real sources (its rankings cite カードラッシュ for stock deltas and
  フリマ — flea-market resale, likely Mercari — for sold-price trends). But
  its own card database only holds **621 cards total**, and filtering it to
  `リザードン` (`/all-card/?q=リザードン`) returns 24 results, none older
  than a 2016 reprint (`CP6`, 20th Anniversary). It's a curated
  hype/trend tracker for chase cards in modern sets, not a general pricing
  database — doesn't help with either the vintage gap or general coverage.
- **ヒカカク!** (hikakaku.com, category page for 旧裏面) is structurally
  different from every shop above: it shows **real crowd-sourced appraisal
  transactions** — actual amounts buyback companies paid real sellers, with
  dates and prefecture (e.g. "古代ミュウ エラー版, 査定日：2026-08-24,
  ￥25,000"), aggregated from a network of up to 20 buyback companies. That's
  a genuinely different signal (real transactions vs. shop asking prices),
  but the listings are messy for structured per-card lookup — many entries
  are bulk lots ("ポケカ旧裏まとめ・大量") rather than single identified
  cards, and I didn't find a clean per-card-name query path the way
  Suruga-ya/Cardrush have. Interesting as a validation signal, not a
  primary source.

## Card-by-card results

### Vintage — PMCG1 (1996 Base Set)

| Local card | Yuyu-tei | Cardrush (旧裏, by condition) | Suruga-ya (旧裏, by condition + release date) | Hareruya2 (初版, SOLD OUT) |
|---|---|---|---|---|
| `PMCG1-011_ja` フシギバナ (Venusaur) #011 | **Not found** — no vintage inventory | LV.67(マークあり): 状態D ¥4,980 / B ¥14,800 / A- ¥99,800 | LV.67「第1弾拡張パック＆スターターパック」[1996/10/20]: ¥9,980～¥39,800 (マケプレ ¥1,960) | ¥150,000 |
| `PMCG1-021_ja` リザードン (Charizard) #021 | **Not found** | LV.78(plain): 状態D ¥12,800 / C ¥15,800 / B ¥21,800 / ungraded ¥398,000. LV.76(マークあり): B ¥108,000 / A- ¥428,000 | LV.76「第1弾拡張パック」[1996/10/20]: ¥79,800 (マケプレ ¥31,440) | ¥900,000 |
| `PMCG1-032_ja` カメックス (Blastoise) #032 | **Not found** | LV.52(マークあり): 状態C ¥10,800 / B ¥22,800 / A- ¥118,000 / ungraded ¥498,000 | LV.52「第1弾拡張パック＆スターターパック」[1996/10/20]: ¥29,800～¥45,800 (マケプレ ¥9,910) | ¥150,000 |
| `PMCG1-035_ja` ピカチュウ (Pikachu) #035 | **Not found** | LV.12(マークなし): 状態D ¥39,800 / C ¥54,800 / B ¥148,000 / A- ¥598,000. (マークあり): C ¥1,280 / B ¥3,280 / A- ¥25,800 | LV.12「第1弾拡張パック＆スターターパック」[1996/10/20]: ¥2,060～¥25,800 (マケプレ ¥1,250) | ¥400,000 |

(Prices as listed 2026-08-26, tax-included JPY, ungraded/raw condition
tiers unless noted; PSA-graded slabs excluded from this table for brevity.
Hareruya2's column is the rarer "初版"/no-mark-at-all tier, not directly
comparable to the other three columns' マーク tiers — see Finding 5.)

### Modern — S8b (VMAX Climax) control set

| Local card | Yuyu-tei (RRR) | Cardrush (RRR) | Suruga-ya (RRR, +release date) |
|---|---|---|---|
| `S8b-046_ja` ピカチュウVMAX #046/184 | ¥1,980 (in stock) | ¥1,580 (167 in stock) | ¥610～¥980 [2021/12/03] (マケプレ ¥380) |
| `S8b-077_ja` ミミッキュVMAX #077/184 | ¥680 (in stock) | ¥980 (156 in stock) | not queried |
| `S8b-075_ja` ニンフィアVMAX #075/184 | ¥500 (in stock) | ¥680 (34 in stock) | not queried |

All three sources agree on set/number for modern cards and land in the same
rough price band — good cross-check signal.

## Other sources noted but not live-tested here

Carried over from the earlier research pass, for context:

- **PriceCharting.com** — blocked automated fetches with a 403 (bot
  protection); has a paid API, pricing not public. Would need a paid
  subscription to evaluate properly.
- **PokemonPriceTracker.com** — re-serves TCGPlayer/eBay/Cardmarket data
  under the hood, so it inherits the same "no real JPY vintage price" gap
  TCGdex already has. Not useful for this specific problem.

## Recommendation

Yuyu-tei is still a dead end for vintage — confirmed again across this
whole second pass, nothing tested changes that. Of the five sources that
*do* carry vintage pricing, ranked for a real integration:

1. **Suruga-ya** — best single choice. Real retailer, clean server-rendered
   product search, and the only source with a **printed release date per
   listing**, which resolves the "which print run is this" ambiguity that
   every other vintage source (Cardrush, Hareruya2) leaves to a fuzzy
   name+level guess. Also gives a second price point for free (マケプレ
   third-party marketplace) and uses the same number/total key as
   Cardmarket/Yuyu-tei/Cardrush for everything post-2000, so one matcher
   mostly covers both eras.
2. **Cardrush** — nearly as good, broader vintage catalog in the one
   category I sampled (76 Charizard listings vs. Suruga-ya's handful), but
   no release date to disambiguate same-name print variants.
3. **Hareruya2** — structurally the most convenient (browse-by-set matches
   how the local `sets` table already works, no per-card search loop
   needed) but the SOLD-OUT-everywhere state on the one set I checked is a
   real freshness question that needs resolving before trusting it for
   current prices.
4. **ヒカカク!** — a genuinely different signal (real paid-out appraisal
   transactions, not shop asking prices) worth keeping in mind as a
   validation/cross-check source later, not as a primary feed given how
   unstructured its listings are.
5. **みんなのポケカ相場**, **PokemonPriceTracker** — both ruled out, same
   reason: they only reach back to reprint-era sets, so they don't close
   the gap this project actually has.

Cross-checking two real shops against each other (Suruga-ya + Cardrush, the
way Yuyu-tei/Cardrush/Suruga-ya already agreed within 20-40% on the modern
`S8b` control cards) is probably worth more than picking one and trusting it
blind, given how wildly vintage prices swing by condition and print-mark
state — the four-way vintage table above shows the same card ranging from
hundreds of yen to hundreds of thousands depending on which tier you land
on.

Whichever source(s) get chosen, the same added complexity applies to all of
them (Yuyu-tei/TCGdex's modern-only matching doesn't need any of this):
- A **name+level(+release-date where available) fuzzy matcher** for
  pre-2002 cards, since there's no number/set key for that era — the same
  "printed Japanese name, not translated English" principle already used
  for image-source matching applies directly here.
- A **condition-tier choice** — picking which listing counts as "the"
  price for a card, analogous to how `price_market` is a single Cardmarket
  figure today.
- `robots.txt`/ToS review for whichever site(s) get built on before setting
  up a scheduled scraper, and a sensible request rate — none of the five
  offer a bulk export or documented API, this was all tested
  interactively/manually.

Not yet decided: which source(s) to actually build on, schema shape (new
`price_jpy_*` columns vs. reusing the existing `price_*` fields when no
Cardmarket/TCGPlayer price exists), and scope (all `lang='ja'` cards, or
only ones currently priceless). Flagging back to the user before any
implementation starts.

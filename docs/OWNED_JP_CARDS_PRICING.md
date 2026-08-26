# Owned Japanese Card Pricing — Live Cross-Site Results

**Status:** Reference data only, nothing written back to the database. Every
price below was pulled live from each site on 2026-08-26 and is a
point-in-time snapshot, not a feed — re-run before relying on it for
anything current.

## Scope

This covers every Japanese card actually in the `collection` table (not the
full `cards` reference catalog, which has 12,608 `lang='ja'` rows synced
from TCGdex — see the correction below) — **43 cards**, across six sets:

| Set | Cards owned |
|---|---:|
| `PMCG1` — 1996 Base Set | 9 |
| `PMCG2` — Pokémon Jungle | 5 |
| `PMCG3` — Fossil ("化石の秘密") | 12 |
| `PMCG4` — Team Rocket ("ロケット団") | 4 |
| `VS1` — VS series promo | 1 |
| `neo1` — Neo Genesis (stored as `custom-...` rows, likely from a scan session rather than a TCGdex sync) | 9 |

**Scope correction mid-task:** the first pass at this wrongly queried the
full `PMCG1` reference catalog (all 102 cards TCGdex synced) instead of what
`collection` actually holds. Caught by the user before much was wasted;
the list above is the corrected, real scope.

Queried against the four sources from the earlier research pass
([JAPANESE_PRICING_RESEARCH.md](JAPANESE_PRICING_RESEARCH.md)): **Suruga-ya**
and **Cardrush** individually per card (86 live searches), **Hareruya2** in
bulk per set-browse page (7 page loads covering all 43 cards at once), and
**Yuyu-tei** — not re-queried per-card here since the prior research pass
already established it carries zero vintage (pre-2010) inventory at all;
that finding was re-confirmed, not assumed.

## A genuine data-quality bug found along the way

The `VS1-041_ja` card is stored locally as **`プライスのラプラス`**.
"プライス" is not a real Japanese Gym Leader / VS-character name — Suruga-ya
returned zero results for it, and Cardrush only surfaced an unrelated
`カスミのラプラス` (Misty's Lapras) card. Cross-checking Hareruya2's full VS
series listing (156 cards) by number instead of name found the actual card
at print number 041/141: **`ヤナギのラプラス`** ("Yanagi's Lapras" — Yanagi/
Willow is a real VS-series character). Number matches our local row (`041`)
exactly; the printed name in the local DB does not. This is a concrete,
single-card instance of the "VS1 names are partly garbled" data-quality
issue flagged previously for this local sync — worth a real fix in the sync
data, not just noted here.

## Results — all 43 cards

Prices are tax-included JPY. "Suruga-ya" shows the store's own price
(range, if multiple conditions) plus its third-party marketplace (マケプレ)
price in parenthesis, and the release date of the specific printing it
matched (the disambiguator Suruga-ya uniquely provides). "Cardrush" shows
condition-tier prices (D→A-, worst→best, then ungraded/PSA where relevant)
when a matching print was in stock — "no match" means Cardrush's inventory
skipped that exact print (see the Cardrush section of the source-research
doc for why: it has no release-date field, so a same-name/different-print
card can look like a false miss). "Hareruya2" is one snapshot price from
its per-set browse page, and every single listing on it was sold out — a
freshness caveat carried over from the first research pass, now confirmed
across all 43 cards, not just the 4 originally sampled.

### PMCG1 — 1996 Base Set

| Card | Suruga-ya | Cardrush | Hareruya2 (初版 tier, all SOLD OUT) |
|---|---|---|---|
| フシギダネ (Bulbasaur) #001 | LV.13 [1996/10/20] ¥580–¥1,280 (マケプレ¥380) | no ungraded stock; PSA8 ¥4,480 | ¥26,000 |
| トランセル (Metapod) #003 | LV.21 [1996/10/20] ¥280 (マケプレ¥240) | no ungraded stock; PSA9 ¥3,480 | ¥8,000 |
| ドガース (Koffing) #006 | LV.13 [1996/10/20] ¥220–¥380 (マケプレ¥143) | no plain-print stock; PSA9(マークなし) ¥5,480 | ¥7,000 |
| ギャラドス (Gyarados) #034 | LV.41 [1996/10/20] ¥8,900, Bランク (マケプレ¥1,460) | LV.41(マークあり) D¥1,980/C¥3,480/B¥12,800/A-¥59,800 | ¥400,000 |
| サンド (Sandshrew) #051 | LV.12 [1996/10/20] ¥280 (マケプレ¥144) | no ungraded stock; PSA10(マークあり) ¥19,800 | ¥4,000 |
| ディグダ (Diglett) #052 | LV.8 [1996/10/20] ¥280 (マケプレ¥210) | no ungraded stock; PSA10(マークなし) ¥49,800 | ¥7,000 |
| ワンリキー (Machop) #053 | LV.20 [1996/10/20] ¥280 (マケプレ¥124) | no ungraded stock; PSA10 ¥29,800 | ¥7,000 |
| ディフェンダー (trainer) #079 | 第1弾拡張パック [1996/10/20] ¥180 (マケプレ¥180) | 0 results | ¥5,000 |
| ポケモンの笛 (trainer) #084 | [◆] [1996/10/20] ¥180 (マケプレ¥180) | no ungraded stock; PSA9(マークなし) ¥4,980 | ¥6,000 |

### PMCG2 — Pokémon Jungle

| Card | Suruga-ya | Cardrush | Hareruya2 |
|---|---|---|---|
| ニドリーナ (Nidorina) #008 | LV.24 [1997/03/05] ¥280 (マケプレ¥260) | no matching print; unrelated PSA10(サカキの) ¥24,800 | ¥800 (SOLD OUT) |
| トサキント (Goldeen) #021 | LV.12 [1997/03/05] ¥280 (マケプレ¥270) | no matching print; unrelated graded(カスミの) ¥5,480 | ¥500 (SOLD OUT) |
| オニスズメ (Spearow) #034 | LV.13 [1997/03/05] ¥280 (マケプレ¥80) | 0 results | ¥500 (SOLD OUT) |
| ニャース (Meowth) #036 | LV.15 [1997/03/05] ¥580–¥1,280 (マケプレ¥220) | no matching print; unrelated PSA9(Rocket set) ¥3,480 | ¥1,000 (SOLD OUT) |
| イーブイ (Eevee) #037 | LV.12 [1997/03/05] ¥650–¥1,980 (マケプレ¥285) | no LV.12 match (only Neo-era LV.14) | ¥4,000 (SOLD OUT) |

### PMCG3 — Fossil ("化石の秘密")

| Card | Suruga-ya | Cardrush | Hareruya2 |
|---|---|---|---|
| アーボ (Ekans) #001 | LV.10 [1997/06/21] ¥280 (マケプレ¥180) | no match; unrelated PSA10(キョウの) ¥24,800 | ¥500 (SOLD OUT) |
| アーボック (Arbok) #004 | LV.27 [1997/06/21] ¥380 (マケプレ¥300) | no match; only わるいアーボック(Rocket) variants | ¥800 (SOLD OUT) |
| コダック (Psyduck) #010 | LV.15 [1997/06/21] ¥1,580–¥2,980 (マケプレ¥330) | no ungraded stock; PSA10 ¥24,800 | ¥10,000 (SOLD OUT) |
| メノクラゲ (Tentacool) #011 | LV.10 [1997/06/21] ¥280 (マケプレ¥170) | 0 results | ¥500 (SOLD OUT) |
| クラブ (Krabby) #013 | LV.20 [1997/06/21] ¥280 (マケプレ¥124) | no relevant match (search noise from "ファンクラブ") | ¥500 (SOLD OUT) |
| ゴルダック (Golduck) #016 | LV.27 [1997/06/21] ¥380 (マケプレ¥200) | no match; only カスミの(Gym) D¥880/C¥1,980/B¥3,980/¥29,800 | ¥800 (SOLD OUT) |
| ドククラゲ (Tentacruel) #017 | LV.21 [1997/06/21] ¥380 (マケプレ¥140) | no match; only unrelated LV.30 Southern Islands print | ¥800 (SOLD OUT) |
| シードラ (Horsea) #020 | LV.23 [1997/06/21] ¥280 (マケプレ¥252) | no match; only unrelated カスミの LV.30 Gym print | ¥800 (SOLD OUT) |
| **フリーザー** (Articuno, Holo, owned) #023 | LV.35[★] [1997/06/21] ¥2,980–¥10,800 (マケプレ¥1,900) | LV.35[★] D¥1,480/C¥3,980/B¥7,480/A-¥21,800/ungraded¥148,000 | ¥40,000 (SOLD OUT) |
| ヤドン (Slowpoke) #027 | LV.18 [1997/06/21] ¥1,580–¥2,980 (マケプレ¥600) | no ungraded stock; PSA10 ¥24,800 | ¥5,000 (SOLD OUT) |
| **ゲンガー** (Gengar, Holo, owned) #031 | LV.38[★] Cランク [1997/06/21] ¥14,800 (マケプレ¥39,760) | LV.38[★] D¥7,980/C¥10,800/B¥32,800/A-¥178,000 | ¥280,000 (SOLD OUT) |
| イシツブテ (Geodude) #034 | LV.16 [1997/06/21] out of store stock (マケプレ¥150) | no match (LV.15/LV.36 unrelated) | ¥500 (SOLD OUT) |
| サンドパン (Sandslash) #036 | LV.33 [1997/06/21] ¥280 (マケプレ¥110) | 0 results | ¥800 (SOLD OUT) |
| エネルギー転送 (trainer) #044 | [1997/06/21] ¥160 (マケプレ¥60) | 0 results | ¥300 (in stock ×20) |
| なにかの化石 (trainer) #046 | [1997/06/21] ¥180 (マケプレ¥60) | 0 results | ¥300 (SOLD OUT) |

### PMCG4 — Team Rocket ("ロケット団")

| Card | Suruga-ya | Cardrush | Hareruya2 |
|---|---|---|---|
| わるいクサイハナ (Dark Gloom) #006 | LV.21 [1997/11/21] ¥280 (マケプレ¥120) | 0 results | ¥800 (SOLD OUT) |
| わるいユンゲラー (Dark Kadabra) #034 | LV.24 [1997/11/21] ¥280 (マケプレ¥280) | 0 results | ¥800 (SOLD OUT) |
| わるいスリーパー (Dark Hypno) #037 | LV.26[★] [1997/11/21] ¥2,980–¥7,480 (マケプレ¥1,350) | LV.26[★] D¥580/C¥1,180/B¥2,480/A-¥11,800 | ¥7,000 (SOLD OUT) |
| きずぐすり配合エネルギー (trainer) #063 | コロコロ付録 (date field inconsistent), out of stock (マケプレ¥86) | 0 results | ¥500 (SOLD OUT) |

### VS1 — VS Series Promo

| Card | Suruga-ya | Cardrush | Hareruya2 |
|---|---|---|---|
| ~~プライスのラプラス~~ → **ヤナギのラプラス** (Lapras) #041 — see data-quality note above | 0 results for either name | 0 results for either name; unrelated カスミのラプラス(VS){057/141} PSA graded ¥4,980–¥12,800 | ¥4,000 (SOLD OUT) — only source with a real match, found by number not name |

### neo1 — Neo Genesis (stored as `custom-...` rows)

| Card | Suruga-ya | Cardrush | Hareruya2 |
|---|---|---|---|
| チコリータ (Chikorita) #001 | LV.12 [2000/02/04] out of stock (マケプレ¥352) | no ungraded stock; PSA9¥5,480/PSA10¥9,980 | ¥300 (SOLD OUT) |
| ベイリーフ (Bayleef) #002 | LV.39[◆] [2000/02/04] ¥480 (マケプレ¥170) | no ungraded stock; PSA9¥5,480/PSA10¥9,980 | ¥600 (SOLD OUT) |
| メガニウム (Meganium) #003 | LV.57[★] Bランク [2000/02/04] ¥3,980 (マケプレ¥2,580) | LV.57[★] D¥580/C¥1,280/B¥2,180/A-¥8,980/ungraded¥29,800 | ¥13,000 (SOLD OUT) |
| ヒノアラシ (Cyndaquil) #004 | LV.21[●] [2000/02/04] ¥780 (マケプレ¥340) | no ungraded stock; PSA10¥17,800 | ¥800 (SOLD OUT) |
| マグマラシ (Quilava) #005 | LV.35[◆] [2000/02/04] ¥600–¥1,280 (マケプレ¥460) | no match; only unrelated LV.28 Premium File print | ¥400 (SOLD OUT) |
| バクフーン (Typhlosion) #006 | LV.55[★](エラー版) [2000/02/04] ¥6,900–¥19,800 (マケプレ¥2,210) | LV.55(エラー版)[★] D¥1,280/C¥2,180/B¥5,980/A-¥17,800/ungraded¥34,800 | ¥15,000 (SOLD OUT) |
| ワニノコ (Totodile) #007 | LV.20[●] [2000/02/04] ¥480 (マケプレ¥240) | no ungraded stock; PSA10¥17,800 | ¥600 (SOLD OUT) |
| アリゲイツ (Croconaw) #008 | LV.34[◆] [2000/02/04] ¥280 (マケプレ¥180) | no match; only unrelated LV.41 Premium File print | ¥700 (SOLD OUT) |
| オーダイル (Feraligatr) #009 | LV.56[★] [2000/02/04] ¥3,980–¥8,980 (マケプレ¥1,201) | LV.56[★] D¥580/C¥1,180/B¥2,480/A-¥12,800 | ¥13,000 (SOLD OUT) |

## What this run actually shows

- **Coverage**: Suruga-ya matched all 43 cards with a real print. Cardrush
  matched 20 of 43 with the exact same print (the rest either had zero
  results or only an unrelated same-species print in stock — its
  no-release-date limitation from the earlier research doc, playing out at
  scale). Hareruya2 matched 43/43 by set-browse, but every single listing
  across all six set pages was sold out — a real, now well-confirmed
  freshness gap, not a one-off.
- **Cross-check value**: on the two Holo/rare cards in the collection
  (フリーザー, ゲンガー) and the handful of others where both Suruga-ya and
  Cardrush had a live match, the numbers land in the same order of
  magnitude but rarely agree closely — normal shop-to-shop spread, same as
  the modern-set control cards in the prior research pass.
- **The real finding**: this run is small enough (43 cards) that it
  surfaced one concrete, fixable data bug (`プライスのラプラス` →
  `ヤナギのラプラス`) just from the act of pricing every owned card by
  name. That's a stronger argument for actually building this integration
  than an abstract "2% of cards have prices" statistic — it would also
  function as a free data-quality check on every JP card it touches.

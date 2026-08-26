import unittest

from services.suruga_ya_pricing import (
    build_candidate,
    build_search_url,
    parse_price_range,
    parse_release_date,
    select_best_match,
)


class ParsingTests(unittest.TestCase):
    def test_parse_release_date(self):
        self.assertEqual(parse_release_date("[発売日：1996/10/20]"), "1996-10-20")
        self.assertIsNone(parse_release_date(None))
        self.assertIsNone(parse_release_date("no date here"))

    def test_parse_price_range_with_range(self):
        self.assertEqual(parse_price_range("中古：￥580  ～ ￥1,280 税込"), (580.0, 1280.0))

    def test_parse_price_range_single_price(self):
        self.assertEqual(parse_price_range("中古：￥280   税込"), (280.0, 280.0))

    def test_parse_price_range_out_of_stock(self):
        self.assertEqual(parse_price_range("品切れ"), (None, None))

    def test_parse_price_range_empty(self):
        self.assertEqual(parse_price_range(None), (None, None))

    def test_build_search_url_encodes_japanese(self):
        url = build_search_url("フシギダネ　旧裏")
        self.assertTrue(url.startswith("https://www.suruga-ya.jp/search?search_word="))
        self.assertIn("%E3%83%95", url)


class BuildCandidateTests(unittest.TestCase):
    def test_vintage_listing_with_rarity_marker(self):
        candidate = build_candidate(
            title="No.001[●]：フシギダネ LV.13",
            release_date_line="[発売日：1996/10/20]",
            price_text="中古：￥580  ～ ￥1,280 税込",
            marketplace_text="￥380",
            product_url="https://www.suruga-ya.jp/product/detail/G3304114",
        )
        self.assertEqual(candidate.title, "No.001[●]：フシギダネ LV.13")
        self.assertEqual(candidate.rarity_marker, "●")
        self.assertFalse(candidate.is_holo)
        self.assertIsNone(candidate.number)
        self.assertEqual(candidate.release_date, "1996-10-20")
        self.assertEqual((candidate.price_low, candidate.price_high), (580.0, 1280.0))
        self.assertEqual(candidate.marketplace_price, 380.0)
        self.assertTrue(candidate.in_stock)

    def test_holo_star_rare_listing(self):
        candidate = build_candidate(
            title="No.094[★]：(キラ)ゲンガー LV.38（Cランク）",
            release_date_line="[発売日：1997/06/21]",
            price_text="中古：￥14,800   税込",
            marketplace_text="￥39,760",
            product_url="/product/other/X1",
        )
        self.assertTrue(candidate.is_holo)
        self.assertEqual(candidate.rarity_marker, "★")
        self.assertEqual(candidate.product_url, "/product/other/X1")

    def test_out_of_stock_listing(self):
        candidate = build_candidate(
            title="ディフェンダー",
            release_date_line="[発売日：1996/10/20]",
            price_text=None,
            marketplace_text="￥280",
            product_url="",
        )
        self.assertFalse(candidate.in_stock)
        self.assertIsNone(candidate.price_low)
        self.assertEqual(candidate.marketplace_price, 280.0)

    def test_modern_number_total_listing(self):
        candidate = build_candidate(
            title="046/184[RRR]：(キラ)ピカチュウVMAX",
            release_date_line="[発売日：2021/12/03]",
            price_text="中古：￥610 ～ ￥980   税込",
            marketplace_text="￥380",
            product_url="/product/other/Y1",
        )
        self.assertEqual((candidate.number, candidate.total), ("046", "184"))
        self.assertTrue(candidate.is_holo)


class SelectBestMatchTests(unittest.TestCase):
    def _candidate(self, **overrides):
        base = build_candidate(
            title="No.001[●]：フシギダネ LV.13",
            release_date_line="[発売日：1996/10/20]",
            price_text="中古：￥280   税込",
            marketplace_text="￥180",
            product_url="u1",
        )
        for key, value in overrides.items():
            setattr(base, key, value)
        return base

    def test_returns_none_with_no_candidates(self):
        self.assertIsNone(select_best_match([], target_release_date="1996-10-20"))

    def test_returns_none_when_no_signal_matches(self):
        candidates = [self._candidate(release_date="1999-01-01")]
        self.assertIsNone(select_best_match(candidates, target_release_date="1996-10-20"))

    def test_matches_by_release_date(self):
        candidates = [
            self._candidate(release_date="1999-01-01"),
            self._candidate(release_date="1996-10-20"),
        ]
        result = select_best_match(candidates, target_release_date="1996-10-20")
        self.assertEqual(result.release_date, "1996-10-20")

    def test_prefers_holo_when_variant_owned_is_holo(self):
        plain = self._candidate(release_date="1996-10-20", is_holo=False)
        holo = self._candidate(release_date="1996-10-20", is_holo=True)
        result = select_best_match(
            [plain, holo], target_release_date="1996-10-20", prefer_holo=True
        )
        self.assertTrue(result.is_holo)

    def test_prefers_normal_when_variant_owned_is_normal(self):
        plain = self._candidate(release_date="1996-10-20", is_holo=False)
        holo = self._candidate(release_date="1996-10-20", is_holo=True)
        result = select_best_match(
            [plain, holo], target_release_date="1996-10-20", prefer_holo=False
        )
        self.assertFalse(result.is_holo)

    def test_number_total_match_wins_outright_without_release_date(self):
        candidates = [
            self._candidate(number="046", total="184", release_date=None),
            self._candidate(number="077", total="184", release_date="1996-10-20"),
        ]
        result = select_best_match(candidates, target_number="046", target_total="184")
        self.assertEqual(result.number, "046")

    def test_prefers_in_stock_among_ambiguous_same_date_matches(self):
        out_of_stock = self._candidate(release_date="1996-10-20", in_stock=False, price_low=None)
        in_stock = self._candidate(release_date="1996-10-20", in_stock=True, price_low=280.0)
        result = select_best_match([out_of_stock, in_stock], target_release_date="1996-10-20")
        self.assertTrue(result.in_stock)


if __name__ == "__main__":
    unittest.main()

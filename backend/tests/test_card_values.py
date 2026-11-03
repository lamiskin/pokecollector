import unittest
from types import SimpleNamespace

from services.card_values import effective_market_price


class CardValueVariantTests(unittest.TestCase):
    def setUp(self):
        self.card = SimpleNamespace(
            price_market=26.81,
            price_trend=32.22,
            price_avg1=6.00,
            price_avg7=13.10,
            price_avg30=24.69,
            price_low=3.00,
            price_market_holo=11.49,
            price_trend_holo=12.91,
            price_avg1_holo=2.49,
            price_avg7_holo=9.65,
            price_avg30_holo=9.55,
            price_low_holo=3.00,
        )

    def test_normal_uses_base_cardmarket_price(self):
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 32.22)

    def test_standard_holo_uses_base_cardmarket_price(self):
        self.assertEqual(effective_market_price(self.card, 'Holo', 'price_trend'), 32.22)

    def test_reverse_holo_uses_alternate_holo_price(self):
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 12.91)

    def test_reverse_holo_falls_back_when_alternate_price_missing(self):
        self.card.price_trend_holo = 0
        self.card.price_market_holo = None
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 32.22)


class CardValueJpyFallbackTests(unittest.TestCase):
    def setUp(self):
        self.card = SimpleNamespace(
            price_market=None,
            price_trend=None,
            price_avg1=None,
            price_avg7=None,
            price_avg30=None,
            price_low=None,
            price_market_holo=None,
            price_trend_holo=None,
            price_avg1_holo=None,
            price_avg7_holo=None,
            price_avg30_holo=None,
            price_low_holo=None,
            price_jpy_eur_equivalent=5.02,
        )

    def test_falls_back_to_jpy_equivalent_when_no_cardmarket_price(self):
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 5.02)

    def test_reverse_holo_also_falls_back_to_jpy_equivalent(self):
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 5.02)

    def test_real_cardmarket_price_still_wins_over_jpy_fallback(self):
        self.card.price_trend = 32.22
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 32.22)

    def test_returns_zero_when_neither_cardmarket_nor_jpy_available(self):
        self.card.price_jpy_eur_equivalent = None
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 0)

    def test_missing_attribute_entirely_does_not_error(self):
        card_without_jpy_field = SimpleNamespace(price_market=None, price_trend=None)
        self.assertEqual(effective_market_price(card_without_jpy_field, 'Normal', 'price_trend'), 0)


class CardValueManualOverrideFallbackTests(unittest.TestCase):
    def setUp(self):
        self.card = SimpleNamespace(
            price_market=None,
            price_trend=None,
            price_avg1=None,
            price_avg7=None,
            price_avg30=None,
            price_low=None,
            price_market_holo=None,
            price_trend_holo=None,
            price_avg1_holo=None,
            price_avg7_holo=None,
            price_avg30_holo=None,
            price_low_holo=None,
            price_jpy_eur_equivalent=None,
            manual_value_override=12.5,
        )

    def test_falls_back_to_manual_override_when_no_cardmarket_or_jpy_price(self):
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 12.5)

    def test_reverse_holo_also_falls_back_to_manual_override(self):
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 12.5)

    def test_jpy_price_wins_over_manual_override(self):
        self.card.price_jpy_eur_equivalent = 5.02
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 5.02)

    def test_real_cardmarket_price_wins_over_manual_override(self):
        self.card.price_trend = 32.22
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 32.22)

    def test_returns_zero_when_nothing_available_at_all(self):
        self.card.manual_value_override = None
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 0)

    def test_missing_attribute_entirely_does_not_error(self):
        card_without_override_field = SimpleNamespace(price_market=None, price_trend=None)
        self.assertEqual(effective_market_price(card_without_override_field, 'Normal', 'price_trend'), 0)


if __name__ == '__main__':
    unittest.main()

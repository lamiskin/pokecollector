import unittest

from api.export import _convert_eur, _normalize_currency


class ExportCurrencyTests(unittest.TestCase):
    def test_normalize_currency_defaults_to_eur(self):
        self.assertEqual(_normalize_currency(None), ("EUR", "€"))
        self.assertEqual(_normalize_currency("gbp"), ("EUR", "€"))

    def test_normalize_currency_supports_usd_and_aud(self):
        self.assertEqual(_normalize_currency("usd"), ("USD", "$"))
        self.assertEqual(_normalize_currency("aud"), ("AUD", "A$"))

    def test_convert_eur_passes_through_for_eur(self):
        self.assertEqual(_convert_eur(10.0, 1.63, "EUR"), 10.0)

    def test_convert_eur_applies_rate_for_non_eur_currencies(self):
        self.assertEqual(_convert_eur(10.0, 1.1, "USD"), 11.0)
        self.assertAlmostEqual(_convert_eur(10.0, 1.63, "AUD"), 16.3)

    def test_convert_eur_passes_through_none(self):
        self.assertIsNone(_convert_eur(None, 1.63, "AUD"))


if __name__ == "__main__":
    unittest.main()

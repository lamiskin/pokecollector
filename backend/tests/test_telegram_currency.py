import unittest
from unittest.mock import MagicMock, patch

from services.telegram import _format_user_eur


class TelegramCurrencyTests(unittest.TestCase):
    def test_defaults_to_eur_with_no_db(self):
        self.assertEqual(_format_user_eur(12.5), "€12.50")

    @patch("services.telegram.httpx.Client")
    def test_converts_to_aud_using_live_rate(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.json.return_value = {"rate": 1.63}
        mock_client = MagicMock()
        mock_client.get.return_value = mock_response
        mock_client_cls.return_value.__enter__.return_value = mock_client

        db = MagicMock()
        row = MagicMock()
        row.value = "AUD"
        db.query.return_value.filter.return_value.first.return_value = row

        result = _format_user_eur(10.0, db=db, user_id=1)

        self.assertEqual(result, "A$16.30")
        mock_client.get.assert_called_once_with("https://api.frankfurter.dev/v2/rate/EUR/AUD")

    @patch("services.telegram.httpx.Client")
    def test_falls_back_to_static_rate_when_live_lookup_fails(self, mock_client_cls):
        mock_client_cls.return_value.__enter__.side_effect = Exception("network down")

        db = MagicMock()
        row = MagicMock()
        row.value = "AUD"
        db.query.return_value.filter.return_value.first.return_value = row

        result = _format_user_eur(10.0, db=db, user_id=1)

        self.assertEqual(result, "A$16.30")


if __name__ == "__main__":
    unittest.main()

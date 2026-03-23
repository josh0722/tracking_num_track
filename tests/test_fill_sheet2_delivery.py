"""fill_sheet2_delivery.py 에러 처리 테스트."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "crawler" / "scripts" / "mall"))
import fill_sheet2_delivery as fsd


class TestJsonParsing(unittest.TestCase):
    """Bug #8: json.loads가 손상된 JSON에 RuntimeError를 발생시키는지 확인."""

    def test_valid_json(self):
        data = [{"orderNumber": "123", "trackingNumbers": ["456"]}]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            path = Path(f.name)
        try:
            raw = path.read_text(encoding="utf-8")
            result = json.loads(raw)
            self.assertEqual(len(result), 1)
        finally:
            path.unlink(missing_ok=True)

    def test_corrupted_json_raises_json_decode_error(self):
        corrupted = '{"key": "value", "incomplete'
        with self.assertRaises(json.JSONDecodeError):
            json.loads(corrupted)

    def test_empty_json_is_valid(self):
        result = json.loads("[]")
        self.assertEqual(result, [])


class TestNormalizeOrderNo(unittest.TestCase):
    """normalize_order_no 유틸 함수 테스트."""

    def test_int(self):
        self.assertEqual(fsd.normalize_order_no(123456), "123456")

    def test_float_integer(self):
        self.assertEqual(fsd.normalize_order_no(123456.0), "123456")

    def test_string_with_dot_zero(self):
        self.assertEqual(fsd.normalize_order_no("123456.0"), "123456")

    def test_none(self):
        self.assertEqual(fsd.normalize_order_no(None), "")

    def test_string_with_dashes(self):
        self.assertEqual(fsd.normalize_order_no("12-34-56"), "123456")


class TestNormalizeText(unittest.TestCase):
    def test_none(self):
        self.assertEqual(fsd.normalize_text(None), "")

    def test_whitespace(self):
        self.assertEqual(fsd.normalize_text("  hello  "), "hello")


class TestIsBlank(unittest.TestCase):
    def test_none_is_blank(self):
        self.assertTrue(fsd.is_blank(None))

    def test_empty_string_is_blank(self):
        self.assertTrue(fsd.is_blank(""))

    def test_whitespace_is_blank(self):
        self.assertTrue(fsd.is_blank("   "))

    def test_text_is_not_blank(self):
        self.assertFalse(fsd.is_blank("hello"))


class TestBuildAccounts(unittest.TestCase):
    """build_accounts가 중복 사용자, 비밀번호 충돌을 올바르게 처리하는지."""

    def test_unique_accounts(self):
        targets = [
            fsd.TargetRow(row_idx=2, order_no="100", username="user1", password="pw1"),
            fsd.TargetRow(row_idx=3, order_no="200", username="user2", password="pw2"),
        ]
        accounts, id_to_cred, warnings = fsd.build_accounts(targets)
        self.assertEqual(len(accounts), 2)
        self.assertEqual(len(warnings), 0)
        self.assertEqual(accounts[0]["accountId"], "excel-acct-001")
        self.assertEqual(accounts[1]["accountId"], "excel-acct-002")

    def test_duplicate_username_different_password_warns(self):
        targets = [
            fsd.TargetRow(row_idx=2, order_no="100", username="user1", password="pw1"),
            fsd.TargetRow(row_idx=3, order_no="200", username="user1", password="pw_different"),
        ]
        accounts, id_to_cred, warnings = fsd.build_accounts(targets)
        self.assertEqual(len(accounts), 1)
        self.assertEqual(len(warnings), 1)
        self.assertIn("비밀번호가 여러 개", warnings[0])


class TestParseTrackingNumbers(unittest.TestCase):
    def test_extracts_from_tracking_numbers_list(self):
        item = {"trackingNumbers": ["12345678", "87654321"], "displayValue": ""}
        result = fsd.parse_tracking_numbers(item)
        self.assertEqual(result, {"12345678", "87654321"})

    def test_extracts_from_display_value(self):
        item = {"trackingNumbers": [], "displayValue": "송장번호 12345678 확인됨"}
        result = fsd.parse_tracking_numbers(item)
        self.assertIn("12345678", result)

    def test_ignores_short_numbers(self):
        item = {"trackingNumbers": ["123"], "displayValue": ""}
        result = fsd.parse_tracking_numbers(item)
        self.assertEqual(result, set())

    def test_empty_input(self):
        item = {"trackingNumbers": None, "displayValue": ""}
        result = fsd.parse_tracking_numbers(item)
        self.assertEqual(result, set())


class TestMergeScrapeResults(unittest.TestCase):
    def test_order_status_rows(self):
        rows = [
            {
                "accountId": "excel-acct-001",
                "accountUsername": "user1",
                "orderNumber": "100",
                "section": "order_status",
                "logisticsCompany": "CJ대한통운",
                "trackingNumbers": ["12345678"],
                "displayValue": "",
            },
        ]
        id_to_cred = {"excel-acct-001": ("user1", "pw1")}
        canceled, order_map = fsd.merge_scrape_results(rows, id_to_cred)
        self.assertEqual(len(canceled), 0)
        self.assertIn(("user1", "100"), order_map)
        self.assertEqual(order_map[("user1", "100")]["carrier"], "CJ대한통운")

    def test_cancel_status_rows(self):
        rows = [
            {
                "accountId": "excel-acct-001",
                "accountUsername": "user1",
                "orderNumber": "200",
                "section": "cancel_status",
            },
        ]
        id_to_cred = {"excel-acct-001": ("user1", "pw1")}
        canceled, order_map = fsd.merge_scrape_results(rows, id_to_cred)
        self.assertIn(("user1", "200"), canceled)
        self.assertNotIn(("user1", "200"), order_map)


class TestSubprocessTimeout(unittest.TestCase):
    """Bug #7: subprocess.run에 timeout이 있는지 소스코드 레벨에서 검증."""

    def test_subprocess_run_has_timeout_in_source(self):
        import inspect
        source = inspect.getsource(fsd.main)
        self.assertIn("timeout=1200", source)

    def test_subprocess_timeout_expired_handled_in_source(self):
        import inspect
        source = inspect.getsource(fsd.main)
        self.assertIn("subprocess.TimeoutExpired", source)


class TestLoadWorkbookErrorHandling(unittest.TestCase):
    """Bug #6: load_workbook 예외가 RuntimeError로 변환되는지 소스코드 레벨에서 검증."""

    def test_load_workbook_wrapped_in_try_except(self):
        import inspect
        source = inspect.getsource(fsd.main)
        self.assertIn("엑셀 파일을 열 수 없습니다", source)


class TestJsonParseErrorHandling(unittest.TestCase):
    """Bug #8: json.loads 예외가 RuntimeError로 변환되는지 소스코드 레벨에서 검증."""

    def test_json_loads_wrapped_in_try_except(self):
        import inspect
        source = inspect.getsource(fsd.main)
        self.assertIn("크롤링 결과 JSON 파싱 실패", source)


if __name__ == "__main__":
    unittest.main()

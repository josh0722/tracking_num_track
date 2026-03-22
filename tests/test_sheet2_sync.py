from __future__ import annotations

import unittest

from app.services.sheet2_sync import (
    _build_alias_map,
    _extract_delivery_contact,
    _extract_delivery_contact_from_progresses,
)


class DeliveryContactExtractionTests(unittest.TestCase):
    def test_extracts_cj_contact(self) -> None:
        description = "고객님의 상품이 배송완료 되었습니다.(담당사원:정승일 010-5556-1531)"
        self.assertEqual(_extract_delivery_contact(description), "담당사원:정승일 010-5556-1531")

    def test_extracts_hanjin_contact(self) -> None:
        description = "배송완료하였습니다. (배송사원 : 이미순 010-7515-5746)"
        self.assertEqual(_extract_delivery_contact(description), "배송사원 : 이미순 010-7515-5746")

    def test_extracts_lotte_like_contact(self) -> None:
        description = "배달예정입니다. 배송기사:홍길동 010-1234-5678"
        self.assertEqual(_extract_delivery_contact(description), "배송기사:홍길동 010-1234-5678")

    def test_extracts_postman_contact(self) -> None:
        description = "집배원 김우체 010-9876-5432 방문예정"
        self.assertEqual(_extract_delivery_contact(description), "집배원 김우체 010-9876-5432")

    def test_falls_back_to_latest_progress_with_contact(self) -> None:
        progresses = [
            {"description": "간선하차 되었습니다."},
            {"description": "배송출발하였습니다. (배송사원 : 이미순 010-7515-5746)"},
            {"description": "배송완료하였습니다."},
        ]
        self.assertEqual(
            _extract_delivery_contact_from_progresses(progresses),
            "배송사원 : 이미순 010-7515-5746",
        )


class CarrierAliasTests(unittest.TestCase):
    def test_build_alias_map_includes_major_korean_carriers(self) -> None:
        alias_map = _build_alias_map(
            {
                "kr.cjlogistics",
                "kr.hanjin",
                "kr.lotte",
                "kr.logen",
                "kr.epost",
                "kr.kdexp",
                "kr.cvsnet",
                "kr.cupost",
                "kr.daesin",
                "kr.ilyanglogis",
                "kr.hdexp",
                "kr.coupangls",
            }
        )
        self.assertEqual(alias_map["cj대한통운"], "kr.cjlogistics")
        self.assertEqual(alias_map["한진택배"], "kr.hanjin")
        self.assertEqual(alias_map["롯데택배"], "kr.lotte")
        self.assertEqual(alias_map["로젠택배"], "kr.logen")
        self.assertEqual(alias_map["우체국택배"], "kr.epost")
        self.assertEqual(alias_map["경동택배"], "kr.kdexp")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

from pydantic import AliasChoices, BaseModel, Field


class Sheet2WorkflowRequest(BaseModel):
    excel_path: str = Field(..., description="Sheet2 양식 엑셀 절대/상대 경로")
    crawler_path: str | None = Field(
        default=None,
        description="내장 crawler 또는 기존 croll_traking_num 경로",
        validation_alias=AliasChoices("crawler_path", "croll_repo_path"),
    )
    output_path: str | None = Field(default=None, description="결과 파일 경로 (미입력 시 *_managed.xlsx)")
    skip_crawl: bool = Field(default=False, description="true면 기존 results json으로만 처리")
    result_json: str | None = Field(default=None, description="skip_crawl=true일 때 사용할 results-*.json 경로")

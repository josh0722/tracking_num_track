from __future__ import annotations

from pydantic import BaseModel, Field


class PathDialogRequest(BaseModel):
    initial_path: str | None = Field(default=None, description="초기 경로")


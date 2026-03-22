from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from app.services.sheet2_sync import Sheet2SyncError, sync_sheet2_delivery_status


class WorkflowError(Exception):
    """Raised when the integrated mall workflow fails."""


@dataclass
class WorkflowPaths:
    repo_root: Path
    fill_script: Path
    excel_path: Path
    output_path: Path


def _default_crawler_repo() -> Path | None:
    candidates = [
        Path(__file__).resolve().parents[2] / "crawler",
        Path(__file__).resolve().parents[2] / ".." / "croll_traking_num",
        Path(__file__).resolve().parents[2] / ".." / "croll_tracking_num",
    ]
    for candidate in candidates:
        resolved = candidate.resolve()
        if (resolved / "scripts" / "mall" / "fill_sheet2_delivery.py").exists():
            return resolved
    return None


def _resolve_paths(
    excel_path: str,
    output_path: str | None,
    crawler_path: str | None,
) -> WorkflowPaths:
    excel = Path(excel_path).expanduser().resolve()
    if not excel.exists():
        raise WorkflowError(f"엑셀 파일이 존재하지 않습니다: {excel}")

    if output_path:
        output = Path(output_path).expanduser().resolve()
    else:
        output = excel.with_name(f"{excel.stem}_managed{excel.suffix}")

    if crawler_path:
        repo_root = Path(crawler_path).expanduser().resolve()
    else:
        detected = _default_crawler_repo()
        if not detected:
            raise WorkflowError("crawler 폴더를 찾지 못했습니다. 경로를 직접 입력해주세요.")
        repo_root = detected

    fill_script = repo_root / "scripts" / "mall" / "fill_sheet2_delivery.py"
    if not fill_script.exists():
        raise WorkflowError(f"fill_sheet2_delivery.py를 찾지 못했습니다: {fill_script}")

    return WorkflowPaths(
        repo_root=repo_root,
        fill_script=fill_script,
        excel_path=excel,
        output_path=output,
    )


def _run_fill_script(paths: WorkflowPaths, skip_crawl: bool, result_json: str | None) -> subprocess.CompletedProcess[str]:
    cmd: list[str] = [
        sys.executable,
        str(paths.fill_script),
        "--excel",
        str(paths.excel_path),
        "--output",
        str(paths.output_path),
    ]

    if skip_crawl:
        cmd.append("--skip-crawl")
        if result_json:
            cmd.extend(["--result-json", str(Path(result_json).expanduser().resolve())])

    env = os.environ.copy()
    env["MALL_REPO_ROOT"] = str(paths.repo_root)

    return subprocess.run(
        cmd,
        cwd=paths.repo_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


async def run_integrated_sheet2_workflow(
    excel_path: str,
    output_path: str | None,
    crawler_path: str | None,
    skip_crawl: bool,
    result_json: str | None,
) -> dict:
    paths = _resolve_paths(
        excel_path=excel_path,
        output_path=output_path,
        crawler_path=crawler_path,
    )

    fill_result = await asyncio.to_thread(
        _run_fill_script,
        paths,
        skip_crawl,
        result_json,
    )

    if fill_result.returncode != 0:
        stderr = (fill_result.stderr or "").strip()
        stdout = (fill_result.stdout or "").strip()
        combined = "\n".join([part for part in [stdout, stderr] if part])
        raise WorkflowError(f"SK스토아 크롤링/엑셀 반영 실패\n{combined}")

    try:
        tracking_summary = await sync_sheet2_delivery_status(str(paths.output_path))
    except Sheet2SyncError as exc:
        raise WorkflowError(str(exc)) from exc

    return {
        "excel_input": str(paths.excel_path),
        "excel_output": str(paths.output_path),
        "crawl_repo": str(paths.repo_root),
        "crawl_stdout": fill_result.stdout,
        "crawl_stderr": fill_result.stderr,
        "tracking_summary": tracking_summary,
    }

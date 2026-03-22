from __future__ import annotations
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models.dialog import PathDialogRequest
from app.models.workflow import Sheet2WorkflowRequest
from app.services.workflow import WorkflowError, run_integrated_sheet2_workflow


app = FastAPI(title="Sheet2 배송 관리기", version="0.1.0")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _pick_open_file(initial_path: str | None, title: str, filetypes: list[tuple[str, str]]) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise RuntimeError("파일 선택창을 사용할 수 없습니다. tkinter 설치를 확인해주세요.") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    kwargs: dict = {"title": title, "filetypes": filetypes}
    if initial_path:
        initial = Path(initial_path).expanduser()
        if initial.is_dir():
            kwargs["initialdir"] = str(initial)
        else:
            kwargs["initialdir"] = str(initial.parent)
            kwargs["initialfile"] = initial.name

    try:
        selected = filedialog.askopenfilename(**kwargs)
        return selected or None
    finally:
        root.destroy()


def _pick_directory(initial_path: str | None, title: str) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise RuntimeError("폴더 선택창을 사용할 수 없습니다. tkinter 설치를 확인해주세요.") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    kwargs: dict = {"title": title}
    if initial_path:
        initial = Path(initial_path).expanduser()
        if initial.is_dir():
            kwargs["initialdir"] = str(initial)
        else:
            kwargs["initialdir"] = str(initial.parent)

    try:
        selected = filedialog.askdirectory(**kwargs)
        return selected or None
    finally:
        root.destroy()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/workflows/sync-sheet2")
async def run_sheet2_sync(payload: Sheet2WorkflowRequest) -> dict:
    try:
        return await run_integrated_sheet2_workflow(
            excel_path=payload.excel_path,
            output_path=payload.output_path,
            crawler_path=payload.crawler_path,
            skip_crawl=payload.skip_crawl,
            result_json=payload.result_json,
        )
    except WorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/dialog/select-excel")
async def select_excel(payload: PathDialogRequest) -> dict:
    try:
        path = _pick_open_file(
            payload.initial_path,
            "Sheet2 엑셀 파일 선택",
            [("Excel 파일", "*.xlsx"), ("모든 파일", "*.*")],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"path": path}


@app.post("/api/dialog/select-repo")
async def select_repo(payload: PathDialogRequest) -> dict:
    try:
        path = _pick_directory(
            payload.initial_path,
            "crawler 폴더 선택",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"path": path}

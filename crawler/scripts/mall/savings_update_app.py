#!/usr/bin/env python3
"""SK스토아 적립금/멤버십할인 조회 GUI.

`manual_update_app.py` 와 UI/스레드 구조가 동일하다. 차이점은:
  - fill_script 가 `fill_savings.py`
  - 번들 워커 exe 이름이 `SavingsWorker.exe`
  - 기본 출력 파일 접미사가 `_적립금조회완료`
  - 창 제목 / 라벨이 적립금용 문구
"""
from __future__ import annotations

import os
import platform
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext


class SavingsUpdateApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("엑셀 적립금 조회 업데이트")
        self.root.geometry("860x560")

        self.repo_root = self._detect_repo_root()
        self.fill_script = self.repo_root / "scripts" / "mall" / "fill_savings.py"
        self.log_queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self.running = False
        self._process: subprocess.Popen | None = None

        self.input_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.status_var = tk.StringVar(value="대기 중")

        self._build_ui()
        self.root.after(100, self._poll_logs)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _detect_repo_root(self) -> Path:
        env_root = os.environ.get("MALL_REPO_ROOT", "").strip()
        candidates: list[Path] = []
        if env_root:
            candidates.append(Path(env_root).expanduser().resolve())

        candidates.append(Path.cwd().resolve())
        this_file = Path(__file__).resolve()
        candidates.extend(this_file.parents)

        if getattr(sys, "frozen", False):
            exe = Path(sys.executable).resolve()
            candidates.extend(exe.parents)
            candidates.append(exe.parent / "project")
            if exe.parent.parent:
                candidates.append(exe.parent.parent / "project")

        seen: set[Path] = set()
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            if (candidate / "package.json").exists() and (
                candidate / "scripts" / "mall" / "fill_savings.py"
            ).exists():
                return candidate

        return this_file.parents[2]

    def _build_ui(self) -> None:
        pad_x = 10
        pad_y = 8

        frame = tk.Frame(self.root)
        frame.pack(fill="both", expand=True, padx=pad_x, pady=pad_y)

        _font = "Apple SD Gothic Neo" if platform.system() == "Darwin" else "Malgun Gothic"
        title = tk.Label(frame, text="원할 때 실행: 적립금/멤버십할인 조회", font=(_font, 16, "bold"))
        title.pack(anchor="w", pady=(0, 12))

        input_row = tk.Frame(frame)
        input_row.pack(fill="x", pady=(0, 6))
        tk.Label(input_row, text="입력 엑셀").pack(side="left")
        tk.Entry(input_row, textvariable=self.input_var).pack(side="left", fill="x", expand=True, padx=8)
        tk.Button(input_row, text="파일 선택", command=self._choose_input).pack(side="left")

        output_row = tk.Frame(frame)
        output_row.pack(fill="x", pady=(0, 12))
        tk.Label(output_row, text="출력 엑셀").pack(side="left")
        tk.Entry(output_row, textvariable=self.output_var).pack(side="left", fill="x", expand=True, padx=8)
        tk.Button(output_row, text="저장 위치", command=self._choose_output).pack(side="left")

        control_row = tk.Frame(frame)
        control_row.pack(fill="x", pady=(0, 8))
        self.run_button = tk.Button(control_row, text="돌리기", width=14, command=self._start_run)
        self.run_button.pack(side="left")
        tk.Label(control_row, textvariable=self.status_var).pack(side="left", padx=12)

        tk.Label(frame, text="실행 로그").pack(anchor="w")
        self.log_text = scrolledtext.ScrolledText(frame, height=20, state="disabled")
        self.log_text.pack(fill="both", expand=True)

    def _python_has_openpyxl(self, python_cmd: str) -> bool:
        try:
            subprocess.run(
                [python_cmd, "-c", "import openpyxl"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except Exception:
            return False

    def _pick_python_cmd(self) -> str:
        candidates: list[str] = []

        env_python = os.environ.get("MALL_PYTHON_BIN", "").strip()
        if env_python:
            candidates.append(env_python)

        if not getattr(sys, "frozen", False):
            candidates.append(sys.executable)

        _username = os.environ.get("USERNAME", os.environ.get("USER", ""))
        for p in [
            shutil.which("python3") or "",
            shutil.which("python") or "",
            "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            r"C:\Python313\python.exe",
            r"C:\Python312\python.exe",
            r"C:\Python311\python.exe",
            rf"C:\Users\{_username}\AppData\Local\Programs\Python\Python313\python.exe",
            rf"C:\Users\{_username}\AppData\Local\Programs\Python\Python312\python.exe",
            rf"C:\Users\{_username}\AppData\Local\Programs\Python\Python311\python.exe",
        ]:
            if p:
                candidates.append(p)

        seen: set[str] = set()
        for candidate in candidates:
            if not candidate:
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            if not Path(candidate).exists():
                continue
            if getattr(sys, "frozen", False) and Path(candidate).resolve() == Path(sys.executable).resolve():
                continue
            if self._python_has_openpyxl(candidate):
                return candidate

        return ""

    def _pick_worker_exe(self) -> str:
        candidates: list[Path] = []

        env_worker = os.environ.get("MALL_SAVINGS_WORKER_BIN", "").strip()
        if env_worker:
            candidates.append(Path(env_worker).expanduser())

        exe_path = Path(sys.executable).resolve()
        candidates.extend(
            [
                exe_path.with_name("SavingsWorker.exe"),
                exe_path.parent / "SavingsWorker.exe",
                self.repo_root / "runtime" / "SavingsWorker.exe",
                self.repo_root / "app" / "SavingsWorker.exe",
            ]
        )

        seen: set[Path] = set()
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            if candidate.exists():
                return str(candidate)

        return ""

    def _choose_input(self) -> None:
        file_path = filedialog.askopenfilename(
            title="입력 엑셀 파일 선택 (SK스토아 적립금 조회.xlsx)",
            filetypes=[("Excel 파일", "*.xlsx"), ("모든 파일", "*.*")],
        )
        if not file_path:
            return
        self.input_var.set(file_path)
        if not self.output_var.get().strip():
            self.output_var.set(str(self._default_output_path(Path(file_path))))

    def _choose_output(self) -> None:
        current_input = self.input_var.get().strip()
        initial_path = self._default_output_path(Path(current_input)) if current_input else ""
        file_path = filedialog.asksaveasfilename(
            title="결과 엑셀 파일 저장 위치",
            defaultextension=".xlsx",
            initialfile=Path(initial_path).name if initial_path else "적립금조회완료.xlsx",
            filetypes=[("Excel 파일", "*.xlsx"), ("모든 파일", "*.*")],
        )
        if file_path:
            self.output_var.set(file_path)

    def _default_output_path(self, input_path: Path) -> Path:
        return input_path.with_name(f"{input_path.stem}_적립금조회완료{input_path.suffix}")

    def _append_log(self, line: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.run_button.configure(state="disabled" if running else "normal")
        self.status_var.set("실행 중..." if running else "대기 중")

    def _on_close(self) -> None:
        proc = self._process
        if proc is not None and proc.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                else:
                    proc.terminate()
                    proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self.root.destroy()

    def _start_run(self) -> None:
        if self.running:
            return

        input_path_text = self.input_var.get().strip()
        if not input_path_text:
            messagebox.showwarning("입력 필요", "입력 엑셀 파일을 먼저 선택하세요.")
            return

        input_path = Path(input_path_text).expanduser().resolve()
        if not input_path.exists():
            messagebox.showerror("파일 없음", f"입력 파일을 찾을 수 없습니다.\n{input_path}")
            return

        output_path_text = self.output_var.get().strip()
        output_path = (
            Path(output_path_text).expanduser().resolve()
            if output_path_text
            else self._default_output_path(input_path).resolve()
        )
        self.output_var.set(str(output_path))

        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

        self._set_running(True)
        self._append_log(f"[INFO] 입력 파일: {input_path}")
        self._append_log(f"[INFO] 출력 파일: {output_path}")

        worker = threading.Thread(
            target=self._run_fill_script,
            args=(input_path, output_path),
            daemon=True,
        )
        worker.start()

    def _run_fill_script(self, input_path: Path, output_path: Path) -> None:
        worker_exe = ""
        if getattr(sys, "frozen", False):
            worker_exe = self._pick_worker_exe()

        if worker_exe:
            cmd = [
                worker_exe,
                "--excel",
                str(input_path),
                "--output",
                str(output_path),
            ]
        else:
            python_cmd = self._pick_python_cmd()
            if not python_cmd:
                self.log_queue.put(
                    (
                        "error",
                        "실행 도구를 찾지 못했습니다. Worker exe 또는 openpyxl이 설치된 Python이 필요합니다.",
                    )
                )
                return

            cmd = [
                python_cmd,
                str(self.fill_script),
                "--excel",
                str(input_path),
                "--output",
                str(output_path),
            ]

        try:
            env = os.environ.copy()
            env["MALL_REPO_ROOT"] = str(self.repo_root)
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUTF8"] = "1"
            if not env.get("MALL_NPM_BIN"):
                for npm_candidate in (
                    str(self.repo_root / "runtime" / "node" / "npm.cmd"),
                    str(self.repo_root / "runtime" / "node" / "npm"),
                    "/opt/homebrew/bin/npm",
                    "/usr/local/bin/npm",
                    "/usr/bin/npm",
                ):
                    if Path(npm_candidate).exists():
                        env["MALL_NPM_BIN"] = npm_candidate
                        break
            if not env.get("MALL_NODE_BIN"):
                for node_candidate in (
                    str(self.repo_root / "runtime" / "node" / "node.exe"),
                    str(self.repo_root / "runtime" / "node" / "node"),
                    "/opt/homebrew/bin/node",
                    "/usr/local/bin/node",
                    "/usr/bin/node",
                ):
                    if Path(node_candidate).exists():
                        env["MALL_NODE_BIN"] = node_candidate
                        break
            if worker_exe:
                self.log_queue.put(("log", f"[INFO] worker: {worker_exe}"))
            else:
                self.log_queue.put(("log", f"[INFO] python: {cmd[0]}"))
            creation_flags = 0
            if os.name == "nt":
                creation_flags = subprocess.CREATE_NO_WINDOW
            self._process = subprocess.Popen(
                cmd,
                cwd=self.repo_root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
        except Exception as exc:
            self.log_queue.put(("error", f"프로그램 실행 실패: {exc}"))
            return

        try:
            assert self._process.stdout is not None
            last_error_line = ""
            for line in self._process.stdout:
                clean = line.rstrip()
                self.log_queue.put(("log", clean))
                if clean.startswith("[ERROR]"):
                    last_error_line = clean

            try:
                return_code = self._process.wait(timeout=14400)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self.log_queue.put(("error", "프로세스가 응답하지 않아 강제 종료했습니다."))
                return

            if return_code == 0:
                self.log_queue.put(("done", str(output_path)))
            else:
                if last_error_line:
                    self.log_queue.put(("error", f"{last_error_line} (exit code: {return_code})"))
                else:
                    self.log_queue.put(("error", f"업데이트 실패 (exit code: {return_code})"))
        finally:
            self._process = None

    def _poll_logs(self) -> None:
        while True:
            try:
                kind, payload = self.log_queue.get_nowait()
            except queue.Empty:
                break

            if kind == "log":
                self._append_log(payload)
            elif kind == "done":
                self._append_log("[DONE] 적립금 조회 완료")
                self._set_running(False)
                messagebox.showinfo("완료", f"결과 파일 생성 완료\n{payload}")
            elif kind == "error":
                self._append_log(f"[ERROR] {payload}")
                self._set_running(False)
                messagebox.showerror("실패", payload)

        self.root.after(100, self._poll_logs)


def main() -> None:
    root = tk.Tk()
    app = SavingsUpdateApp(root)
    _ = app
    root.mainloop()


if __name__ == "__main__":
    main()

"""manual_update_app.py 프로세스 관리 테스트."""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "crawler" / "scripts" / "mall"))
import manual_update_app as mua


class TestOnCloseProcessCleanup(unittest.TestCase):
    """Bug #9: 앱 종료 시 서브프로세스 정리가 되는지 검증."""

    def _make_app_with_mock_root(self) -> mua.ManualUpdateApp:
        """Tkinter 없이 ManualUpdateApp 인스턴스 생성."""
        mock_root = MagicMock()
        mock_root.title = MagicMock()
        mock_root.geometry = MagicMock()
        mock_root.protocol = MagicMock()
        mock_root.after = MagicMock()
        mock_root.destroy = MagicMock()

        with patch.object(mua.ManualUpdateApp, "_detect_repo_root", return_value=Path(".")):
            with patch("tkinter.StringVar", MagicMock):
                with patch.object(mua.ManualUpdateApp, "_build_ui"):
                    app = mua.ManualUpdateApp(mock_root)
        return app

    def test_on_close_with_no_process(self):
        """프로세스가 없을 때 _on_close 호출해도 크래시하지 않는지."""
        app = self._make_app_with_mock_root()
        app._process = None
        app._on_close()
        app.root.destroy.assert_called_once()

    def test_on_close_terminates_running_process_unix(self):
        """Unix에서 실행 중인 프로세스를 terminate하는지."""
        app = self._make_app_with_mock_root()
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # 아직 실행 중
        mock_proc.wait.return_value = 0
        app._process = mock_proc

        with patch("os.name", "posix"):
            app._on_close()

        mock_proc.terminate.assert_called_once()
        app.root.destroy.assert_called_once()

    def test_on_close_kills_if_terminate_fails_unix(self):
        """terminate() 실패 시 kill() 호출하는지."""
        app = self._make_app_with_mock_root()
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.terminate.side_effect = Exception("terminate failed")
        app._process = mock_proc

        with patch("os.name", "posix"):
            app._on_close()

        mock_proc.kill.assert_called_once()
        app.root.destroy.assert_called_once()

    def test_on_close_with_already_exited_process(self):
        """이미 종료된 프로세스는 terminate/kill하지 않는지."""
        app = self._make_app_with_mock_root()
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0  # 이미 종료됨
        app._process = mock_proc

        app._on_close()

        mock_proc.terminate.assert_not_called()
        mock_proc.kill.assert_not_called()
        app.root.destroy.assert_called_once()

    def test_on_close_uses_taskkill_on_windows(self):
        """Windows에서 taskkill /F /T /PID를 사용하는지."""
        app = self._make_app_with_mock_root()
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.pid = 12345
        app._process = mock_proc

        with patch("os.name", "nt"), patch("subprocess.run") as mock_run:
            app._on_close()
            mock_run.assert_called_once()
            call_args = mock_run.call_args[0][0]
            self.assertEqual(call_args, ["taskkill", "/F", "/T", "/PID", "12345"])

        app.root.destroy.assert_called_once()


class TestProcessInstanceVariable(unittest.TestCase):
    """Bug #10: _process가 인스턴스 변수로 존재하는지."""

    def test_process_attribute_exists(self):
        """ManualUpdateApp에 _process 속성이 있는지."""
        import inspect
        source = inspect.getsource(mua.ManualUpdateApp.__init__)
        self.assertIn("self._process", source)

    def test_wm_delete_window_handler_registered(self):
        """WM_DELETE_WINDOW 핸들러가 등록되는지."""
        import inspect
        source = inspect.getsource(mua.ManualUpdateApp.__init__)
        self.assertIn("WM_DELETE_WINDOW", source)


class TestRunFillScriptProcessManagement(unittest.TestCase):
    """Bug #10, #11: _run_fill_script에서 self._process 사용 및 finally 정리."""

    def test_process_stored_as_instance_variable(self):
        import inspect
        source = inspect.getsource(mua.ManualUpdateApp._run_fill_script)
        self.assertIn("self._process = subprocess.Popen", source)

    def test_process_cleared_in_finally(self):
        import inspect
        source = inspect.getsource(mua.ManualUpdateApp._run_fill_script)
        self.assertIn("self._process = None", source)

    def test_wait_has_timeout(self):
        import inspect
        source = inspect.getsource(mua.ManualUpdateApp._run_fill_script)
        self.assertIn("timeout=1260", source)


if __name__ == "__main__":
    unittest.main()

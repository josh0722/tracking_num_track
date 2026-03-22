const syncForm = document.getElementById("sync-form");
const excelPathInput = document.getElementById("excel-path");
const syncLog = document.getElementById("sync-log");
const pickExcelButton = document.getElementById("pick-excel");

const writeSyncLog = (lines) => {
  syncLog.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines ?? "");
};

const pickPathWithDialog = async (endpoint, inputEl) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initial_path: inputEl.value.trim() || null,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "경로 선택 중 오류가 발생했습니다.");
  }
  if (payload.path) {
    inputEl.value = payload.path;
  }
};

pickExcelButton.addEventListener("click", async () => {
  try {
    await pickPathWithDialog("/api/dialog/select-excel", excelPathInput);
  } catch (error) {
    writeSyncLog(error.message || "엑셀 경로 선택에 실패했습니다.");
  }
});

syncForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const body = {
    excel_path: excelPathInput.value.trim(),
    output_path: null,
    crawler_path: null,
    skip_crawl: false,
    result_json: null,
  };

  if (!body.excel_path) {
    writeSyncLog("엑셀 경로를 입력해주세요.");
    return;
  }

  const submitButton = syncForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  writeSyncLog("통합 실행을 시작합니다. 데이터 양에 따라 수 분 이상 걸릴 수 있습니다.");

  try {
    const response = await fetch("/api/workflows/sync-sheet2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "통합 실행 실패");
    }

    const lines = [
      `[완료] 결과 파일: ${payload.excel_output}`,
      "",
      "[배송현황 업데이트 요약]",
      `- 업데이트 행: ${payload.tracking_summary.updated_rows}`,
      `- 미입력 행(AB/AC 없음): ${payload.tracking_summary.missing_carrier_or_invoice}`,
      `- 택배사 매칭 실패: ${payload.tracking_summary.unresolved_carrier_rows}`,
      `- 조회 실패 행: ${payload.tracking_summary.track_lookup_failed_rows}`,
      "",
      "[크롤링 로그 요약]",
      (payload.crawl_stdout || "").slice(-3000) || "(stdout 없음)",
    ];

    if (payload.tracking_summary.unresolved_carrier_samples?.length) {
      lines.push("");
      lines.push("[택배사 매칭 실패 샘플]");
      for (const sample of payload.tracking_summary.unresolved_carrier_samples) {
        lines.push(`- row ${sample.row}: ${sample.carrier} / ${sample.invoice}`);
      }
    }

    writeSyncLog(lines);
  } catch (error) {
    writeSyncLog(error.message || "통합 실행 중 오류가 발생했습니다.");
  } finally {
    submitButton.disabled = false;
  }
});

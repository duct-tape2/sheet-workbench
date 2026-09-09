export const releaseText = {
  en: {
    versions: "Versions",
    versionsHelp:
      "Each confirmed revision keeps its own snapshot and original workbook reference. Download a past working copy without replacing your current source.",
    snapshot: "Download JSON",
    workbook: "Download XLSX",
    loading: "Loading…",
    preparingDownload: "Preparing download…",
    downloadStarted: "Download started. Check your browser's Downloads folder.",
    downloadFailed: "Download failed. Try again.",
    retry: "Try again",
    close: "Close",
    rows: "rows",
    empty: "No versions yet. Import a workbook to start a version history.",
    pending:
      "Your save is queued on the server. Keep this draft unchanged while it checks the source; the confirmed views update when saving finishes.",
    uncertain:
      "The response did not arrive. Checking the original request before allowing another save.",
    queuedFailed:
      "This request needs review. Refresh the source and compare the latest values before submitting a new change.",
    append:
      "Saving adds a new row to the connected Google sheet. Only the selected columns are filled. Check any extra company-required fields in Google Sheets afterward.",
    appendConsent:
      "Allow this row and its hidden operation marker to be added to Google Sheets. The marker prevents duplicate rows if a response is lost.",
    identity: "Source connection",
    identityHelp:
      "Google writes need a hidden row identity so sorting does not change which row is edited. It does not add visible columns or change cell values.",
    consent:
      "Allow hidden identifiers on the selected rows in this Google file.",
    reviewIdentity: "Review source rows",
    previewRows: "new source rows need hidden identities:",
    previewEmpty:
      "No new source rows were found. Review this snapshot before confirming row identity.",
    previewRequired:
      "Review the current source rows before allowing hidden identifiers.",
    enable: "Set up row identity",
    identityReady: "Stable row identity is configured.",
    jobs: "Recent source saves",
    noJobs: "No source saves yet.",
  },
  ko: {
    versions: "버전 기록",
    versionsHelp:
      "확정된 수정마다 당시 자료와 원본 파일 정보를 보관합니다. 현재 원본을 바꾸지 않고 이전 작업본을 내려받을 수 있습니다.",
    snapshot: "JSON 다운로드",
    workbook: "XLSX 다운로드",
    loading: "불러오는 중…",
    preparingDownload: "다운로드 준비 중…",
    downloadStarted:
      "다운로드를 시작했습니다. 브라우저의 다운로드 폴더를 확인해 주세요.",
    downloadFailed: "다운로드하지 못했습니다. 다시 시도해 주세요.",
    retry: "다시 확인",
    close: "닫기",
    rows: "행",
    empty: "아직 저장된 버전이 없습니다. 파일을 가져오면 기록이 시작됩니다.",
    pending:
      "저장 요청을 서버에 보관했습니다. 원본을 확인하는 동안 이 초안은 잠시 수정할 수 없습니다. 저장이 확인되면 표·달력·보고서가 함께 갱신됩니다.",
    uncertain:
      "서버 응답을 받지 못했습니다. 중복 저장을 막기 위해 기존 요청의 처리 상태를 확인하고 있습니다.",
    queuedFailed:
      "확인이 필요한 요청입니다. 원본을 새로고침하고 최신 내용과 비교한 뒤 다시 수정해 주세요.",
    append:
      "저장하면 연결한 Google 시트에 새 행을 추가합니다. 선택한 열만 채우므로 회사에서 요구하는 나머지 항목은 시트에서 확인해 주세요.",
    appendConsent:
      "Google 시트에 새 행과 숨은 작업 식별자를 추가하는 데 동의합니다. 응답이 끊겨도 같은 행이 중복으로 생성되지 않도록 사용하는 정보입니다.",
    identity: "원본 연결 관리",
    identityHelp:
      "Google 시트에 쓸 때는 정렬 후에도 같은 행을 찾도록 숨은 행 식별자가 필요합니다. 보이는 열이나 셀 내용은 바꾸지 않습니다.",
    consent:
      "이 Google 파일에서 선택한 행에 숨은 식별자를 기록하는 데 동의합니다.",
    reviewIdentity: "원본 행 검토",
    previewRows: "새 원본 행에 숨은 식별자가 필요합니다:",
    previewEmpty:
      "새 원본 행은 없습니다. 이 원본 상태를 검토한 뒤 행 식별자를 설정할 수 있습니다.",
    previewRequired:
      "숨은 식별자를 기록하기 전에 현재 원본 행을 검토해 주세요.",
    enable: "행 식별자 설정",
    identityReady: "고유한 행 식별자가 설정되어 있습니다.",
    jobs: "최근 원본 저장 요청",
    noJobs: "아직 원본 저장 요청이 없습니다.",
  },
};

export const gettingStarted = {
  en: {
    title: "Start with one sample task",
    steps: [
      [
        "Edit a row in Table",
        "Open Table, click a task title, change its title, date or status, then choose Save changes. You can try this without signing in.",
      ],
      [
        "Check Calendar and Board",
        "Open Calendar to see the date, or Board to see the status. These are different views of the same saved rows. Undated tasks stay in Table and Board.",
      ],
      [
        "Make your weekly report",
        "Open Report and set Period start and Period end to include the task’s date. Check any active filters, then choose Copy report or Download report. The downloaded report is a Markdown (.md) file.",
      ],
    ],
    excelTitle: "Ready to try an Excel file?",
    excel:
      "On a configured team server, sign in (or create an account), create or select a workspace, then choose Connect data → Excel file. Check the storage location, confirm sharing permission, and select a .xlsx file. Review the sheet, header row and column mapping, then preview and import. Start with a synthetic test file in this alpha.",
    export:
      "After editing, use Export → Download Excel to get a new .xlsx. Your original PC file is not overwritten. Check the browser’s Downloads list for the file.",
    google:
      "Google Sheets needs separate administrator setup. Real Google account connection is still unverified in this alpha; do not assume signing in here also connects Google.",
    static:
      "This public demo uses synthetic data in your browser only. Sign-in, file uploads and Google connection are disabled here. A local or self-hosted server is needed to try Excel uploads.",
    language:
      "Changing the interface language does not translate or erase your spreadsheet headings or records. For a fresh sample in the chosen language, use Reset sample below. Resetting or choosing another sample replaces your browser’s sample edits; export anything you want to keep first.",
  },
  ko: {
    title: "처음에는 샘플 업무 하나만 바꿔 보세요",
    steps: [
      [
        "표에서 업무를 수정해 보세요",
        "표 탭에서 업무 제목을 누르고 제목·날짜·상태를 바꾼 뒤 변경 저장을 눌러 주세요. 샘플은 로그인 없이도 수정할 수 있습니다.",
      ],
      [
        "달력과 상태 보드에서 확인하세요",
        "달력에서는 날짜별 일정을, 상태 보드에서는 진행 상황을 볼 수 있습니다. 따로 입력할 필요 없이 같은 저장 자료가 표시됩니다. 날짜가 없는 업무는 표와 상태 보드에서 확인해 주세요.",
      ],
      [
        "주간 보고를 만들어 보세요",
        "주간 보고 탭에서 업무 날짜가 포함되도록 시작일과 종료일을 정해 주세요. 검색·필터도 보고서에 적용되니 함께 확인해 주세요. 보고서 복사로 내용을 붙여넣거나, 보고서 저장으로 Markdown(.md) 파일을 받을 수 있습니다.",
      ],
    ],
    excelTitle: "엑셀 파일로도 해보고 싶다면",
    excel:
      "팀 서버가 준비된 환경에서는 로그인하거나 계정을 만든 뒤 작업 공간을 만들거나 선택해 주세요. 자료 연결 → Excel 파일에서 저장 위치를 확인하고 공유에 동의한 다음 .xlsx 파일을 고릅니다. 시트·제목 행·각 열의 용도를 확인하고 미리보기를 거쳐 가져오면 됩니다. 지금은 알파 버전이니 실제 회사 자료 대신 가상 테스트 파일부터 사용해 주세요.",
    export:
      "수정이 끝나면 내보내기 → Excel 내려받기로 새 .xlsx 파일을 받으세요. PC에 있던 원본 파일을 자동으로 덮어쓰지는 않습니다. 내려받은 파일은 브라우저 다운로드 목록에서 확인해 주세요.",
    google:
      "Google 시트는 관리자의 별도 연결 설정이 필요합니다. 실제 Google 계정 연결은 아직 이 알파 버전에서 검증되지 않았습니다. 여기서 로그인했다고 Google까지 연결된 것은 아닙니다.",
    static:
      "이 공개 데모는 브라우저에 저장되는 가상 자료만 사용합니다. 여기서는 로그인·파일 업로드·Google 연결을 제공하지 않습니다. 엑셀 업로드를 체험하려면 로컬 또는 설치형 서버가 필요합니다.",
    language:
      "화면 언어를 바꿔도 기존 자료의 열 이름이나 내용은 번역하거나 지우지 않습니다. 한국어 샘플까지 보고 싶다면 한국어를 선택한 뒤 아래 샘플 초기화를 눌러 주세요. 초기화하거나 다른 샘플을 고르면 지금까지 수정한 샘플이 바뀌므로, 남길 내용은 먼저 내보내 주세요.",
  },
} as const;

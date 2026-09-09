import type { Locale } from "../../../packages/core/src/index";

export const staticDemoText: Record<
  Locale,
  {
    importNotice: string;
    importHelp: string;
    accountNotice: string;
    accountHelp: string;
  }
> = {
  en: {
    importNotice:
      "This public demo uses synthetic rows only. It never accepts real files, account details, or Google authorizations.",
    importHelp:
      "To work with a real spreadsheet, clone and self-host Sheet Workbench with its server and PostgreSQL. The setup guide covers local and Docker starts.",
    accountNotice:
      "Account entry is disabled in this public demo. It only contains synthetic data stored in this browser.",
    accountHelp:
      "Self-host the application to create accounts, share a workspace, or connect a real source.",
  },
  ko: {
    importNotice:
      "이 공개 데모는 가상 자료만 사용합니다. 실제 파일, 계정 정보 또는 Google 승인을 받지 않습니다.",
    importHelp:
      "실제 스프레드시트를 사용하려면 서버와 PostgreSQL을 포함해 Sheet Workbench를 직접 설치하세요. 설치 안내에서 로컬과 Docker 실행 방법을 확인할 수 있습니다.",
    accountNotice:
      "이 공개 데모에서는 계정 입력이 비활성화되어 있습니다. 가상 자료만 이 브라우저에 저장됩니다.",
    accountHelp:
      "계정 생성, 작업 공간 공유 또는 실제 원본 연결은 애플리케이션을 직접 설치한 뒤 사용할 수 있습니다.",
  },
};

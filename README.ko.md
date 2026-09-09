# Sheet Workbench

**스프레드시트는 그대로, 반복 업무는 줄이세요.**

Sheet Workbench는 표·달력·상태 보드·보고서를 같은 확정 자료에서 보여 주기 위한 오픈소스 알파 프로젝트입니다. `.xlsx` 작업본을 가져오고, 비공개 Google 시트는 명시적인 권한과 안전한 원본 확인을 거쳐 연결하도록 설계합니다.

> **알파 / 로컬 검증 버전 — 0.1.0-alpha.2.** 독립 프로젝트이며 데모에는 가상 자료만 사용합니다. 브라우저 회원가입·작업 공간·XLSX 업로드/수정/다운로드·권한·작업 큐·버전 기록을 로컬 테스트했고, 실제 PostgreSQL 16.15에서도 별도 테스트 DB로 백업·복원을 확인했습니다. **공개 호스팅 서비스는 아직 출시하지 않았습니다.** 실제 Google OAuth/Picker/쓰기, Docker/HTTPS 배포, 메일 전달, 데스크톱 Excel 재열기, 3팀 파일럿은 미검증입니다. [검증 결과와 한계](docs/LOCAL_VALIDATION.md)를 확인하세요.

가상 자료를 사용한 실제 브라우저 증거(실제 Google 데모 아님): [표 화면 캡처](docs/media/table.png) · [20–30초 녹화](docs/media/browser-demo.webm).

## 포함된 것

- 계정이나 데이터베이스 없이 실행되는 브라우저 가상 데모
- 인증된 팀 작업 공간·소유자 구성원 관리·업로드·자료·리비전·되돌리기·안전한 내보내기·이름 확인 삭제를 위한 Fastify/PostgreSQL 서버 계약
- 보호된 원본 쓰기를 위한 재시도·복구 기록이 있는 영속 원본 작업 큐(원격 Google 동작은 모의 테스트만 수행)
- 저장된 버전의 JSON·XLSX 작업본 다운로드(각 버전의 원본 파일을 바탕으로 비연결 영역 보존)
- 선택한 비수식 셀만 안전하게 수정하고 지원 범위 밖 구조는 거부하는 XLSX 어댑터
- 영어·한국어 UI와 설치 안내
- PostgreSQL 볼륨을 포함한 알파 Docker Compose 셀프호스팅 뼈대

회사 시트, 운영 사이트 코드, 자격 증명, Google 시트 ID, 개인 자료는 복사하거나 의존하지 않습니다.

`samples/`에는 데모·통합 작업용 가상 `.xlsx`, CSV, 보고서, 입력 이미지가 있습니다. 회사 자료나 실제 원본 증거가 아닙니다. 가상 가져오기·내보내기와 네이티브 PostgreSQL 16.15 스모크는 로컬에서 확인했지만, 지원 대상 데스크톱 Excel 재열기와 실제 원본 동작은 출시 전 확인 항목입니다.

## 빠른 시작: 가상 데모

Node.js `22.12+`와 npm이 필요합니다.

```sh
npm ci
npm run dev
```

`http://127.0.0.1:5173`을 엽니다. 데모 자료는 가상이며 수정은 이 브라우저에만 저장됩니다. 이 경로에는 `.env`, Google 계정, 데이터베이스, 외부 서비스가 필요하지 않습니다.

```sh
npm run check       # TypeScript 빌드 + 단위/통합 테스트
npm run test:e2e    # 반응형 브라우저 테스트; 단독 실행이면 먼저 npm run build
```

`DATABASE_URL` 없이 `npm run dev:server`를 실행하면 의도적으로 브라우저 데모 전용입니다. 설정 조회만 제공하고 작업 공간·업로드·자료·인증 경로는 실패 종료합니다.

영문 안내는 [QUICKSTART.md](docs/QUICKSTART.md)에서 확인하세요.

## Docker 없이 로컬 팀 시험

`npm run demo:team`을 실행하고 `TEAM_TRIAL_READY`가 뜨면 <http://127.0.0.1:3002>를 엽니다. 회원가입·작업 공간·XLSX 저장을 직접 시험할 수 있으며 가상 자료는 `.local/team-trial`에 남습니다. **`samples/team.xlsx`**로 시작하세요. [팀 데모 사용 순서](docs/QUICKSTART.ko.md)에 자세히 적었습니다. 실제 Google 연결은 꺼져 있으며 `Ctrl+C`로 종료합니다. 이 명령은 로컬에서 실행 검증했지만 Docker·공개 호스팅·운영 환경을 대신하지 않습니다.

## 셀프호스팅 알파

이 저장소에는 알파 셀프호스팅 시험용 Compose 구성이 있습니다. 빌드된 앱과 PostgreSQL을 실행하고 이름 있는 데이터베이스 볼륨을 사용합니다. 웹 파일과 `/api`는 하나의 오리진에서 제공합니다.

```powershell
Copy-Item .env.example .env
# replace-me 값을 모두 새로 만든 비밀값으로 바꿉니다.
docker compose up --build
```

`http://localhost:3001`을 엽니다. 네이티브 PostgreSQL 16.15는 별도 가상 스모크로 확인했지만, 이 Compose 구성 자체는 이 환경에서 실행·검증되지 않았습니다. 외부에 공개하기 전에 [셀프호스팅 안내](docs/SELF_HOSTING.md)를 읽으세요.

개발용 Vite 서버를 그대로 공개하지 마세요. 운영 배포에는 같은 오리진의 HTTPS 리버스 프록시가 필요하며 PostgreSQL은 외부에 노출하지 않아야 합니다. `BETTER_AUTH_URL`의 오리진을 기본으로 신뢰하며, 필요한 경우 `TRUSTED_ORIGINS`에 정확한 오리진 목록을 지정합니다. Docker와 공개 HTTPS 환경 검증은 아직 출시 전 확인 사항입니다.

## 자료와 안전 모델

- 브라우저 데모는 가상 자료와 브라우저 저장소만 사용합니다.
- 실제 업로드는 인증 세션·작업 공간 권한·명시적 저장 동의가 필요하며, 서버 설정 시 PostgreSQL에 저장됩니다.
- 조회자 권한은 수정할 수 없습니다. 자료 수정은 revision과 idempotent operation ID를 사용하고, Google 쓰기는 원본 행 식별자와 셀 이전 값을 확인합니다.
- 수식·원본 ID 필드는 UI에서 읽기 전용입니다. 지원하지 않는 구조나 모호한 매칭은 추측하지 않고 거부합니다.
- 인증 없는 공개 쓰기 경로는 없습니다. 소유자는 구성원을 관리하고 역할을 바꾸거나 제거할 수 있으며, 정확한 자료 이름을 입력해 로컬 자료 하나를 삭제하고 작업 공간을 백업/복원/삭제할 수 있습니다. 자료 삭제는 연결된 Google 시트를 변경하지 않으며, 현재 자료나 저장 리비전에서 참조하지 않는 로컬 XLSX 원본만 제거합니다.
- 계정 삭제에는 정확한 계정 이름·이메일과 Better Auth의 현재 비밀번호 또는 최근 로그인 세션 확인이 필요합니다. 단독 소유자는 먼저 소유권을 이전해야 합니다. 공동 작업 공간의 자료는 남지만, 삭제 계정의 구성원 자격·대기 원본 작업·자격 증명 연결·작성자 표시는 제거하거나 익명화합니다. 그 계정에 연결된 Google 자료는 연결 해제·읽기 전용 상태가 됩니다. 이는 로컬 서버 테스트로 확인한 보존 정책이며, 배포 환경의 백업·로그·메일 보존은 운영자가 관리해야 합니다.
- 이식용 작업 공간 백업에는 구성원·인증 행·Google 자격 증명/토큰과 모든 과거 리비전 스냅샷이 들어가지 않습니다. 복원한 Google 자료는 연결 해제·읽기 전용 상태입니다. 전체 PostgreSQL 백업에는 전체 데이터베이스 이력이 남으므로 재해 복구에는 운영자 절차를 따르세요.

## 설정

`PASSWORD_RESET_WEBHOOK_URL`을 설정하면 비밀번호 재설정 링크 배달을 담당하는 운영자 제어 엔드포인트가 됩니다. 재설정 요청 때 서버는 해당 엔드포인트에 `{ type: "sheet-workbench.reset-password", user, resetUrl }` JSON을 POST합니다. 엔드포인트는 링크를 전달하고 성공 HTTP 응답을 반환해야 합니다. 이 앱은 직접 메일을 보내지 않으며, 이 값이 없으면 재설정 UI와 API는 비활성 상태를 설명합니다. 초대 이메일 검증 배달에는 별도로 `EMAIL_VERIFICATION_WEBHOOK_URL`이 필요합니다. 전체 환경 변수와 운영 주의 사항은 [SELF_HOSTING.md](docs/SELF_HOSTING.md)를 보세요.

## 문서

- [영문 빠른 시작](docs/QUICKSTART.md) / [한국어 빠른 시작](docs/QUICKSTART.ko.md)
- [셀프호스팅·리버스 프록시](docs/SELF_HOSTING.md)
- [지원 파일 매트릭스](docs/SUPPORTED_FILES.md)
- [백업·복원·삭제](docs/BACKUP_RESTORE_DELETION.md)
- [로컬 검증 결과와 남은 구현](docs/LOCAL_VALIDATION.md)
- [출시 체크리스트](docs/LAUNCH_CHECKLIST.md)
- [3팀 파일럿 절차](docs/PILOT_PROTOCOL.md)
- [20–30초 데모 대본](docs/DEMO_SCRIPT.md)
- [통합 메모와 미해결 게이트](docs/INTEGRATION_NOTES.md)

## 라이선스

새로 작성된 프로젝트 소스는 MIT 라이선스입니다. npm 의존성은 각자의 라이선스를 유지하므로 재배포 전에 고지를 확인하세요. [LICENSE](LICENSE)를 참고하세요.

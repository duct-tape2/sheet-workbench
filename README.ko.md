# Sheet Workbench

**스프레드시트는 그대로, 반복 업무는 줄이세요.**

Sheet Workbench는 표·달력·상태 보드·보고서를 같은 확정 자료에서 보여 주기 위한 오픈소스 알파 프로젝트입니다. `.xlsx` 작업본을 가져오고, 비공개 Google 시트는 명시적인 권한과 안전한 원본 확인을 거쳐 연결하도록 설계합니다.

> **알파 / 출시 게이트 상태.** 이 저장소는 독립 프로젝트이며 데모에는 가상 자료만 들어 있습니다. PGliteSocket/`pg` 경계의 Better Auth, 실제 브라우저 회원가입·작업 공간·XLSX 업로드·수정·다운로드, 가상 샘플 API 왕복은 로컬 증거가 있습니다. 이는 네이티브 PostgreSQL/Docker 배포를 증명하지 않습니다. 공개 호스팅 서비스는 아직 출시되지 않았고, 실제 Google OAuth·Picker·가져오기·새로고침·쓰기 반영, 실제 원본 동시성, 메일 전달, 네이티브 Excel 왕복, 3팀 파일럿은 아직 검증되지 않았습니다.

가상 자료를 사용한 실제 브라우저 증거(실제 Google 데모 아님): [표 화면 캡처](docs/media/table.png) · [20–30초 녹화](docs/media/browser-demo.webm).

## 포함된 것

- 계정이나 데이터베이스 없이 실행되는 브라우저 가상 데모
- 인증된 팀 작업 공간·권한·업로드·자료·이력·되돌리기·내보내기를 위한 Fastify/PostgreSQL 서버 계약
- 선택한 비수식 셀만 안전하게 수정하고 지원 범위 밖 구조는 거부하는 XLSX 어댑터
- 영어·한국어 UI와 설치 안내
- PostgreSQL 볼륨을 포함한 알파 Docker Compose 셀프호스팅 뼈대

회사 시트, 운영 사이트 코드, 자격 증명, Google 시트 ID, 개인 자료는 복사하거나 의존하지 않습니다.

`samples/`에는 데모·통합 작업용 가상 `.xlsx`, CSV, 보고서, 입력 이미지가 있습니다. 회사 자료나 실제 원본 증거가 아닙니다. 가상 샘플 API 왕복은 저장소 테스트로 확인하지만, 네이티브 Excel과 실제 원본의 가져오기·내보내기는 출시 전 확인 항목입니다.

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

## 셀프호스팅 알파

이 저장소에는 알파 셀프호스팅 시험용 Compose 구성이 있습니다. 빌드된 앱과 PostgreSQL을 실행하고 이름 있는 데이터베이스 볼륨을 사용합니다. 웹 파일과 `/api`는 하나의 오리진에서 제공합니다.

```powershell
Copy-Item .env.example .env
# replace-me 값을 모두 새로 만든 비밀값으로 바꿉니다.
docker compose up --build
```

`http://localhost:3001`을 엽니다. 이 환경에서 Docker나 네이티브 PostgreSQL이 검증됐다는 뜻은 아닙니다. 외부에 공개하기 전에 [셀프호스팅 안내](docs/SELF_HOSTING.md)를 읽으세요.

개발용 Vite 서버를 그대로 공개하지 마세요. 운영 배포에는 같은 오리진의 HTTPS 리버스 프록시가 필요하며 PostgreSQL은 외부에 노출하지 않아야 합니다. `BETTER_AUTH_URL`의 오리진을 기본으로 신뢰하며, 필요한 경우 `TRUSTED_ORIGINS`에 정확한 오리진 목록을 지정합니다. 네이티브 Docker·PostgreSQL과 공개 HTTPS 환경 검증은 아직 출시 전 확인 사항입니다.

## 자료와 안전 모델

- 브라우저 데모는 가상 자료와 브라우저 저장소만 사용합니다.
- 실제 업로드는 인증 세션·작업 공간 권한·명시적 저장 동의가 필요하며, 서버 설정 시 PostgreSQL에 저장됩니다.
- 조회자 권한은 수정할 수 없습니다. 자료 수정은 revision과 idempotent operation ID를 사용하고, Google 쓰기는 원본 행 식별자와 셀 이전 값을 확인합니다.
- 수식·원본 ID 필드는 UI에서 읽기 전용입니다. 지원하지 않는 구조나 모호한 매칭은 추측하지 않고 거부합니다.
- 인증 없는 공개 쓰기 경로는 없습니다. 소유자는 앱에서 작업 공간 백업/내보내기, 새 작업 공간으로 복원, 이름 확인을 거친 작업 공간 삭제를 할 수 있습니다. 백업에는 구성원·인증 행·Google 자격 증명/토큰이 들어가지 않으며, 복원한 Google 자료는 연결 해제·읽기 전용 상태입니다. 전체 데이터베이스 재해 복구에는 여전히 운영자 PostgreSQL 절차가 필요합니다.

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

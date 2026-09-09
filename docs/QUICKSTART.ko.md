# 빠른 시작

## 로컬 가상 데모

Node.js `22.12+`와 npm이 필요합니다.

```sh
npm ci
npm run dev
```

`http://127.0.0.1:5173`을 엽니다. 샘플 업무를 고르고 가상 행을 수정한 뒤 표·달력·상태 보드·보고서를 전환해 보세요. 데모 수정 내용은 브라우저 저장소에만 남으며 데이터베이스나 Google 계정이 필요하지 않습니다.

```sh
npm run check       # TypeScript 빌드 + 단위/통합 테스트
npm run test:e2e    # 반응형 브라우저 테스트
```

실제 팀 흐름 테스트는 `dist/web`를 직접 제공하므로 브라우저 테스트 전에 빌드가 있어야 합니다. Playwright 설정에 있는 두 엔진이 필요하면 다음을 먼저 실행합니다.

```sh
npx playwright install chromium webkit
```

## 로그인·엑셀 업로드까지 해보는 팀 데모

```sh
npm run demo:team
```

`TEAM_TRIAL_READY`가 표시되면 `http://127.0.0.1:3002`를 엽니다. 먼저 앱을 빌드하므로 첫 화면이 뜨기까지 잠시 걸립니다. 언어는 메뉴의 **EN / 한국어**로 바꿀 수 있습니다.

1. **팀 작업 공간**에서 가상 계정을 만듭니다. `@example.test` 주소와 테스트 전용 비밀번호를 쓰세요.
2. 작업 공간을 만든 뒤 **자료 연결**을 선택합니다. 저장 위치 안내에 동의하고, 이 저장소의 **`samples/team.xlsx`**를 업로드합니다. 미리보기에서 열 연결을 확인합니다.
3. 표에서 업무 제목을 바꾼 뒤 **보고서**에서 해당 날짜가 포함된 기간을 선택합니다. 같은 확정 내용이 표시되는지 확인하세요.
4. **내보내기**에서 수정된 XLSX를 받습니다. **버전 기록**에서는 저장된 버전의 JSON·XLSX를 받을 수 있습니다. 원래 PC 파일은 덮어쓰지 않습니다.
5. 브라우저 다운로드 목록(보통 `Ctrl+J`)이나 선택한 다운로드 폴더를 확인하세요. 보고서는 `.md`, 엑셀 사본은 `.xlsx`입니다. 브라우저가 저장 위치를 묻거나 같은 이름 뒤에 `(1)`을 붙일 수 있습니다. 화면의 다운로드 시작 안내는 실제 파일 저장 완료를 뜻하지 않습니다.

이 데모는 이 PC에서만 접속되며 가상 자료를 `.local/team-trial`에 보관해 재실행해도 유지합니다. 종료는 `Ctrl+C`입니다. 내부 PostgreSQL 호환 저장소를 쓰는 로컬 체험용이며 운영 PostgreSQL·Docker를 대신하지 않습니다. 실제 Google 연결과 메일 발송은 꺼져 있습니다. 외부 공개나 실제 회사 파일 업로드는 하지 마세요.

## 데이터베이스 없이 서버 실행

`npm run dev:server`는 브라우저 데모를 위한 `/api/config`를 제공할 수 있습니다. `DATABASE_URL`이 없으면 실제 작업 공간·인증·업로드·자료 경로는 설정 오류로 종료됩니다. 이는 PostgreSQL의 대체가 아닙니다.

## 알파 Compose 시험

```powershell
Copy-Item .env.example .env
# POSTGRES_PASSWORD와 BETTER_AUTH_SECRET를 무작위 값으로 바꿉니다.
docker compose up --build
```

`http://localhost:3001`을 엽니다. 앱 컨테이너와 `postgres_data` 이름 있는 볼륨을 사용합니다. `docker compose down`은 볼륨을 보존합니다. 백업을 확인하기 전 `docker compose down -v`를 실행하지 마세요.

이 Compose 구성은 뼈대입니다. 현재 작업 환경에는 Docker CLI가 없어 Docker는 검증되지 않았습니다. 별도의 네이티브 PostgreSQL 16.15 가상 스모크로 인증, XLSX 가져오기·수정·내보내기, 덤프/복원은 확인했지만 이 Compose 이미지나 호스팅 배포를 검증한 것은 아닙니다. 운영 전 [SELF_HOSTING.md](SELF_HOSTING.md), [BACKUP_RESTORE_DELETION.md](BACKUP_RESTORE_DELETION.md), [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md)를 읽으세요.

## 실제 원본 연결

실제 `.xlsx` 업로드에는 로그인·작업 공간 권한·명시적 저장 동의가 필요합니다. Google 시트에는 OAuth 자격 증명, 사용자별 암호화 토큰 저장, Picker 설정, 허용된 시트에 대한 실제 테스트가 필요합니다. 설정을 우회하려고 시트를 공개하지 마세요. Google 통합은 아직 출시 게이트입니다.

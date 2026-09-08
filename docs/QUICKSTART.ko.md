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

## 데이터베이스 없이 서버 실행

`npm run dev:server`는 브라우저 데모를 위한 `/api/config`를 제공할 수 있습니다. `DATABASE_URL`이 없으면 실제 작업 공간·인증·업로드·자료 경로는 설정 오류로 종료됩니다. 이는 PostgreSQL의 대체가 아닙니다.

## 알파 Compose 시험

```powershell
Copy-Item .env.example .env
# POSTGRES_PASSWORD와 BETTER_AUTH_SECRET를 무작위 값으로 바꿉니다.
docker compose up --build
```

`http://localhost:3001`을 엽니다. 앱 컨테이너와 `postgres_data` 이름 있는 볼륨을 사용합니다. `docker compose down`은 볼륨을 보존합니다. 백업을 확인하기 전 `docker compose down -v`를 실행하지 마세요.

이 구성은 뼈대입니다. 현재 작업 환경에는 Docker CLI가 없어 Docker·네이티브 PostgreSQL을 실행하지 못했으며, 검증됐다는 뜻이 아닙니다. 운영 전 [SELF_HOSTING.md](SELF_HOSTING.md), [BACKUP_RESTORE_DELETION.md](BACKUP_RESTORE_DELETION.md), [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md)를 읽으세요.

## 실제 원본 연결

실제 `.xlsx` 업로드에는 로그인·작업 공간 권한·명시적 저장 동의가 필요합니다. Google 시트에는 OAuth 자격 증명, 사용자별 암호화 토큰 저장, Picker 설정, 허용된 시트에 대한 실제 테스트가 필요합니다. 설정을 우회하려고 시트를 공개하지 마세요. Google 통합은 아직 출시 게이트입니다.

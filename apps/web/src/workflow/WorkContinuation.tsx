import { useEffect, useState } from "react";
import type {
  CompanionFile,
  CompanionHealth,
  CompanionRun,
  WorkbookProfile as NativeProfile,
} from "../../../../packages/companion/src/contracts";
import {
  createChangePlan,
  PeriodSchema,
  reviewProposal,
  recipeForNextRun,
  WorkRecipeV2Schema,
  type ChangeProposal,
  type EvidenceDocument,
  type WorkbookProfile,
} from "../../../../packages/workflow/src/index";
import {
  companion,
  companionAvailable,
  normalizeProfile,
  saveJson,
  downloadRun,
  CompanionError,
} from "./client";
import "./workflow.css";
export default function WorkContinuation({
  locale,
  onBack,
}: {
  locale: "en" | "ko";
  onBack: () => void;
}) {
  const t = (en: string, ko: string) => (locale === "ko" ? ko : en);
  const [health, setHealth] = useState<CompanionHealth | null>(null),
    [file, setFile] = useState<CompanionFile | null>(null),
    [profile, setProfile] = useState<WorkbookProfile | null>(null);
  const [structureNotes, setStructureNotes] = useState<string[]>([]);
  const [documents, setDocuments] = useState<EvidenceDocument[]>([]),
    [pasted, setPasted] = useState(""),
    [period, setPeriod] = useState(""),
    [request, setRequest] = useState(""),
    [rules, setRules] = useState("");
  const [proposal, setProposal] = useState<ChangeProposal | null>(null),
    [requestId, setRequestId] = useState(""),
    [approved, setApproved] = useState(false),
    [run, setRun] = useState<CompanionRun | null>(null);
  const [checks, setChecks] = useState<
    Array<{
      sheet: string;
      address: string;
      expected: string;
      kind: "number" | "text";
    }>
  >([]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const connected = companionAvailable();
  const [aiMode, setAiMode] = useState<"local" | "cloud">("local");
  const [cloudConsent, setCloudConsent] = useState(false);
  const reset = () => {
    setProposal(null);
    setApproved(false);
    setRun(null);
    setCloudConsent(false);
  };
  async function task(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (e) {
      const koErrors: Record<string, string> = {
        LOCAL_AI_UNAVAILABLE:
          "Ollama에 사용 가능한 로컬 모델이 없습니다. 모델을 설치한 뒤 다시 시도하세요. 클라우드로 자동 전환하지 않습니다.",
        DOCLING_UNAVAILABLE:
          "PDF·이미지 추출에 필요한 Docling 또는 모델이 준비되지 않았습니다. 설치 안내를 확인하거나 TXT·CSV 자료를 사용하세요.",
        EXCEL_UNAVAILABLE:
          "PC Excel 또는 xlwings를 사용할 수 없습니다. 설치 안내를 확인하세요.",
        NATIVE_VERIFICATION_FAILED:
          "Excel 계산 후 원본 구조 보존 검증을 통과하지 못했습니다. 결과를 배포하지 않고 중단했습니다.",
        COMPANION_AUTH_REQUIRED:
          "PC 연결 세션을 확인할 수 없습니다. 연결 프로그램을 다시 시작하고 새 로컬 링크를 열어 주세요.",
        AI_CONTEXT_TRUNCATED:
          "분석 가능한 범위를 넘었습니다. 관련 자료 범위를 줄여 주세요. 일부만 보고 자동 적용하지 않습니다.",
      };
      setError(
        e instanceof CompanionError && locale === "ko" && koErrors[e.code]
          ? koErrors[e.code]
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (file || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [file, busy]);
  useEffect(() => {
    if (connected)
      void task(t("Checking PC…", "PC 연결 확인 중…"), async () =>
        setHealth(await companion<CompanionHealth>("health")),
      );
  }, []);
  async function upload(input: File) {
    const body = new FormData();
    body.append("file", input);
    return (
      await companion<{ file: CompanionFile }>("files", {
        method: "POST",
        body,
      })
    ).file;
  }
  async function chooseWorkbook(input: File) {
    reset();
    setChecks([]);
    setFile(null);
    setProfile(null);
    setStructureNotes([]);
    const selected = await upload(input);
    const data = await companion<{ profile: NativeProfile }>(
      `files/${selected.id}/profile`,
    );
    setFile(selected);
    setProfile(normalizeProfile(data.profile));
    setStructureNotes([
      t("Defined names: ", "정의된 이름: ") +
        (data.profile.definedNames?.join(", ") || t("none", "없음")),
      ...data.profile.sheets.map(
        (s) =>
          `${s.name}: ${t("hidden rows / columns / merged ranges / tables", "숨은 행 / 열 / 병합 범위 / 표")} ${s.structure?.hiddenRows.length ?? 0} / ${s.structure?.hiddenColumns.length ?? 0} / ${s.structure?.mergedRanges.length ?? 0} / ${s.structure?.tables.length ?? 0}${s.truncated || s.structure?.truncated ? t(" — partial profile, narrow the scope", " — 일부 범위만 분석됨, 범위를 줄여 주세요") : ""}`,
      ),
    ]);
  }
  async function addEvidence(input: File) {
    const added = await upload(input);
    const data = await companion<{ extract: { content: string } }>(
      `files/${added.id}/extract`,
      { method: "POST" },
    );
    setDocuments((prev) => [
      ...prev,
      { fileId: added.id, name: added.name, content: data.extract.content },
    ]);
    reset();
  }
  const review =
    proposal && profile ? reviewProposal(proposal, profile, documents) : null;
  async function propose() {
    if (!file || !profile) return;
    PeriodSchema.parse(period);
    reset();
    const data = await companion<unknown>("ai/propose", {
      method: "POST",
      body: JSON.stringify({
        fileId: file.id,
        evidenceFileIds: documents.map((d) => d.fileId),
        period,
        rules: rules
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean),
        request,
        mode: aiMode,
        ...(aiMode === "cloud"
          ? { cloudConsent, costAcknowledged: cloudConsent }
          : {}),
      }),
    });
    setProposal(reviewProposal(data, profile, documents).proposal);
    setRequestId(crypto.randomUUID());
  }
  async function apply() {
    if (!file || !profile || !proposal) return;
    if (checks.some((c) => !c.expected.trim()))
      throw new Error(
        t("Enter every expected result.", "예상 결과를 모두 입력하세요."),
      );
    const patch = createChangePlan({
      sourceId: file.id,
      sourceHash: file.sha256,
      requestId,
      period,
      proposal,
      profile,
      documents,
      approved,
      checks: checks.map((c) => ({
        sheet: c.sheet,
        address: c.address,
        expected: c.kind === "number" ? Number(c.expected) : c.expected,
      })),
    });
    const data = await companion<CompanionRun>("runs", {
      method: "POST",
      body: JSON.stringify({ fileId: file.id, patch }),
    });
    setRun(data);
  }
  return (
    <main className="work-continuation">
      <header>
        <button onClick={onBack}>
          {t("← File workbench", "← 기존 파일 작업대")}
        </button>
        <span>
          Sheet Workbench · {t("Experimental PC mode", "PC 실험 기능")}
        </span>
      </header>
      <h1>
        {t(
          "Continue the work. Keep the workbook.",
          "기존 엑셀로, 다음 작업을 준비하세요.",
        )}
      </h1>
      <p>
        {t(
          "Confirm evidence and rules, then review a copy. No payments, filings or external sending.",
          "이번 자료와 업무 규칙을 확인하고 복사본을 만듭니다. 지급·송금·신고·외부 발송은 하지 않습니다.",
        )}
      </p>
      {!connected ? (
        <section>
          <h2>
            {t("Start on your Windows PC", "Windows PC에서 시작해 주세요")}
          </h2>
          <p>
            {t(
              "The public website cannot access your PC files or Excel. Start the optional companion and open its authenticated local window. The ordinary browser workbench remains available without installation.",
              "공개 웹사이트는 PC 파일이나 Excel에 접근하지 않습니다. 선택형 PC 연결 프로그램을 실행한 뒤 안내되는 인증된 로컬 창을 열어 주세요. 기존 브라우저 작업대는 설치 없이 그대로 사용할 수 있습니다.",
            )}
          </p>
          <p>
            {t(
              "Desktop Excel and a local Ollama model are required. There is no automatic cloud fallback.",
              "PC에 설치된 Excel과 로컬 Ollama 모델이 필요합니다. 클라우드로 자동 전환하지 않습니다.",
            )}
          </p>
          <a
            href="https://github.com/duct-tape2/sheet-workbench/blob/main/docs/COMPANION.md"
            target="_blank"
            rel="noreferrer"
          >
            {t("PC setup and supported files", "PC 설치·지원 범위 안내")}
          </a>
        </section>
      ) : (
        <>
          <section>
            <h2>{t("1. Files and evidence", "1. 기존 파일과 이번 자료")}</h2>
            {health && (
              <p>
                Excel:{" "}
                {health.capabilities.excel
                  ? t("ready", "준비됨")
                  : t("unavailable", "확인 필요")}{" "}
                · xlwings:{" "}
                {health.capabilities.xlwings
                  ? t("ready", "준비됨")
                  : t("unavailable", "확인 필요")}{" "}
                · Ollama:{" "}
                {health.capabilities.ollama
                  ? t("model available", "모델 있음")
                  : t("no model", "모델 없음")}
              </p>
            )}
            <label>
              {t("Existing workbook (.xlsx)", "기존 업무 파일 (.xlsx)")}
              <input
                disabled={!!busy}
                type="file"
                accept=".xlsx"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void task(t("Inspecting…", "파일 분석 중…"), () =>
                      chooseWorkbook(f),
                    );
                  e.target.value = "";
                }}
              />
            </label>
            {profile && (
              <details open>
                <summary>
                  {file?.name} ·{" "}
                  {t(
                    "All sheets, including hidden sheets",
                    "숨은 시트를 포함한 전체 시트",
                  )}
                </summary>
                <ul>
                  {profile.sheets.map((s) => (
                    <li key={s.name}>
                      {s.name} {s.hidden ? t("(hidden)", "(숨김)") : ""} —{" "}
                      {s.cells.filter((c) => c.formula).length}{" "}
                      {t("profiled formulas", "개 분석 범위 내 수식")}
                    </li>
                  ))}
                </ul>
                <p>
                  {t(
                    "Formulas are protected. Structural edits, macros and external refresh are not executed.",
                    "수식은 보호합니다. 구조 변경·매크로·외부 데이터 새로고침은 실행하지 않습니다.",
                  )}
                </p>
                <ul>
                  {structureNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
                {profile.readOnlyReasons.map((r, i) => (
                  <p role="alert" key={i}>
                    {r}
                  </p>
                ))}
              </details>
            )}
            <label>
              {t(
                "Evidence: TXT, CSV, PDF or image",
                "이번 근거 자료: TXT·CSV·PDF·이미지",
              )}
              <input
                disabled={!!busy}
                type="file"
                accept=".txt,.csv,.pdf,.png,.jpg,.jpeg"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void task(
                      t("Extracting locally…", "로컬 근거 추출 중…"),
                      () => addEvidence(f),
                    );
                  e.target.value = "";
                }}
              />
            </label>
            <label>
              {t(
                "Or paste a conversation (no account connection)",
                "또는 대화 붙여넣기 (계정 연결·자동 수집 없음)",
              )}
              <textarea
                value={pasted}
                disabled={!!busy}
                onChange={(e) => setPasted(e.target.value)}
                rows={4}
              />
            </label>
            <button
              disabled={!!busy || !pasted.trim()}
              onClick={() =>
                void task(t("Adding evidence…", "근거 추가 중…"), async () => {
                  await addEvidence(
                    new File([pasted], "conversation.txt", {
                      type: "text/plain",
                    }),
                  );
                  setPasted("");
                })
              }
            >
              {t("Add pasted evidence", "붙여넣은 내용 추가")}
            </button>
            {documents.map((d) => (
              <details key={d.fileId}>
                <summary>{d.name}</summary>
                <pre>{d.content}</pre>
                <button
                  disabled={!!busy}
                  onClick={() => {
                    setDocuments(
                      documents.filter((x) => x.fileId !== d.fileId),
                    );
                    reset();
                  }}
                >
                  {t("Exclude from this run", "이번 작업에서 제외")}
                </button>
              </details>
            ))}
          </section>
          <section>
            <h2>{t("2. Confirm this run", "2. 이번 작업 기준 확인")}</h2>
            <label>
              {t("Target period (YYYY-MM)", "대상 기간 (YYYY-MM)")}
              <input
                placeholder="2026-10"
                value={period}
                disabled={!!busy}
                onChange={(e) => {
                  setPeriod(e.target.value);
                  reset();
                }}
              />
            </label>
            <label>
              {t("What needs to change?", "무엇을 바꿔야 하나요?")}
              <textarea
                value={request}
                disabled={!!busy}
                onChange={(e) => {
                  setRequest(e.target.value);
                  reset();
                }}
                rows={3}
              />
            </label>
            <label>
              {t(
                "Confirmed rules — one per line",
                "확인한 업무 규칙 — 한 줄에 하나씩",
              )}
              <textarea
                value={rules}
                disabled={!!busy}
                onChange={(e) => {
                  setRules(e.target.value);
                  reset();
                }}
                rows={4}
              />
            </label>
            <p>
              {t(
                "Use approved rates and rounding rules. Missing facts remain questions. Local AI is the default; cloud requires separate consent.",
                "승인된 요율·반올림 규칙을 입력하세요. 모르는 정보는 추측하지 않고 질문으로 남깁니다. 로컬 AI가 기본이며 클라우드는 별도 선택과 동의가 필요합니다.",
              )}
            </p>
            <button
              disabled={!!busy || !profile || !rules.trim()}
              onClick={() =>
                void task(t("Saving rules…", "규칙 저장 중…"), async () =>
                  saveJson(
                    "work-rules-v2.json",
                    WorkRecipeV2Schema.parse({
                      version: 2,
                      kind: "work-continuation",
                      name: "Work rules",
                      rules: rules.split("\n").filter((r) => r.trim()),
                      requiredSheets: profile!.sheets.map((s) => s.name),
                      periodPolicy: "explicit-every-run",
                    }),
                  ),
                )
              }
            >
              {t("Save rules for next time", "다음 작업용 규칙 저장")}
            </button>
            <label>
              {t("Load V2 rules", "V2 규칙 불러오기")}
              <input
                disabled={!!busy || !profile}
                type="file"
                accept=".json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && profile)
                    void task(
                      t("Loading rules…", "규칙 불러오는 중…"),
                      async () => {
                        setRules(
                          recipeForNextRun(
                            JSON.parse(await f.text()),
                            profile,
                          ).rules.join("\n"),
                        );
                        reset();
                      },
                    );
                  e.target.value = "";
                }}
              />
            </label>
            <label>
              {t("AI processing location", "AI 처리 위치")}
              <select
                disabled={!!busy}
                value={aiMode}
                onChange={(e) => {
                  setAiMode(e.target.value as "local" | "cloud");
                  setCloudConsent(false);
                  reset();
                }}
              >
                <option value="local">
                  {t("On this PC — Ollama", "이 PC — Ollama")}
                </option>
                <option value="cloud" disabled={!health?.cloud?.configured}>
                  {t("Optional cloud provider", "선택형 클라우드 제공자")}
                  {!health?.cloud?.configured
                    ? t(" (not configured)", " (설정되지 않음)")
                    : ""}
                </option>
              </select>
            </label>
            {aiMode === "cloud" && (
              <div role="note">
                <p>
                  {t("Data leaving this PC:", "이 PC 밖으로 전송할 자료:")}{" "}
                  {file?.name}; {documents.map((d) => d.name).join(", ")}.{" "}
                  {t(
                    "Includes workbook values, formulas, hidden-area profile, evidence text, request, period and rules.",
                    "통합문서 값·수식·숨은 영역 구조, 근거 원문, 요청, 기간과 규칙이 포함됩니다.",
                  )}
                </p>
                <p>
                  {t("Provider", "제공자")}: {health?.cloud?.provider} ·{" "}
                  {health?.cloud?.model ?? t("configured model", "설정된 모델")}
                  .{" "}
                  {t(
                    "Provider fees may apply; the app cannot estimate your bill.",
                    "제공자 요금이 발생할 수 있으며 앱에서 청구액을 예측할 수 없습니다.",
                  )}
                </p>
                <label className="work-check">
                  <input
                    type="checkbox"
                    disabled={!!busy}
                    checked={cloudConsent}
                    onChange={(e) => setCloudConsent(e.target.checked)}
                  />
                  {t(
                    "I approve this transmission and accept provider charges.",
                    "이번 자료 전송과 제공자 비용 발생을 확인하고 동의합니다.",
                  )}
                </label>
              </div>
            )}
            <button
              disabled={
                !!busy ||
                (aiMode === "cloud" && !cloudConsent) ||
                !!profile?.readOnlyReasons.length ||
                !file ||
                !documents.length ||
                !rules.trim() ||
                !request.trim() ||
                !PeriodSchema.safeParse(period).success
              }
              onClick={() =>
                void task(t("Preparing changes…", "변경안 준비 중…"), propose)
              }
            >
              {aiMode === "local"
                ? t("Prepare changes — local AI", "로컬 AI로 변경안 만들기")
                : t(
                    "Send selected data and prepare changes",
                    "선택한 자료를 전송하고 변경안 만들기",
                  )}
            </button>
          </section>
          {review && (
            <section>
              <h2>
                {t("3. Review before making a copy", "3. 복사본 생성 전 검토")}
              </h2>
              <p>{review.proposal.summary}</p>
              {review.issues.length > 0 && (
                <div role="alert">
                  <strong>
                    {t(
                      "Resolve these items and prepare again",
                      "아래 내용을 확인하고 변경안을 다시 만들어 주세요",
                    )}
                  </strong>
                  <ul>
                    {review.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.proposal.changes.map((change, i) => (
                <article key={i}>
                  <h3>
                    {change.sheet}!{change.address}
                  </h3>
                  <p>
                    <del>{JSON.stringify(change.before)}</del> →{" "}
                    <strong>{JSON.stringify(change.after)}</strong>
                  </p>
                  {change.evidence.map((ref, j) => (
                    <blockquote key={j}>
                      {ref.quote}
                      <small>
                        {documents.find((d) => d.fileId === ref.fileId)?.name}{" "}
                        {ref.line ? `L${ref.line}` : ""}
                      </small>
                    </blockquote>
                  ))}
                </article>
              ))}
              <h3>{t("Optional result checks", "선택: 결과 검증")}</h3>
              <p>
                {t(
                  "Add an independently confirmed expected total or value. Do not copy an unverified AI answer here.",
                  "별도로 확인한 예상 합계나 값을 입력하세요. 검증하지 않은 AI 답변을 그대로 넣지 마세요.",
                )}
              </p>
              {checks.map((check, i) => (
                <fieldset key={i}>
                  <legend>
                    {t("Check", "검증")} {i + 1}
                  </legend>
                  {(["sheet", "address", "expected"] as const).map((key) => (
                    <label key={key}>
                      {key === "sheet"
                        ? t("Sheet name", "시트 이름")
                        : key === "address"
                          ? t("Cell address, e.g. C10", "셀 주소 (예: C10)")
                          : t("Expected result", "예상 결과")}
                      <input
                        disabled={!!busy || !!run}
                        value={check[key]}
                        onChange={(e) => {
                          setChecks(
                            checks.map((c, j) =>
                              j === i ? { ...c, [key]: e.target.value } : c,
                            ),
                          );
                          setApproved(false);
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    {t("Value type", "값 종류")}
                    <select
                      value={check.kind}
                      disabled={!!busy || !!run}
                      onChange={(e) => {
                        setChecks(
                          checks.map((c, j) =>
                            j === i
                              ? {
                                  ...c,
                                  kind: e.target.value as "number" | "text",
                                }
                              : c,
                          ),
                        );
                        setApproved(false);
                      }}
                    >
                      <option value="number">{t("Number", "숫자")}</option>
                      <option value="text">{t("Text", "문자")}</option>
                    </select>
                  </label>
                  <button
                    disabled={!!busy || !!run}
                    onClick={() => {
                      setChecks(checks.filter((_, j) => j !== i));
                      setApproved(false);
                    }}
                  >
                    {t("Remove check", "검증 제외")}
                  </button>
                </fieldset>
              ))}
              <button
                disabled={!!busy || !!run}
                onClick={() => {
                  setChecks([
                    ...checks,
                    {
                      sheet: profile?.sheets[0]?.name ?? "",
                      address: "",
                      expected: "",
                      kind: "number",
                    },
                  ]);
                  setApproved(false);
                }}
              >
                {t("Add result check", "검증할 결과 추가")}
              </button>
              <p>
                {t(
                  "Without approved expected totals, output remains a draft, not ready for payment or filing.",
                  "승인된 예상 합계가 없으면 초안으로 남습니다. 초안을 지급·신고에 바로 사용하지 마세요.",
                )}
              </p>
              <label className="work-check">
                <input
                  type="checkbox"
                  disabled={!review.canApply || !!busy || !!run}
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                {t(
                  "I checked the evidence, period and every change.",
                  "근거·기간·모든 변경 내용을 확인했습니다.",
                )}
              </label>
              <button
                disabled={!approved || !review.canApply || !!busy || !!run}
                onClick={() =>
                  void task(
                    t(
                      "Calculating and verifying a copy…",
                      "복사본 계산·검증 중…",
                    ),
                    apply,
                  )
                }
              >
                {t("Create a working copy", "작업 복사본 만들기")}
              </button>
            </section>
          )}
          {run && (
            <section>
              <h2>
                {run.status === "verified"
                  ? t("Specified checks passed", "지정한 검증 통과")
                  : t("Draft — review required", "초안 — 검토 필요")}
              </h2>
              <p>
                {t(
                  "The original was not overwritten. Download the copy and review record.",
                  "원본은 덮어쓰지 않았습니다. 복사본과 검토 기록을 함께 받으세요.",
                )}
              </p>
              {run.download && (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void task(t("Downloading…", "다운로드 중…"), () =>
                      downloadRun(run.id),
                    )
                  }
                >
                  {t("Download working copy", "작업본 다운로드")}
                </button>
              )}
              <button
                onClick={() =>
                  saveJson("work-review.json", { run, period, proposal })
                }
              >
                {t(
                  "Download changes and review record",
                  "변경 내역·검토 기록 다운로드",
                )}
              </button>
            </section>
          )}
        </>
      )}
      <div aria-live="polite">
        {busy && <p role="status">{busy}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </main>
  );
}

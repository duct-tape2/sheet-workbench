import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  FileSpreadsheet,
  FolderOpen,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type { Locale } from "../../../../packages/core/src/types";
import LandingDemo from "./LandingDemo";
import "./landing.css";

type Sample = "clean" | "append" | "compare";
type Props = {
  locale: Locale;
  openFiles: () => void;
  sample: (kind: Sample) => Promise<void>;
  onLoad: () => void;
  busy?: boolean;
};

const words = {
  ko: {
    title: ["엑셀은 그대로.", "반복 작업은 덜어내세요."],
    lede: "매주 파일을 붙이고, 바뀐 셀을 찾고, 같은 표를 다시 정리하고 있다면. 파일을 열고, 바뀔 내용을 확인한 뒤, 결과만 가져가세요.",
    tag: "시트 워크벤치 · 무료 로컬 파일 도구",
    start: "샘플로 시작",
    open: "로컬 파일 열기",
    load: "기기 사본 불러오기",
    privacy: [
      "개인 모드는 가입 없이",
      "파일 처리는 이 브라우저에서",
      "원본 파일은 그대로",
    ],
    jump: "전후 비교 보기",
    examplesTitle: "늘 하던 그 작업, 이렇게 달라집니다.",
    examplesBody:
      "복잡한 새 시스템을 배울 필요 없이, 반복하던 한 가지부터 바꿔보세요.",
    exampleNote:
      "아래는 기능을 설명하기 위한 가상 자료입니다. 실제 결과는 파일과 선택한 설정에 따라 달라집니다.",
    before: "BEFORE · 지금까지",
    after: "AFTER · 워크벤치에서",
    proof: "달라지는 점",
    tryCase: "이 작업 체험",
    stepsTitle: "처음이라면, 이 순서로 해보세요.",
    steps: [
      [
        "파일을 열고 범위를 확인",
        "Excel 또는 CSV를 선택하세요. 시트·제목 행·열을 미리 보고 받아들입니다.",
      ],
      [
        "작업을 고르고 변경 내용 검토",
        "정리·이어붙이기·비교 중 필요한 작업을 선택하세요. ‘결과 확인’을 누르면 바뀔 내용을 보고 적용할 수 있습니다.",
      ],
      [
        "결과를 내려받고 다음 작업에 재사용",
        "결과는 새 파일로 내보냅니다. 반복할 정리 단계는 레시피로 저장해 다음 파일에 다시 적용할 수 있습니다.",
      ],
    ],
    samplesTitle: "회사 파일 없이, 먼저 눌러보세요.",
    samplesBody:
      "가상 샘플이 실제 작업 화면에서 열립니다. 정리 샘플은 공백 정리부터 시작합니다.",
    sampleLabels: ["정리 샘플", "이어붙이기 샘플", "비교 샘플"],
    optionalTitle: "표 다음에는 달력과 보고서도.",
    optionalBody:
      "일정이나 업무 목록이라면 제목·날짜·상태 열을 연결하세요. 같은 확정 자료를 달력, 상태 보드, 보고서로 볼 수 있습니다. 날짜가 없는 파일도 표로 작업할 수 있습니다.",
    optionalLinks: ["표", "달력", "상태 보드", "보고서"],
    faqTitle: "시작 전에 알아두면 좋은 것들",
    faq: [
      [
        "회사 파일이 외부 서버로 올라가나요?",
        "이 첫 화면에서 여는 개인 모드는 파일 내용을 브라우저에서 처리합니다. 서버나 AI로 파일을 전송하지 않습니다. 회사 보안 정책은 먼저 확인해 주세요. 별도 팀 모드는 저장 방식이 다릅니다.",
      ],
      [
        "원본 Excel 양식도 그대로 유지되나요?",
        "PC에 있는 원본은 덮어쓰지 않습니다. 일반 결과 XLSX는 값 중심의 새 파일입니다. 원본 서식 유지 내보내기는 지원되는 XLSX의 비구조적 수정에 한해 제공되며, 조건을 만족하지 않으면 차단합니다. 수식 셀은 읽기 전용입니다.",
      ],
      [
        "창을 닫으면 작업은 어떻게 되나요?",
        "기본은 메모리 작업입니다. 닫기 전에 결과를 내려받으세요. ‘이 기기에 보관’을 직접 켜면 브라우저에 사본을 저장할 수 있지만, 브라우저 데이터 삭제로 없어질 수 있으므로 별도 백업을 권합니다.",
      ],
      [
        "어떤 파일부터 써보면 좋나요?",
        "한 행에 항목 하나가 있는 .xlsx·.csv 표부터 시작하세요. 암호화 파일·매크로·복잡한 피벗 등은 지원 범위 밖입니다. 이 공개 버전은 알파이며, 중요한 자료는 사본으로 검토해 주세요.",
      ],
    ],
    close: "다음번에도 할 작업이라면,\n이번에는 덜 반복하세요.",
    github: "GitHub에서 보기",
    free: "무료 · 오픈소스 알파",
    note: "원본을 바꾸기 전에, 바뀔 내용부터 확인합니다.",
  },
  en: {
    title: ["Keep the spreadsheet.", "Lose the busywork."],
    lede: "Another file to combine. Another version to check. The same cleanup, again. Open your files, review what changes, and take the result with you.",
    tag: "Sheet Workbench · Free local file tools",
    start: "Try a sample",
    open: "Open local files",
    load: "Load device copy",
    privacy: [
      "No signup in personal mode",
      "Files processed in this browser",
      "Original files untouched",
    ],
    jump: "See before & after",
    examplesTitle: "Familiar work. Fewer repeat steps.",
    examplesBody:
      "Start with one recurring task, without moving your work into another system.",
    exampleNote:
      "Synthetic examples illustrate the workflow. Actual results depend on your files and selected settings.",
    before: "BEFORE · THE USUAL WAY",
    after: "AFTER · IN WORKBENCH",
    proof: "What changes",
    tryCase: "Try this workflow",
    stepsTitle: "Your first file, step by step.",
    steps: [
      [
        "Open a file. Check the range.",
        "Choose an Excel or CSV file. Review its sheet, header row and columns before accepting it.",
      ],
      [
        "Choose the work. Review the changes.",
        "Clean, append or compare. Inspect the proposed result, then explicitly apply the changes.",
      ],
      [
        "Download the result. Keep the steps.",
        "Export a new file. Save repeatable steps as a recipe to apply to your next file.",
      ],
    ],
    samplesTitle: "Try it before opening a work file.",
    samplesBody:
      "Synthetic samples open in the real workspace. The cleaning sample starts with trimming whitespace.",
    sampleLabels: ["Cleaning sample", "Append sample", "Compare sample"],
    optionalTitle: "A table can also be a calendar. Or a report.",
    optionalBody:
      "For schedules and task lists, map title, date and status columns. View the same confirmed records in a calendar, board or report. Files without dates still work in the table.",
    optionalLinks: ["Table", "Calendar", "Status board", "Report"],
    faqTitle: "A few things worth knowing",
    faq: [
      [
        "Are my work files uploaded?",
        "Personal mode processes file contents in this browser, without sending them to a server or AI. Check your workplace security policy first. The separate team mode has a different storage model.",
      ],
      [
        "Will my Excel formatting survive?",
        "Your original PC file is never overwritten. Standard XLSX results are new, values-oriented files. Original-preserving export is limited to supported, non-structural XLSX edits and is blocked otherwise. Formula cells remain read-only.",
      ],
      [
        "What happens when I close the tab?",
        "Work is in memory by default. Download your result before closing. Opt into “Keep on this device” to save a browser copy; clearing browser data can remove it, so keep a separate backup.",
      ],
      [
        "Which files should I start with?",
        "Start with tabular .xlsx or .csv files: one item per row. Encrypted files, macros and complex pivots are outside the supported scope. This is a public alpha; review important work using copies.",
      ],
    ],
    close: "Keep the work.\nSkip another round of busywork.",
    github: "View on GitHub",
    free: "Free · Open-source alpha",
    note: "See what changes before you apply it.",
  },
};

const examples = {
  ko: [
    {
      label: "파일 취합",
      title: "붙여넣기 전에, 열부터 맞춰보세요.",
      before: "받은 파일을 하나씩 열고, 열 순서를 확인하며 복사·붙여넣기.",
      after:
        "현재 파일과 추가 파일의 열을 연결하고, 추가될 행을 검토한 뒤 한 번에 반영.",
      gain: "열을 어디에 붙일지 화면에서 확인합니다.",
      headers: ["이름", "지역"],
      beforeRows: [["Mina", "Seoul"]],
      incoming: [["Jae", "Busan"]],
      afterRows: [
        ["Mina", "Seoul"],
        ["Jae", "Busan"],
      ],
      source: "현재 파일 + 추가 파일",
      result: "하나의 결과 표",
      sample: "append" as const,
    },
    {
      label: "변경 비교",
      title: "두 파일을 번갈아 보지 않아도.",
      before: "지난 파일과 새 파일을 오가며 어떤 셀이 달라졌는지 찾기.",
      after:
        "ID로 행을 연결해 바뀐 값과 한쪽에만 있는 행을 검토. 비교만으로 현재 표를 덮어쓰지 않습니다.",
      gain: "다른 위치로 옮겨진 행도 ID를 기준으로 비교합니다.",
      headers: ["ID", "상태"],
      beforeRows: [
        ["001", "Open"],
        ["002", "Done"],
      ],
      incoming: [
        ["001", "Done"],
        ["003", "Open"],
      ],
      afterRows: [
        ["001", "Open → Done"],
        ["002", "새 파일에 없음"],
        ["003", "새 파일에만 있음"],
      ],
      source: "현재 버전 / 새 버전",
      result: "변경 검토",
      sample: "compare" as const,
    },
    {
      label: "명단 정리",
      title: "눈에 잘 안 보이는 공백까지.",
      before: "같아 보이는 이름을 다시 살피고, 공백·빈 행·중복을 각각 정리.",
      after:
        "공백 정리 → 빈 행 제거 → 중복 제거를 차례로 검토·적용. 어떤 항목이 바뀌는지 보고 결정합니다.",
      gain: "원본 대신 작업본에서 정리하고 되돌릴 수 있습니다.",
      headers: ["이름", "지역"],
      beforeRows: [
        ["Mina␠", "␠Seoul"],
        ["Mina", "Seoul"],
        ["␠", "␠"],
      ],
      incoming: [],
      afterRows: [["Mina", "Seoul"]],
      source: "␠ = 눈에 안 보이는 공백",
      result: "세 단계를 적용한 결과",
      sample: "clean" as const,
    },
    {
      label: "다음 주에도",
      title: "해둔 정리 순서를, 다음 파일에.",
      before: "다음 주 파일을 받으면 같은 정리 순서를 처음부터 다시 선택.",
      after:
        "확정한 단계를 레시피 파일로 저장. 새 파일과 열을 연결해 결과를 검토하고 적용합니다.",
      gain: "기억 대신 저장한 단계로 반복합니다. 개별 수동 수정은 레시피에 포함되지 않습니다.",
      headers: ["순서", "정리 작업"],
      beforeRows: [
        ["1", "공백 정리"],
        ["2", "빈 행 제거"],
        ["3", "중복 제거"],
      ],
      incoming: [],
      afterRows: [
        ["새 파일", "레시피 불러오기"],
        ["연결", "파일·열 확인"],
        ["검토", "결과 확인 후 적용"],
      ],
      source: "매주 같은 선택",
      result: "저장한 단계 재사용",
      sample: "clean" as const,
    },
  ],
  en: [
    {
      label: "Combine files",
      title: "Map the columns before you paste.",
      before:
        "Open each incoming file, check column order, copy and paste the rows.",
      after:
        "Map the current and incoming columns, preview the added rows, then apply.",
      gain: "See where each column goes before adding rows.",
      headers: ["Name", "City"],
      beforeRows: [["Mina", "Seoul"]],
      incoming: [["Jae", "Busan"]],
      afterRows: [
        ["Mina", "Seoul"],
        ["Jae", "Busan"],
      ],
      source: "Current + incoming file",
      result: "One result table",
      sample: "append" as const,
    },
    {
      label: "Compare versions",
      title: "Stop switching between two files.",
      before:
        "Go back and forth between last week’s file and the new version to find changes.",
      after:
        "Match rows by ID. Review changed values and rows found in only one file. Comparison does not overwrite your current table.",
      gain: "Compare by ID even when row positions differ.",
      headers: ["ID", "Status"],
      beforeRows: [
        ["001", "Open"],
        ["002", "Done"],
      ],
      incoming: [
        ["001", "Done"],
        ["003", "Open"],
      ],
      afterRows: [
        ["001", "Open → Done"],
        ["002", "Not in new file"],
        ["003", "Only in new file"],
      ],
      source: "Current / new version",
      result: "Change review",
      sample: "compare" as const,
    },
    {
      label: "Clean a list",
      title: "Even the spaces you cannot see.",
      before:
        "Inspect similar names, remove stray spaces, blank rows and duplicates separately.",
      after:
        "Review and apply trim → remove blank rows → deduplicate. Inspect the proposed changes at every step.",
      gain: "Clean a working copy with undo, not your original file.",
      headers: ["Name", "City"],
      beforeRows: [
        ["Mina␠", "␠Seoul"],
        ["Mina", "Seoul"],
        ["␠", "␠"],
      ],
      incoming: [],
      afterRows: [["Mina", "Seoul"]],
      source: "␠ = a space",
      result: "After all three steps",
      sample: "clean" as const,
    },
    {
      label: "Repeat next week",
      title: "Keep the steps, not a checklist.",
      before:
        "Get next week’s file and manually select the same cleaning steps all over again.",
      after:
        "Save confirmed steps as a recipe. Map the next file and columns, review its result, then apply.",
      gain: "Reuse saved steps. Individual manual cell edits are not included in recipes.",
      headers: ["Step", "Operation"],
      beforeRows: [
        ["1", "Trim whitespace"],
        ["2", "Remove blank rows"],
        ["3", "Deduplicate"],
      ],
      incoming: [],
      afterRows: [
        ["New file", "Load recipe"],
        ["Map", "Check file & columns"],
        ["Review", "Inspect then apply"],
      ],
      source: "The same choices each week",
      result: "Reusable steps",
      sample: "clean" as const,
    },
  ],
};

function MiniTable({
  headers,
  rows,
  highlight = false,
}: {
  headers: string[];
  rows: string[][];
  highlight?: boolean;
}) {
  return (
    <table className={`sw-mini-table${highlight ? " is-result" : ""}`}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LandingPage({
  locale,
  openFiles,
  sample,
  onLoad,
  busy = false,
}: Props) {
  const t = words[locale];
  const [exampleIndex, setExampleIndex] = useState(0);
  const example = examples[locale][exampleIndex]!;
  return (
    <main className="sw-landing" id="landing">
      <section className="sw-hero" aria-labelledby="sw-title">
        <div className="sw-hero-copy">
          <p className="sw-product-label">
            <FileSpreadsheet size={16} aria-hidden="true" />
            {t.tag}
          </p>
          <h1 id="sw-title">
            {t.title[0]}
            <br />
            <span>{t.title[1]}</span>
          </h1>
          <p className="sw-lede">{t.lede}</p>
          <div className="sw-hero-actions">
            <button
              className="sw-cta primary"
              disabled={busy}
              onClick={() => void sample("append")}
            >
              {t.start}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
            <button className="sw-cta" disabled={busy} onClick={openFiles}>
              <FolderOpen size={17} aria-hidden="true" />
              {t.open}
            </button>
          </div>
          <ul className="sw-assurances">
            {t.privacy.map((line) => (
              <li key={line}>
                <Check size={14} aria-hidden="true" />
                {line}
              </li>
            ))}
          </ul>
          <a className="sw-quiet-link" href="#examples">
            {t.jump}
            <ArrowDown size={16} aria-hidden="true" />
          </a>
        </div>
        <LandingDemo locale={locale} />
      </section>

      <section
        className="sw-examples"
        id="examples"
        aria-labelledby="sw-examples-title"
      >
        <header className="sw-section-head">
          <h2 id="sw-examples-title">{t.examplesTitle}</h2>
          <p>{t.examplesBody}</p>
        </header>
        <div
          className="sw-case-tabs"
          role="group"
          aria-label={
            locale === "ko" ? "작업 예시 선택" : "Choose a workflow example"
          }
        >
          {examples[locale].map((item, i) => (
            <button
              key={item.label}
              aria-pressed={i === exampleIndex}
              aria-controls="sw-case"
              onClick={() => setExampleIndex(i)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="sw-case" id="sw-case">
          <h3>{example.title}</h3>
          <div className="sw-comparison">
            <div className="sw-before">
              <p className="sw-compare-label">{t.before}</p>
              <p className="sw-compare-description">{example.before}</p>
              <div className="sw-example-data">
                <p>{example.source}</p>
                <MiniTable
                  headers={example.headers}
                  rows={example.beforeRows}
                />
                {example.incoming.length > 0 && (
                  <>
                    <span className="sw-between" aria-hidden="true">
                      +
                    </span>
                    <MiniTable
                      headers={example.headers}
                      rows={example.incoming}
                    />
                  </>
                )}
              </div>
            </div>
            <div className="sw-after">
              <p className="sw-compare-label">
                <Check size={16} aria-hidden="true" />
                {t.after}
              </p>
              <p className="sw-compare-description">{example.after}</p>
              <div className="sw-example-data">
                <p>{example.result}</p>
                <MiniTable
                  headers={example.headers}
                  rows={example.afterRows}
                  highlight
                />
              </div>
              <p className="sw-gain">
                <strong>{t.proof}</strong>
                {example.gain}
              </p>
            </div>
          </div>
          <div className="sw-case-bottom">
            <p>{t.exampleNote}</p>
            <button
              className="sw-cta"
              disabled={busy}
              onClick={() => void sample(example.sample)}
            >
              {t.tryCase}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      <section className="sw-start" aria-labelledby="sw-start-title">
        <div>
          <h2 id="sw-start-title">{t.stepsTitle}</h2>
          <ol className="sw-steps">
            {t.steps.map(([title, body], i) => (
              <li key={title}>
                <span aria-hidden="true">{i + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <aside className="sw-sample-panel">
          <ShieldCheck size={30} aria-hidden="true" />
          <h3>{t.samplesTitle}</h3>
          <p>{t.samplesBody}</p>
          <div className="sw-sample-buttons">
            {(["clean", "append", "compare"] as const).map((kind, i) => (
              <button
                key={kind}
                className="sw-cta"
                disabled={busy}
                onClick={() => void sample(kind)}
              >
                {t.sampleLabels[i]}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
          <button className="sw-quiet-link" disabled={busy} onClick={onLoad}>
            <RotateCcw size={15} aria-hidden="true" />
            {t.load}
          </button>
        </aside>
      </section>

      <section className="sw-projections">
        <div className="sw-view-flow" aria-label={t.optionalLinks.join(" → ")}>
          {t.optionalLinks.map((label, i) => (
            <span key={label}>
              <span className="sw-view-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              {label}
            </span>
          ))}
        </div>
        <div>
          <h2>{t.optionalTitle}</h2>
          <p>{t.optionalBody}</p>
        </div>
      </section>

      <section className="sw-faq" aria-labelledby="sw-faq-title">
        <h2 id="sw-faq-title">{t.faqTitle}</h2>
        <div>
          {t.faq.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <footer className="sw-footer">
        <h2>{t.close}</h2>
        <button className="sw-cta primary" disabled={busy} onClick={openFiles}>
          {t.open}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        <div className="sw-footer-meta">
          <p>
            {t.free}
            <br />
            <span>{t.note}</span>
          </p>
          <a
            className="sw-quiet-link"
            href="https://github.com/duct-tape2/sheet-workbench"
            target="_blank"
            rel="noreferrer"
          >
            {t.github}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </footer>
    </main>
  );
}

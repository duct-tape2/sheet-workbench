import { addDays, weekRange } from "./index";
import type { Dataset, Locale } from "./types";
export type Template = "team" | "requests" | "content";
export function makeDemo(
  template: Template = "team",
  locale: Locale = "en",
  today = new Date().toISOString().slice(0, 10),
): Dataset {
  const ko = locale === "ko";
  const start = weekRange(today).start;
  const titles: Record<Template, string[]> = ko
    ? {
        team: [
          "분기 일정 초안 정리",
          "고객 의견 검토",
          "파트너 미팅 준비",
          "신규 입사자 안내 수정",
          "출시 체크리스트 확인",
          "주간 결과 공유",
          "다음 달 예산 검토",
          "지원 문서 업데이트",
          "팀 회고 진행",
          "고객 인터뷰 일정 조율",
          "이전 요청 후속 확인",
          "장비 교체 범위 검토",
        ],
        requests: [
          "회의실 장비 점검",
          "협력사 연락처 갱신",
          "사무용품 요청 확인",
          "방문자 안내문 수정",
          "노트북 대여 요청",
          "행사 지원 요청",
          "공용 폴더 정리",
          "교육 일정 확인",
          "문의 답변 초안",
          "접수 양식 개선",
          "완료 요청 정리",
          "보류 요청 재확인",
        ],
        content: [
          "9월 뉴스레터 초안",
          "제품 소개 영상 검토",
          "고객 사례 인터뷰",
          "행사 안내 게시",
          "블로그 글 검수",
          "브랜드 자료 업데이트",
          "다음 캠페인 일정",
          "영상 자막 확인",
          "사진 사용 동의 확인",
          "이벤트 결과 정리",
          "지난 소식 아카이브",
          "콘텐츠 아이디어 정리",
        ],
      }
    : {
        team: [
          "Draft the quarterly roadmap",
          "Review customer feedback",
          "Prepare partner meeting",
          "Update the onboarding guide",
          "Check the launch checklist",
          "Share the weekly update",
          "Review next month’s budget",
          "Refresh support documentation",
          "Run the team retrospective",
          "Schedule customer interviews",
          "Follow up on earlier requests",
          "Scope equipment replacement",
        ],
        requests: [
          "Check meeting-room equipment",
          "Update supplier contacts",
          "Review supply requests",
          "Revise the visitor guide",
          "Arrange a laptop loan",
          "Coordinate event support",
          "Organize the shared folder",
          "Confirm training dates",
          "Draft a support response",
          "Improve the intake form",
          "Archive completed requests",
          "Review paused requests",
        ],
        content: [
          "Draft September newsletter",
          "Review product video",
          "Interview a customer",
          "Publish the event notice",
          "Review the blog draft",
          "Update brand resources",
          "Plan the next campaign",
          "Check video captions",
          "Confirm photo permissions",
          "Summarize event results",
          "Archive earlier updates",
          "Collect content ideas",
        ],
      };
  const fields = [
    {
      key: "title",
      label: ko ? "업무명" : "Task",
      type: "text" as const,
      required: true,
    },
    { key: "date", label: ko ? "날짜" : "Date", type: "date" as const },
    {
      key: "assignee",
      label: ko ? "담당자" : "Assignee",
      type: "text" as const,
    },
    {
      key: "status",
      label: ko ? "상태" : "Status",
      type: "select" as const,
      options: ko
        ? ["대기", "진행 중", "검토", "완료"]
        : ["To do", "In progress", "In review", "Done"],
    },
    { key: "category", label: ko ? "분류" : "Category", type: "text" as const },
    { key: "notes", label: ko ? "메모" : "Notes", type: "text" as const },
    {
      key: "url",
      label: ko ? "원문 링크" : "Source URL",
      type: "url" as const,
    },
  ];
  const names = ["Maya", "Alex", "Sam", "Rin"];
  const categories = ko
    ? ["운영", "프로젝트", "지원"]
    : ["Operations", "Project", "Support"];
  return {
    id: `demo-${template}`,
    name: ko
      ? {
          team: "우리 팀 업무",
          requests: "요청 처리 현황",
          content: "콘텐츠 일정",
        }[template]
      : {
          team: "Team workplan",
          requests: "Request tracker",
          content: "Content schedule",
        }[template],
    source: {
      kind: "demo",
      fileName: `${template}-sample.xlsx`,
      sheetName: "Tasks",
    },
    fields,
    mapping: {
      title: "title",
      date: "date",
      assignee: "assignee",
      status: "status",
      category: "category",
      url: "url",
    },
    records: titles[template].map((title, i) => ({
      id: `sample-${template}-${i}`,
      revision: 0,
      sourceRow: i + 2,
      values: {
        title,
        date: i === 11 ? null : addDays(start, i === 10 ? -3 : i % 10),
        assignee: names[i % 4],
        status: fields[3].options![i % 4],
        category: categories[i % 3],
        notes: ko
          ? "체험을 위한 가상 자료입니다. 자유롭게 수정해 보세요."
          : "Synthetic sample. Try editing this record.",
        url: null,
      },
    })),
    revision: 0,
    locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dateOrder: "ymd",
    weekStartsOn: 1,
    updatedAt: new Date().toISOString(),
    completedStatuses: [ko ? "완료" : "Done"],
  };
}

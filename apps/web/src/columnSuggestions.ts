import type { Mapping } from "../../../packages/core/src/types";
const aliases: Record<keyof Mapping, string[]> = {
  title: [
    "title",
    "task",
    "taskname",
    "work",
    "subject",
    "request",
    "event",
    "업무명",
    "업무",
    "제목",
    "요청명",
    "행사명",
  ],
  date: [
    "date",
    "duedate",
    "deadline",
    "publishdate",
    "startdate",
    "날짜",
    "마감일",
    "등재일",
    "게시일",
    "일정",
  ],
  assignee: ["assignee", "owner", "responsible", "담당자", "등록자"],
  status: ["status", "progress", "상태", "진행상태", "진행현황"],
  category: ["category", "type", "platform", "분류", "유형", "플랫폼", "채널"],
  url: ["url", "link", "sourceurl", "링크", "주소", "원문"],
  identity: ["id", "recordid", "taskid", "고유id", "관리번호", "업무id"],
};
/** Suggestions never mutate a source or confirm a mapping for the user. */
export function suggestColumns(
  fields: { key: string; label: string }[],
): Mapping {
  const normalize = (v: string) =>
    v
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s_.-]+/g, "");
  const suggestion: Partial<Mapping> = {};
  for (const [role, names] of Object.entries(aliases)) {
    const matches = fields.filter((f) => names.includes(normalize(f.label)));
    if (matches.length === 1)
      suggestion[role as keyof Mapping] = matches[0].key;
  }
  return {
    ...suggestion,
    title:
      suggestion.title ??
      fields.find((f) => f.key !== suggestion.identity)?.key ??
      fields[0]?.key ??
      "",
  };
}

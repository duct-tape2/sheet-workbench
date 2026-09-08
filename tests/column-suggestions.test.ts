import { it, expect } from "vitest";
import { suggestColumns } from "../apps/web/src/columnSuggestions";
it("suggests known English and Korean headers, leaves ambiguity for review", () => {
  expect(
    suggestColumns([
      { key: "a", label: "ID" },
      { key: "b", label: "Task" },
      { key: "c", label: "Due Date" },
      { key: "d", label: "담당자" },
    ]),
  ).toEqual({ identity: "a", title: "b", date: "c", assignee: "d" });
  expect(
    suggestColumns([
      { key: "a", label: "업무명" },
      { key: "b", label: "날짜" },
      { key: "c", label: "마감일" },
    ]),
  ).toEqual({ title: "a" });
});

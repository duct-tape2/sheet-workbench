import { describe, expect, it } from "vitest";
import { initialLocale } from "../apps/web/src/locale";

describe("interface language selection", () => {
  it.each([
    ["?lang=ko", "en", "en-US", "ko"],
    ["?lang=en", "ko", "ko-KR", "en"],
    ["", "ko", "en-US", "ko"],
    ["", "en", "ko-KR", "en"],
    ["?lang=invalid", null, "ko-KR", "ko"],
    ["", { invalid: true }, "en-US", "en"],
    ["", null, "KO-kr", "ko"],
    ["?invite=example&lang=ko", null, "ja-JP", "ko"],
  ])("resolves %s / %j / %s safely", (search, saved, browser, expected) => {
    expect(initialLocale(search as string, saved, browser as string)).toBe(
      expected,
    );
  });
});

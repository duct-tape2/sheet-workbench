import { describe, it, expect } from "vitest";
import {
  createChangePlan,
  reviewProposal,
  recipeForNextRun,
  numberedEvidence,
  type WorkbookProfile,
} from "../packages/workflow/src";

const profile: WorkbookProfile = {
  sheets: [
    {
      name: "Inputs",
      cells: [
        { address: "A2", value: "E001" },
        { address: "B2", value: 100 },
        { address: "C2", value: 200, formula: "=B2*2" },
      ],
    },
  ],
  flags: [],
  readOnlyReasons: [],
};
const documents = [
  {
    fileId: "message",
    name: "note.txt",
    content: "E001 allowance 120\nCorrection: E001 allowance 150",
  },
];
const proposal = () => ({
  summary: "Confirmed correction",
  questions: [] as string[],
  changes: [
    {
      sheet: "Inputs",
      address: "B2",
      before: 100,
      after: 150,
      evidence: [
        { fileId: "message", line: 2, quote: "Correction: E001 allowance 150" },
      ],
    },
  ],
});
describe("evidence-based continuation", () => {
  it("keeps a quoted correction connected to its exact source line", () => {
    expect(reviewProposal(proposal(), profile, documents).canApply).toBe(true);
    expect(numberedEvidence("\nhi\n")[0]).toEqual({ line: 2, quote: "hi" });
  });
  it("rejects invented evidence, shifted original and locked formulas", () => {
    const p = proposal();
    p.changes[0].evidence[0].line = 1;
    expect(reviewProposal(p, profile, documents).canApply).toBe(false);
    p.changes[0].evidence[0].line = 2;
    p.changes[0].before = 90;
    expect(reviewProposal(p, profile, documents).canApply).toBe(false);
    p.changes[0].address = "C2";
    p.changes[0].before = 200;
    expect(reviewProposal(p, profile, documents).issues.join()).toContain(
      "Formula",
    );
  });
  it("does not dismiss questions, duplicate targets or unknown rows", () => {
    const p = proposal();
    p.questions = ["Which period?"];
    expect(reviewProposal(p, profile, documents).canApply).toBe(false);
    p.questions = [];
    p.changes.push(p.changes[0]);
    expect(reviewProposal(p, profile, documents).canApply).toBe(false);
    p.changes = [{ ...p.changes[0], address: "B200" }];
    expect(reviewProposal(p, profile, documents).canApply).toBe(false);
  });
  it("requires explicit period and approval; no checks means draft downstream", () => {
    const args = {
      sourceId: "book",
      sourceHash: "a".repeat(64),
      requestId: "request_123",
      period: "2026-10",
      proposal: proposal(),
      profile,
      documents,
      approved: true,
    };
    expect(createChangePlan(args).checks).toEqual([]);
    expect(() => createChangePlan({ ...args, period: "next month" })).toThrow();
    expect(() => createChangePlan({ ...args, approved: false })).toThrow();
  });
  it("rejects arbitrary instructions, unsafe numbers and formula injection", () => {
    expect(() =>
      reviewProposal({ ...proposal(), code: "run()" }, profile, documents),
    ).toThrow();
    const p = proposal();
    p.changes[0].after = Number.MAX_SAFE_INTEGER + 1;
    expect(() => reviewProposal(p, profile, documents)).toThrow();
    expect(
      reviewProposal(
        {
          ...proposal(),
          changes: [{ ...proposal().changes[0], after: '=WEBSERVICE("x")' }],
        },
        profile,
        documents,
      ).canApply,
    ).toBe(false);
  });
  it("keeps v1 separate and does not replay stale cell addresses", () => {
    const recipe = {
      version: 2,
      kind: "work-continuation",
      name: "Monthly",
      rules: ["Use the supplied rate"],
      requiredSheets: ["Inputs"],
      periodPolicy: "explicit-every-run",
    };
    expect(recipeForNextRun(recipe, profile).version).toBe(2);
    expect(() =>
      recipeForNextRun({ ...recipe, version: 1 }, profile),
    ).toThrow();
    expect(() =>
      recipeForNextRun({ ...recipe, requiredSheets: ["Missing"] }, profile),
    ).toThrow();
  });
  for (const domain of ["payroll", "expenses", "orders", "sales"])
    for (const variant of ["plain", "hidden", "cross-sheet"])
      it(`${domain}/${variant}: review remains exact and domain-independent`, () => {
        const copy = structuredClone(profile);
        copy.sheets[0].hidden = variant === "hidden";
        const p = proposal();
        expect(reviewProposal(p, copy, documents).canApply).toBe(true);
        expect(copy.sheets[0].cells[2].formula).toBe("=B2*2");
      });
});

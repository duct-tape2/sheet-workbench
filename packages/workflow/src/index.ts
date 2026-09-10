import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const cell = z.union([
  z.string().max(32000),
  z
    .number()
    .finite()
    .refine(
      (n) => !Number.isInteger(n) || Number.isSafeInteger(n),
      "Unsafe integer",
    ),
  z.boolean(),
  z.null(),
]);
const address = z
  .string()
  .regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/)
  .refine((value) => {
    const match = /^([A-Z]+)(\d+)$/.exec(value)!;
    const col = [...match[1]].reduce(
      (n, c) => n * 26 + c.charCodeAt(0) - 64,
      0,
    );
    return col <= 16384 && Number(match[2]) <= 1048576;
  }, "Outside Excel bounds");
export const PeriodSchema = z
  .string()
  .regex(
    /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/,
    "Choose an explicit YYYY-MM period",
  );
export const EvidenceRefSchema = z
  .object({
    fileId: text,
    line: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    quote: text,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export interface EvidenceDocument {
  fileId: string;
  name: string;
  content: string;
}
export interface WorkbookProfile {
  sheets: Array<{
    name: string;
    hidden?: boolean | string;
    cells: Array<{
      address: string;
      value: string | number | boolean | null;
      formula?: string | null;
    }>;
  }>;
  flags: string[];
  readOnlyReasons: string[];
}
export const ProposalSchema = z
  .object({
    summary: z.string().max(8000),
    questions: z.array(text).max(100),
    changes: z
      .array(
        z
          .object({
            sheet: text,
            address,
            before: cell,
            after: cell,
            evidence: z.array(EvidenceRefSchema).min(1).max(20),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type ChangeProposal = z.infer<typeof ProposalSchema>;
export const WorkRecipeV2Schema = z
  .object({
    version: z.literal(2),
    kind: z.literal("work-continuation"),
    name: text,
    rules: z.array(text).min(1).max(100),
    requiredSheets: z.array(text).min(1).max(100),
    periodPolicy: z.literal("explicit-every-run"),
  })
  .strict();
export type WorkRecipeV2 = z.infer<typeof WorkRecipeV2Schema>;
export interface ChangePlan {
  sourceId: string;
  sourceHash: string;
  requestId: string;
  period: string;
  changes: ChangeProposal["changes"];
  checks: Array<{
    sheet: string;
    address: string;
    expected: string | number | boolean | null;
  }>;
  approved: true;
}
export interface VerificationReport {
  status: "draft" | "verified" | "blocked";
  issues: string[];
  checks: Array<{ name: string; passed: boolean }>;
}

/** Every proposal remains data. No eval, generated-code execution or formula substitution. */
export function reviewProposal(
  input: unknown,
  profile: WorkbookProfile,
  documents: EvidenceDocument[],
) {
  const proposal = ProposalSchema.parse(input);
  const issues = [...profile.readOnlyReasons, ...proposal.questions];
  const seen = new Set<string>();
  for (const change of proposal.changes) {
    const key = `${change.sheet}\u0000${change.address}`;
    if (seen.has(key))
      issues.push(`Duplicate target: ${change.sheet}!${change.address}`);
    seen.add(key);
    const sheet = profile.sheets.find((s) => s.name === change.sheet);
    const target = sheet?.cells.find((c) => c.address === change.address);
    // Adding rows is a structural edit and must not be inferred from a missing cell.
    if (!target) {
      issues.push(`Unknown target: ${change.sheet}!${change.address}`);
      continue;
    }
    if (target.formula)
      issues.push(`Formula is protected: ${change.sheet}!${change.address}`);
    if (target.value !== change.before)
      issues.push(`Original value changed: ${change.sheet}!${change.address}`);
    if (typeof change.after === "string" && /^\s*[=+@]/.test(change.after))
      issues.push(
        `Formula-like input requires manual review: ${change.sheet}!${change.address}`,
      );
    for (const ref of change.evidence) {
      const doc = documents.find((d) => d.fileId === ref.fileId);
      const quoted = ref.line
        ? doc?.content.split(/\r?\n/)[ref.line - 1]
        : doc?.content;
      if (!quoted?.includes(ref.quote))
        issues.push(`Evidence does not match source: ${ref.fileId}`);
      // Page numbers are not certified by an unpaginated text extraction.
      if (ref.page)
        issues.push(
          `Verify document page manually: ${ref.fileId}, ${ref.page}`,
        );
    }
  }
  return {
    proposal,
    issues,
    canApply: issues.length === 0 && proposal.changes.length > 0,
  };
}

export function createChangePlan(args: {
  sourceId: string;
  sourceHash: string;
  requestId: string;
  period: string;
  proposal: unknown;
  profile: WorkbookProfile;
  documents: EvidenceDocument[];
  approved: boolean;
  checks?: ChangePlan["checks"];
}): ChangePlan {
  const review = reviewProposal(args.proposal, args.profile, args.documents);
  if (!args.approved || !review.canApply)
    throw new Error(
      "Resolve every question and review changes before applying.",
    );
  PeriodSchema.parse(args.period);
  z.string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(args.sourceHash);
  z.string()
    .regex(/^[a-zA-Z0-9_-]{8,100}$/)
    .parse(args.requestId);
  text.parse(args.sourceId);
  const checks = z
    .array(z.object({ sheet: text, address, expected: cell }).strict())
    .max(1000)
    .parse(args.checks ?? []);
  return {
    sourceId: args.sourceId,
    sourceHash: args.sourceHash,
    requestId: args.requestId,
    period: args.period,
    changes: review.proposal.changes,
    checks,
    approved: true,
  };
}

export function recipeForNextRun(
  input: unknown,
  profile: WorkbookProfile,
): WorkRecipeV2 {
  const recipe = WorkRecipeV2Schema.parse(input);
  if (
    recipe.requiredSheets.some(
      (name) => !profile.sheets.some((s) => s.name === name),
    )
  )
    throw new Error(
      "The workbook structure changed. Review the recipe before using it.",
    );
  return recipe;
}

export function numberedEvidence(content: string) {
  return content
    .split(/\r?\n/)
    .map((quote, index) => ({ line: index + 1, quote }))
    .filter((item) => item.quote.trim());
}

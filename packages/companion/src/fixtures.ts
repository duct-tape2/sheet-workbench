import { createSyntheticWorkbook } from "./workbook.ts";

export interface CompanionWorkbookFixture {
  id: string;
  domain: "payroll" | "expense" | "orders" | "sales";
  period: "previous" | "next" | "combined";
  shape: "plain" | "hidden-crossref" | "nested-names";
  sheetName: string;
  bytes: Uint8Array;
  expectedLabels: string[];
  expectedTotal: number;
  totalAddress: string;
}

const fixtureInputs: Array<{
  id: string;
  domain: CompanionWorkbookFixture["domain"];
  period: CompanionWorkbookFixture["period"];
  shape: CompanionWorkbookFixture["shape"];
  rows: Array<{ label: string; amount: number }>;
}> = [
  {
    id: "payroll-previous",
    domain: "payroll",
    period: "previous",
    shape: "plain",
    rows: [
      { label: "Ari", amount: 1200 },
      { label: "Bo", amount: 800 },
    ],
  },
  {
    id: "payroll-next",
    domain: "payroll",
    period: "next",
    shape: "hidden-crossref",
    rows: [
      { label: "Ari", amount: 1300 },
      { label: "Bo", amount: 900 },
    ],
  },
  {
    id: "payroll-combined",
    domain: "payroll",
    period: "combined",
    shape: "nested-names",
    rows: [
      { label: "Ari", amount: 2500 },
      { label: "Bo", amount: 1700 },
    ],
  },
  {
    id: "expense-previous",
    domain: "expense",
    period: "previous",
    shape: "plain",
    rows: [
      { label: "Rent", amount: 500 },
      { label: "Travel", amount: 120 },
    ],
  },
  {
    id: "expense-next",
    domain: "expense",
    period: "next",
    shape: "hidden-crossref",
    rows: [
      { label: "Rent", amount: 500 },
      { label: "Travel", amount: 240 },
    ],
  },
  {
    id: "expense-combined",
    domain: "expense",
    period: "combined",
    shape: "nested-names",
    rows: [
      { label: "Rent", amount: 1000 },
      { label: "Travel", amount: 360 },
    ],
  },
  {
    id: "orders-previous",
    domain: "orders",
    period: "previous",
    shape: "plain",
    rows: [
      { label: "Order-101", amount: 4 },
      { label: "Order-102", amount: 6 },
    ],
  },
  {
    id: "orders-next",
    domain: "orders",
    period: "next",
    shape: "hidden-crossref",
    rows: [
      { label: "Order-103", amount: 8 },
      { label: "Order-104", amount: 3 },
    ],
  },
  {
    id: "orders-combined",
    domain: "orders",
    period: "combined",
    shape: "nested-names",
    rows: [
      { label: "Order-101", amount: 4 },
      { label: "Order-104", amount: 3 },
      { label: "Order-103", amount: 8 },
    ],
  },
  {
    id: "sales-previous",
    domain: "sales",
    period: "previous",
    shape: "plain",
    rows: [
      { label: "North", amount: 2100 },
      { label: "South", amount: 1800 },
    ],
  },
  {
    id: "sales-next",
    domain: "sales",
    period: "next",
    shape: "hidden-crossref",
    rows: [
      { label: "North", amount: 2500 },
      { label: "South", amount: 1900 },
    ],
  },
  {
    id: "sales-combined",
    domain: "sales",
    period: "combined",
    shape: "nested-names",
    rows: [
      { label: "North", amount: 4600 },
      { label: "South", amount: 3700 },
    ],
  },
];

/** Twelve non-proprietary fixtures with independently calculated controls. */
export function companionWorkbookFixtures(): CompanionWorkbookFixture[] {
  return fixtureInputs.map((input) => {
    const sheetName = `${input.domain[0].toUpperCase()}${input.domain.slice(1)} ${input.period}`;
    const expectedTotal = input.rows.reduce((sum, row) => sum + row.amount, 0);
    return {
      id: input.id,
      domain: input.domain,
      period: input.period,
      shape: input.shape,
      sheetName,
      bytes: createSyntheticWorkbook({
        sheetName,
        rows: input.rows,
        shape: input.shape,
      }),
      expectedLabels: input.rows.map((row) => row.label),
      expectedTotal,
      totalAddress: `B${input.rows.length + 2}`,
    };
  });
}

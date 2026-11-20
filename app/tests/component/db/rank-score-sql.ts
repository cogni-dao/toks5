// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/rank-score-sql`
 * Purpose: The rank policy's native SQL, as the work-items package's private `rankScoreSql()` emits it, for the native-parity test in `doltgres-work-items.int.test.ts`.
 * Scope: Test helper. A literal copy because the package ships the rank policy privately (story.0085 adoption removed the vendored source); `rankScore` from `@cogni/work-items` is the evaluator side of the parity check.
 * Invariants: Same tree as the package: ((goal + time + unblocks) / iterations(ease)) * confidence / 5, null unless every axis is an integer 1..5.
 * Side-effects: none
 * @internal
 */

const number = (value: number) => `CAST(${value} AS DOUBLE PRECISION)`;
const axisSql = (name: string) => {
  const value = `(scores -> '${name}' -> 'v')`;
  const cast = `CAST((scores -> '${name}' ->> 'v') AS DOUBLE PRECISION)`;
  return `(CASE WHEN ${value} IN ('1'::JSONB,'2'::JSONB,'3'::JSONB,'4'::JSONB,'5'::JSONB) THEN ${cast} ELSE NULL END)`;
};
const EASE_ITERATIONS: Readonly<Record<number, number>> = { 5: 1, 4: 1.5, 3: 2.5, 2: 5, 1: 8 };

export function rankScoreSql(): string {
  const iterations = `(CASE ${axisSql("ease")} ${Object.entries(EASE_ITERATIONS)
    .map(([ease, n]) => `WHEN ${ease} THEN ${number(n)}`)
    .join(" ")} ELSE NULL END)`;
  const sum = `((${axisSql("goal")} + ${axisSql("time")}) + ${axisSql("unblocks")})`;
  const policy = `(((${sum} / ${iterations}) * ${axisSql("confidence")}) / ${number(5)})`;
  return `(CASE WHEN ${axisSql("agent")} IS NOT NULL THEN ${policy} ELSE NULL END)`;
}

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/governance-sync-apply-mode`
 * Purpose: Prove withEnvApplyMode resolves the work-prioritization applyMode per DEPLOY_ENVIRONMENT (story.5101).
 * Scope: Pure function test; every IO dep of the job module is mocked. Does not touch Temporal or Postgres.
 * Invariants:
 *   - APPLY_MODE_BY_ENV: `apply.mode[<env>]` wins, else `default`; non-prioritizer schedules are untouched
 * Side-effects: none
 * Links: src/bootstrap/jobs/syncGovernanceSchedules.job.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/config", () => ({
  getGovernanceConfig: () => ({ schedules: [] }),
  getNodeId: () => "node-id",
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({ GOVERNANCE_SCHEDULES_ENABLED: true }),
}));
vi.mock("@/shared/db/schema", () => ({ schedules: {} }));
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: () => ({}),
}));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({}) }));

import { withEnvApplyMode } from "@/bootstrap/jobs/syncGovernanceSchedules.job";

describe("withEnvApplyMode (APPLY_MODE_BY_ENV)", () => {
  const config = {
    schedules: [
      {
        charter: "WORK_PRIORITIZER",
        cron: "0 * * * *",
        timezone: "UTC",
        entrypoint: "PRIORITIZE",
        graph: "langgraph:work-prioritizer",
        model: "gpt-oss-120b",
        payload: {
          workPrioritization: {
            policyVersion: "v5.0",
            applyMode: "propose" as const,
            applyModes: {
              default: "propose" as const,
              "candidate-a": "write" as const,
            },
          },
        },
      },
      {
        charter: "LEDGER_INGEST",
        cron: "0 0 * * *",
        timezone: "UTC",
        entrypoint: "LEDGER_INGEST",
      },
    ],
  };
  const mode = (env: string | undefined) =>
    withEnvApplyMode(config, env).schedules[0]?.payload?.workPrioritization
      .applyMode;

  it("an env override wins; every other env (and unset) uses default; other schedules untouched", () => {
    expect(mode("candidate-a")).toBe("write");
    expect(mode("production")).toBe("propose");
    expect(mode(undefined)).toBe("propose");
    expect(withEnvApplyMode(config, "candidate-a").schedules[1]).toEqual(
      config.schedules[1]
    );
  });
});

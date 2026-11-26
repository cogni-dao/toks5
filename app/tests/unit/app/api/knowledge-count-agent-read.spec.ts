// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/knowledge-count-agent-read`
 * Purpose: Only an agent's HTTP atom read is counted; a signed-in human never is (story.0061).
 * Scope: `countAgentRead` with a mocked container and counter.
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/_usage.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.hoisted(() => vi.fn());
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ knowledgeReadCounter: { count } }),
}));

import { countAgentRead } from "@/app/api/v1/knowledge/_usage";

const user = (via?: "bearer" | "session") =>
  ({ id: "u1", via }) as unknown as Parameters<typeof countAgentRead>[0];

describe("countAgentRead", () => {
  beforeEach(() => count.mockClear());

  // Defect guarded: human browse reads counted as agent reads, so the browse UI dominated the read-miss KPI.
  it("never counts a session human", () => {
    countAgentRead(user("session"), "atom-a", "ok");
    expect(count).not.toHaveBeenCalled();
  });

  it("counts a bearer agent as an external agent with the outcome", () => {
    countAgentRead(user("bearer"), "atom-a", "fail");
    expect(count).toHaveBeenCalledWith({
      atomId: "atom-a",
      outcome: "fail",
      principalId: "u1",
      principalClass: "external_agent",
    });
  });
});

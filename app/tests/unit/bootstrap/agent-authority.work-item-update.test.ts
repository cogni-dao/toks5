// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyright-Text: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-authority.work-item-update`
 * Purpose: The `work.items.patch` route door resolves the `work_item:transition` scope from the PACKAGE's `core__work_item_update` tool contract
 *   (`@cogni/shared-ai-tools`), with no node-local declaration. Drives the REAL `createAgentToolAuthority.authorizeRoute` (only the SQL tag is a fake).
 * Scope: declared scope, bearer with and without a live role row.
 * Invariants: NO_COPIED_DECLARATION (the scope comes from the shipped contract); a missing declaration would deny with `no_requires`, never `no_role`.
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";

import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
} from "@/bootstrap/agent-authority";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
log.child.mockReturnValue(log);

function authorityWith(roles: Set<string>) {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("FROM agent_roles"))
      return roles.has(`${values[0]}|${values[1]}`) ? [{ ok: 1 }] : [];
    return [];
  }) as unknown as AgentAuthoritySql;
  (tag as unknown as { begin: unknown }).begin = async (fn: (t: unknown) => Promise<unknown>) => fn(tag);
  return createAgentToolAuthority({
    sql: tag,
    nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
    log: log as never,
    toolBundle: CORE_TOOL_BUNDLE as never,
  });
}

const route = { toolId: "core__work_item_update", routeId: "work.items.patch", userId: "agent-1", via: "bearer" } as const;

describe("work.items.patch route door", () => {
  it("the package tool contract declares work_item:transition, and the node catalog lists it", () => {
    const tool = CORE_TOOL_BUNDLE.find((t) => t.contract.name === "core__work_item_update");
    expect(tool?.contract.requires?.scope).toBe("work_item:transition");
    expect(authorityWith(new Set()).declaredScopes).toContain("work_item:transition");
  });

  it("resolves the scope: no role row is policy_denied no_role (not no_requires)", async () => {
    const decision = await authorityWith(new Set()).authorizeRoute(route);
    expect(decision).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
  });

  it("a live work_item:transition role row opens the door", async () => {
    const decision = await authorityWith(new Set(["agent-1|work_item:transition"])).authorizeRoute(route);
    expect(decision.decision).toBe("allow");
  });
});

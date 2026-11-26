// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/knowledge-usage/knowledge-read-counting`
 * Purpose: An in-process knowledge read counts ok on a hit and fail on a miss, and a call outside a run scope counts nothing (story.0061).
 * Scope: The `withReadCounting` decorator with a fake counter and capability.
 * Side-effects: none
 * Links: src/adapters/server/knowledge-usage/counting-knowledge-capability.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";

import { withReadCounting } from "@/adapters/server/knowledge-usage/counting-knowledge-capability";

describe("withReadCounting", () => {
  const capability = (hit: boolean) =>
    ({
      get: vi.fn(async () => (hit ? { id: "a" } : null)),
      search: vi.fn(),
      list: vi.fn(),
      write: vi.fn(),
    }) as never;

  // Defect guarded: a read that returned null was counted as ok, hiding every dead link from the read-miss KPI.
  it("counts ok on a hit and fail on a miss, for the scoped principal", async () => {
    const count = vi.fn();
    const counter = { count } as never;
    const hit = withReadCounting(capability(true), counter, () => ({ principalId: "p1" }));
    await (hit as unknown as { get(id: string): Promise<unknown> }).get("a");
    const miss = withReadCounting(capability(false), counter, () => ({ principalId: "p1" }));
    await (miss as unknown as { get(id: string): Promise<unknown> }).get("zzz");
    expect(count.mock.calls.map((c) => [c[0]?.atomId, c[0]?.outcome])).toEqual([
      ["a", "ok"],
      ["zzz", "fail"],
    ]);
  });

  it("counts nothing outside a run scope", async () => {
    const count = vi.fn();
    const wrapped = withReadCounting(capability(true), { count } as never, () => undefined);
    await (wrapped as unknown as { get(id: string): Promise<unknown> }).get("a");
    expect(count).not.toHaveBeenCalled();
  });
});

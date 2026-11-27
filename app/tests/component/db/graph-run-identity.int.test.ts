// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/component/db/graph-run-identity
 * Purpose: Exercise canonical run creation and execution claims against PostgreSQL.
 * Scope: Real Drizzle adapters, concurrent connections and schedule history; no Temporal.
 * Invariants: One identity per new runId; slot retries preserve history; losers create no rows.
 * Side-effects: IO (isolated component PostgreSQL database)
 * Links: https://github.com/cogni-dao/toks5/pull/84
 * @internal
 */
import { randomUUID } from "node:crypto";
import {
  DrizzleExecutionRequestAdapter,
  DrizzleGraphRunAdapter,
} from "@cogni/db-client";
import {
  billingAccounts,
  executionGrants,
  executionRequests,
  graphRuns,
  schedules,
  users,
} from "@cogni/db-schema";
import { SYSTEM_ACTOR } from "@cogni/ids/system";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const owner = randomUUID();
const other = randomUUID();
const scheduleId = randomUUID();
const runIds: string[] = [];
const keys: string[] = [];
const nextRun = () => {
  const id = randomUUID();
  runIds.push(id);
  return id;
};
const facts = (runId: string) => ({
  runId,
  graphId: "langgraph:default",
  runKind: "user_immediate" as const,
  triggerSource: "api",
  triggerRef: "component",
  requestedBy: owner,
});
const db = () => getSeedDb();
const runs = () => new DrizzleGraphRunAdapter(db());

describe("canonical graph run creation (real PostgreSQL)", () => {
  beforeAll(async () => {
    await db()
      .insert(users)
      .values([{ id: owner }, { id: other }]);
    const billingId = randomUUID();
    const grantId = randomUUID();
    await db()
      .insert(billingAccounts)
      .values({ id: billingId, ownerUserId: owner, balanceCredits: 0n });
    await db()
      .insert(executionGrants)
      .values({
        id: grantId,
        userId: owner,
        billingAccountId: billingId,
        scopes: ["graph:execute:langgraph:default"],
      });
    await db()
      .insert(schedules)
      .values({
        id: scheduleId,
        ownerUserId: owner,
        executionGrantId: grantId,
        graphId: "langgraph:default",
        input: {},
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
      });
  });
  afterAll(async () => {
    if (keys.length)
      await db()
        .delete(executionRequests)
        .where(inArray(executionRequests.idempotencyKey, keys));
    if (runIds.length)
      await db().delete(graphRuns).where(inArray(graphRuns.runId, runIds));
    await db()
      .delete(users)
      .where(inArray(users.id, [owner, other]));
  });

  it("returns the original API/webhook identity on sequential conflicts without resetting its state", async () => {
    const runId = nextRun();
    const first = await runs().createRun(SYSTEM_ACTOR, facts(runId));
    await runs().markRunCompleted(SYSTEM_ACTOR, runId, "success");
    const conflict = await runs().createRun(SYSTEM_ACTOR, {
      ...facts(runId),
      requestedBy: other,
      graphId: "langgraph:other",
      runKind: "system_webhook",
      triggerSource: "webhook:github",
    });
    expect(conflict).toMatchObject({
      id: first.id,
      requestedBy: owner,
      graphId: first.graphId,
      runKind: "user_immediate",
      triggerSource: "api",
      status: "success",
    });
    expect(
      await db().select().from(graphRuns).where(eq(graphRuns.runId, runId)),
    ).toHaveLength(1);
  });

  it("serializes conflicting concurrent identities and same-identity retries", async () => {
    const runId = nextRun();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runs().createRun(SYSTEM_ACTOR, {
          ...facts(runId),
          requestedBy: i % 2 ? other : owner,
        }),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(new Set(results.map((row) => row.requestedBy)).size).toBe(1);
    expect(
      await db().select().from(graphRuns).where(eq(graphRuns.runId, runId)),
    ).toHaveLength(1);
  });

  it("preserves scheduled slot retries, successive slots and null-slot history", async () => {
    const scheduledFor = new Date("2026-11-27T12:00:00Z");
    const scheduled = {
      ...facts(nextRun()),
      scheduleId,
      scheduledFor,
      runKind: "system_scheduled" as const,
      triggerSource: "temporal_schedule",
      triggerRef: scheduleId,
    };
    const results = await Promise.all([
      runs().createRun(SYSTEM_ACTOR, scheduled),
      runs().createRun(SYSTEM_ACTOR, { ...scheduled, runId: nextRun() }),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    const canonical = results[0];
    if (!canonical) throw new Error("Missing canonical schedule row");
    await runs().markRunCompleted(SYSTEM_ACTOR, canonical.runId, "timeout");
    expect(
      await runs().createRun(SYSTEM_ACTOR, { ...scheduled, runId: nextRun() }),
    ).toMatchObject({ id: canonical.id, status: "timeout" });
    const next = await runs().createRun(SYSTEM_ACTOR, {
      ...scheduled,
      runId: nextRun(),
      scheduledFor: new Date(scheduledFor.getTime() + 60_000),
    });
    expect(next.id).not.toBe(canonical.id);
    const { scheduledFor: _slot, ...nullSlot } = scheduled;
    const history = await Promise.all([
      runs().createRun(SYSTEM_ACTOR, { ...nullSlot, runId: nextRun() }),
      runs().createRun(SYSTEM_ACTOR, { ...nullSlot, runId: nextRun() }),
    ]);
    expect(history[0]?.id).not.toBe(history[1]?.id);
  });

  it("refuses ambiguous historical runIds without rewriting or deleting them", async () => {
    const runId = nextRun();
    await db()
      .insert(graphRuns)
      .values([facts(runId), { ...facts(runId), requestedBy: other }]);
    await expect(runs().createRun(SYSTEM_ACTOR, facts(runId))).rejects.toThrow(
      "Ambiguous historical",
    );
    await expect(runs().getRunByRunId(SYSTEM_ACTOR, runId)).rejects.toThrow(
      "Ambiguous historical",
    );
    expect(
      await db().select().from(graphRuns).where(eq(graphRuns.runId, runId)),
    ).toHaveLength(2);
  });

  it("allows only the execution claimant to create the optional run, including stale recovery", async () => {
    const key = `identity:${randomUUID()}`;
    keys.push(key);
    const claims = new DrizzleExecutionRequestAdapter(db());
    const contenders = [nextRun(), nextRun()];
    const results = await Promise.all(
      contenders.map((runId) =>
        claims.createPendingRequest(
          key,
          "same-hash",
          runId,
          null,
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ),
    );
    const winners = results.filter((result) => result.status === "claimed");
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner?.status !== "claimed") throw new Error("Missing claimant");
    const runId = winner.request.runId;
    // A crash between claim and creation must recover the claim's runId.
    await db()
      .update(executionRequests)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(executionRequests.idempotencyKey, key));
    const recovered = await claims.createPendingRequest(
      key,
      "same-hash",
      nextRun(),
      null,
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(recovered.status).toBe("claimed");
    if (recovered.status !== "claimed")
      throw new Error("Missing recovered claim");
    expect(recovered.request.runId).toBe(runId);
    await runs().createRun(SYSTEM_ACTOR, facts(recovered.request.runId));
    const rows = await db()
      .select()
      .from(graphRuns)
      .where(inArray(graphRuns.runId, contenders));
    expect(rows.map((row) => row.runId)).toEqual([runId]);
  });
});

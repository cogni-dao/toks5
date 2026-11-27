// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/graph-runs`
 * Purpose: Internal endpoint for scheduler-worker to persist a graph_runs row in this node's database.
 * Scope: Auth-protected POST — creates a graph_runs record owned by this node. Worker holds no DB credentials; this is the only write path.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - Idempotent on runId: repeated create returns 200 with existing row
 * Side-effects: IO (writes graph_runs via GraphRunRepository)
 * Links: graph-runs.create.internal.v1.contract, task.0280
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  InternalCreateGraphRunInputSchema,
  type InternalCreateGraphRunOutput,
} from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "graph-runs.create.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const log = ctx.log;

    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InternalCreateGraphRunInputSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.issues }, "Invalid request body");
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const {
      runId,
      graphId,
      runKind,
      triggerSource,
      triggerRef,
      requestedBy,
      scheduleId,
      scheduledFor,
      stateKey,
    } = parsed.data;
    const container = getContainer();

    const matches = (run: NonNullable<Awaited<ReturnType<typeof container.graphRunRepository.getRunByRunId>>>) =>
      run.runId === runId && run.graphId === (graphId ?? null) &&
      run.runKind === (runKind ?? null) && run.triggerSource === (triggerSource ?? null) &&
      run.triggerRef === (triggerRef ?? null) && run.requestedBy === (requestedBy ?? null) &&
      run.scheduleId === (scheduleId ?? null) &&
      (run.scheduledFor?.getTime() ?? null) === (scheduledFor ? new Date(scheduledFor).getTime() : null);

    try {
      const created = await container.graphRunRepository.createRun(SYSTEM_ACTOR, {
        runId,
        ...(graphId ? { graphId } : {}),
        ...(runKind ? { runKind } : {}),
        ...(triggerSource ? { triggerSource } : {}),
        ...(triggerRef ? { triggerRef } : {}),
        ...(requestedBy ? { requestedBy } : {}),
        ...(scheduleId ? { scheduleId } : {}),
        ...(scheduledFor ? { scheduledFor: new Date(scheduledFor) } : {}),
        ...(stateKey ? { stateKey } : {}),
      });
      // Scheduled-slot inserts can return an existing canonical row without
      // throwing. A different identity is a conflict, never a successful create.
      if (!matches(created)) {
        return NextResponse.json({ error: "Graph run identity mismatch" }, { status: 409 });
      }
    } catch (err) {
      // Idempotency: if a row with this runId already exists, treat as success.
      const existing = await container.graphRunRepository
        .getRunByRunId(SYSTEM_ACTOR, runId)
        .catch(() => null);
      if (!existing) {
        log.error({ runId, err }, "Failed to create graph run");
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      }
      if (!matches(existing)) {
        return NextResponse.json({ error: "Graph run identity mismatch" }, { status: 409 });
      }
      log.info({ runId }, "Idempotent create: row already exists");
    }

    const response: InternalCreateGraphRunOutput = { ok: true, runId };
    return NextResponse.json(response, { status: 200 });
  }
);

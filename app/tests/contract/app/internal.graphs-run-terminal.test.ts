// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/internal.graphs-run-terminal`
 * Purpose: Prove graph-run admission, durable replay, and terminal publication lifecycle.
 * Scope: Internal graph-run route with mocked executor, persistence, stream, and idempotency ports.
 * Invariants: rejected done publication cannot produce a successful execution record.
 * Side-effects: none
 * @internal
 */

import { createHash } from "node:crypto";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "a0000000-0000-4000-a000-000000000001";
const USER_ID = "10000000-0000-4000-a000-000000000001";
const BILLING_ID = "20000000-0000-4000-a000-000000000001";
const VIRTUAL_KEY_ID = "30000000-0000-4000-a000-000000000001";

const mocks = vi.hoisted(() => ({
  runGraph: vi.fn(),
  setupFailure: false,
  scopedSignal: undefined as AbortSignal | undefined,
  scopedRunKind: undefined as string | undefined,
  patchRunStateKey: vi.fn().mockResolvedValue(undefined),
  checkIdempotency: vi.fn().mockResolvedValue({ status: "new" }),
  createPendingRequest: vi.fn().mockResolvedValue({
    status: "claimed",
    request: { runId: "a0000000-0000-4000-a000-000000000001" },
  }),
  heartbeatRequest: vi.fn().mockResolvedValue(undefined),
  finalizeRequest: vi.fn(),
  markRunCompleted: vi.fn().mockResolvedValue(undefined),
  getRunByRunId: vi.fn().mockResolvedValue(null),
  createRun: vi.fn(),
  validateGrant: vi.fn(),
  billingAccount: vi.fn(),
  publish: vi.fn(async (_runId: string, event: { type: string }) => {
    if (event.type === "done") throw new Error("redis unavailable");
  }),
  saveThread: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: never[]) => unknown) =>
    (request: NextRequest, context?: unknown) =>
      handler(
        {
          reqId: "request-1",
          traceId: "00000000000000000000000000000001",
          routeId: "graphs.run.internal",
          clock: { now: () => "2025-01-01T00:00:00.000Z" },
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
        } as never,
        request as never,
        { id: USER_ID } as never,
        context as never
      ),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SCHEDULER_API_TOKEN: "scheduler-secret-value-1234567890" }),
}));

vi.mock("@/bootstrap/graph-executor.factory", () => {
  const executor = {
    runGraph: mocks.runGraph.mockImplementation(() => ({
      stream: (async function* () {
        yield { type: "assistant_final" as const, content: "answer" };
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        requestId: "a0000000-0000-4000-a000-000000000001",
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: "stop" as const,
      }),
    })),
  };
  return {
    createGraphExecutor: () => executor,
    createScopedGraphExecutor: (params: { abortSignal?: AbortSignal; runKind?: string }) => {
      if (mocks.setupFailure) throw new Error("executor setup failed");
      mocks.scopedSignal = params.abortSignal;
      mocks.scopedRunKind = params.runKind;
      return executor;
    },
  };
});

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      heartbeatRequest: mocks.heartbeatRequest,
      finalizeRequest: mocks.finalizeRequest,
    },
    graphRunRepository: {
      markRunCompleted: mocks.markRunCompleted,
      patchRunStateKey: mocks.patchRunStateKey,
      getRunByRunId: mocks.getRunByRunId,
      createRun: mocks.createRun,
    },
    accountsForUser: () => ({}),
    executionGrantWorkerPort: { validateGrantForGraph: mocks.validateGrant },
    serviceAccountService: { getBillingAccountById: mocks.billingAccount },
    providerResolver: {},
    connectionBroker: undefined,
    runStream: {
      publish: mocks.publish,
      expire: vi.fn().mockResolvedValue(undefined),
    },
    threadPersistenceForUser: () => ({
      loadThread: vi.fn().mockResolvedValue([
        { id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]),
      saveThread: mocks.saveThread,
      softDelete: vi.fn(),
      listThreads: vi.fn(),
    }),
  }),
}));

vi.mock("@/app/_facades/work/items.server", () => ({
  getWorkItem: vi.fn(), patchWorkItem: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));

import { POST } from "@/app/api/internal/graphs/[graphId]/runs/route";
import { POST as createRun } from "@/app/api/internal/graph-runs/route";
import { DELETE as deleteItem } from "@/app/api/v1/work/items/[id]/route";

const GRANT_ID = "40000000-0000-4000-a000-000000000001";
const OTHER_RUN_ID = "a0000000-0000-4000-a000-000000000002";
const BASE_RUN = { runId: RUN_ID, graphId: "langgraph:default", runKind: "user_immediate", triggerSource: "api", triggerRef: "api:test", requestedBy: USER_ID, scheduleId: null, scheduledFor: null, stateKey: null };
const BASE_INPUT = { messages: [{ role: "user", content: "hello" }], modelRef: { providerKey: "platform", modelId: "test-model" }, actorUserId: USER_ID, billingAccountId: BILLING_ID, virtualKeyId: VIRTUAL_KEY_ID };
function invoke(body: unknown = { runId: RUN_ID, input: BASE_INPUT }) {
  return POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
    method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": "api:test" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
}
function create(body: unknown) {
  return createRun(new NextRequest("http://localhost/api/internal/graph-runs", {
    method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}


describe("POST /api/internal/graphs/{graphId}/runs terminal publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setupFailure = false;
    mocks.scopedSignal = undefined;
    mocks.scopedRunKind = undefined;
    mocks.checkIdempotency.mockReset().mockResolvedValue({ status: "new" });
    mocks.billingAccount.mockReset().mockResolvedValue({ defaultVirtualKeyId: VIRTUAL_KEY_ID });
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN });
    mocks.createRun.mockReset().mockImplementation(async (_actor, facts) => ({ ...BASE_RUN, ...facts }));
    mocks.validateGrant.mockReset().mockResolvedValue({ userId: USER_ID, billingAccountId: BILLING_ID });
    mocks.createPendingRequest.mockResolvedValue({ status: "claimed", request: { runId: RUN_ID } });
  });

  const profiles = [
    { name: "API subject", kind: "user_immediate", source: "api", grant: false, user: USER_ID, payloadUser: true },
    { name: "API system", kind: "user_immediate", source: "api", grant: false, user: COGNI_SYSTEM_PRINCIPAL_USER_ID, payloadUser: true },
    { name: "scheduled owner", kind: "system_scheduled", source: "temporal_schedule", grant: true, user: USER_ID, payloadUser: false },
    { name: "scheduled system", kind: "system_scheduled", source: "temporal_schedule", grant: true, user: COGNI_SYSTEM_PRINCIPAL_USER_ID, payloadUser: false },
    { name: "webhook subject", kind: "system_webhook", source: "webhook", grant: false, user: USER_ID, payloadUser: true },
    { name: "subjectless webhook", kind: "system_webhook", source: "webhook:github", grant: false, user: COGNI_SYSTEM_PRINCIPAL_USER_ID, payloadUser: true },
    { name: "granted webhook", kind: "system_webhook", source: "webhook:github", grant: true, user: USER_ID, payloadUser: true },
    { name: "granted subjectless webhook", kind: "system_webhook", source: "webhook:github", grant: true, user: COGNI_SYSTEM_PRINCIPAL_USER_ID, payloadUser: false },
  ];
  const lifecycleCases = profiles.flatMap((profile) =>
    ["new", "mismatch", "pending", "stale", "success", "error"].flatMap((state) =>
      (profile.grant ? ["live", "expired", "revoked"] : ["none"]).map((grantState) => ({
        ...profile, state, grantState, label: `${profile.name} / ${state} / ${grantState}`,
      }))));

  it.each(lifecycleCases)("lifecycle matrix: $label", async (test) => {
    const scheduledFor = new Date("2026-01-01T00:00:00.000Z");
    const key = test.kind === "system_scheduled" ? `schedule:${scheduledFor.toISOString()}` : "api:test";
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: test.kind, triggerSource: test.source,
      triggerRef: test.kind === "system_scheduled" ? "schedule" : "delivery-1",
      scheduledFor: test.kind === "system_scheduled" ? scheduledFor : null,
      requestedBy: test.kind === "system_scheduled" ? test.user : test.user === COGNI_SYSTEM_PRINCIPAL_USER_ID ? null : test.user });
    mocks.validateGrant.mockResolvedValue({ userId: test.user, billingAccountId: BILLING_ID });
    if (test.grantState === "expired" || test.grantState === "revoked") {
      const error = new Error(`Grant ${test.grantState}`);
      error.name = test.grantState === "expired" ? "GrantExpiredError" : "GrantRevokedError";
      mocks.validateGrant.mockRejectedValue(error);
    }
    const { actorUserId: _user, ...context } = BASE_INPUT;
    const body = { runId: RUN_ID, executionGrantId: test.grant ? GRANT_ID : null,
      input: { ...context, ...(test.payloadUser ? { actorUserId: test.user } : {}) } };
    const rawBody = JSON.stringify(body);
    const hash = createHash("sha256").update("langgraph:default\n").update(rawBody).digest("hex");
    const cached = test.state === "success" || test.state === "error";
    const record = { idempotencyKey: key, requestHash: hash, runId: RUN_ID, traceId: "original-trace",
      ok: cached ? test.state === "success" : null, errorCode: test.state === "error" ? "timeout" : null,
      leaseExpiresAt: test.state === "stale" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" };
    mocks.checkIdempotency.mockImplementation(async (_key, requestHash) => {
      expect(requestHash).toBe(hash);
      return test.state === "new" ? { status: "new" } : test.state === "mismatch"
        ? { status: "mismatch", existingHash: "different", providedHash: hash }
        : { status: cached ? "cached" : test.state, request: record };
    });
    const response = await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
      method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "idempotency-key": key }, body: rawBody,
    }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
    const forbidden = test.grant && test.grantState !== "live";
    const expected = test.state === "mismatch" ? 422 : cached ? 200 : forbidden ? 403 : test.state === "pending" ? 409 : 200;
    expect(response.status).toBe(expected);
    if (cached) {
      expect(await response.json()).toEqual({ ok: record.ok, runId: RUN_ID, traceId: "original-trace", ...(record.ok ? {} : { error: "timeout" }) });
      expect(mocks.validateGrant).not.toHaveBeenCalled();
      expect(mocks.billingAccount).not.toHaveBeenCalled();
      expect(mocks.markRunCompleted).toHaveBeenCalledWith(expect.anything(), RUN_ID, record.ok ? "success" : "error", record.ok ? undefined : "Graph execution failed", record.ok ? undefined : "timeout");
    }
    if (cached || expected !== 200) {
      expect(mocks.runGraph).not.toHaveBeenCalled();
      expect(mocks.createPendingRequest).not.toHaveBeenCalled();
      expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
      expect(mocks.finalizeRequest).not.toHaveBeenCalled();
      expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
      if (!cached) expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    } else {
      expect(mocks.runGraph).toHaveBeenCalledOnce();
      expect(mocks.scopedRunKind).toBe(test.kind);
      expect(mocks.createPendingRequest).toHaveBeenCalledWith(key, hash, RUN_ID, expect.any(String), expect.any(String));
    }
  });

  it.each(["new", "pending", "stale", "success", "error"].flatMap((state) =>
    [false, true].map((humanMismatch) => ({ state, humanMismatch }))))(
    "binds persisted governance SYSTEM requester: $state / human mismatch $humanMismatch", async ({ state, humanMismatch }) => {
      const scheduledFor = "2026-01-01T00:00:00.000Z";
      const key = `schedule:${scheduledFor}`;
      // syncGovernanceSchedules owns the schedule as cogni_system;
      // schedule-control -> GraphRunWorkflow -> createGraphRunActivity forwards
      // that requester unchanged. Exercise the real creation route with it.
      let durable: Record<string, unknown> | null = null;
      mocks.getRunByRunId.mockImplementation(async () => durable);
      mocks.createRun.mockImplementation(async (_actor, facts) => {
        durable = { ...BASE_RUN, ...facts };
        return durable;
      });
      const facts = { runId: RUN_ID, graphId: "langgraph:default", runKind: "system_scheduled",
        triggerSource: "temporal_schedule", triggerRef: "schedule", requestedBy: COGNI_SYSTEM_PRINCIPAL_USER_ID,
        scheduledFor };
      expect((await create(facts)).status).toBe(200);
      expect(durable).toMatchObject({ ...facts, scheduledFor: new Date(scheduledFor) });
      const stored = { ...durable };
      mocks.createRun.mockClear();
      mocks.validateGrant.mockResolvedValue({ userId: COGNI_SYSTEM_PRINCIPAL_USER_ID, billingAccountId: BILLING_ID });
      const { actorUserId: _user, ...context } = BASE_INPUT;
      const body = { runId: RUN_ID, executionGrantId: GRANT_ID,
        input: { ...context, ...(humanMismatch ? { actorUserId: USER_ID } : {}) } };
      const rawBody = JSON.stringify(body);
      const hash = createHash("sha256").update("langgraph:default\n").update(rawBody).digest("hex");
      const cached = state === "success" || state === "error";
      const record = { runId: RUN_ID, requestHash: hash, traceId: "original-trace", ok: state === "success",
        errorCode: state === "error" ? "timeout" : null,
        leaseExpiresAt: state === "stale" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" };
      mocks.checkIdempotency.mockResolvedValue(state === "new" ? { status: "new" } : { status: cached ? "cached" : state, request: record });
      const response = await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
        method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "idempotency-key": key }, body: rawBody,
      }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
      expect(response.status).toBe(humanMismatch || state === "pending" ? 409 : 200);
      expect(durable).toEqual(stored);
      expect(mocks.createRun).not.toHaveBeenCalled();
      if (humanMismatch || state === "pending" || cached) {
        expect(mocks.runGraph).not.toHaveBeenCalled();
        expect(mocks.createPendingRequest).not.toHaveBeenCalled();
        expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
        expect(mocks.finalizeRequest).not.toHaveBeenCalled();
        expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
        if (humanMismatch || state === "pending") expect(mocks.markRunCompleted).not.toHaveBeenCalled();
      } else {
        expect(mocks.runGraph).toHaveBeenCalledOnce();
        expect(mocks.createPendingRequest).toHaveBeenCalledWith(key, hash, RUN_ID, expect.any(String), expect.any(String));
      }
      if (cached) {
        expect(mocks.validateGrant).not.toHaveBeenCalled();
        expect(mocks.billingAccount).not.toHaveBeenCalled();
        if (!humanMismatch) {
          expect(await response.json()).toEqual({ ok: record.ok, runId: RUN_ID, traceId: "original-trace", ...(record.ok ? {} : { error: "timeout" }) });
          expect(mocks.markRunCompleted).toHaveBeenCalledOnce();
        }
      }
    });

  it.each(["graphId", "requestedBy", "runKind", "triggerSource"])("refuses cached grant identity mismatch: %s", async (field) => {
    mocks.checkIdempotency.mockResolvedValue({ status: "cached", request: { runId: RUN_ID, ok: true } });
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github", [field]: "forged" });
    expect((await invoke({ runId: RUN_ID, executionGrantId: GRANT_ID, input: BASE_INPUT })).status).toBe(409);
    expect(mocks.validateGrant).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("refuses subjectless replay against a subjectful webhook ledger", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "cached", request: { runId: RUN_ID, ok: true } });
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github" });
    expect((await invoke({ runId: RUN_ID, input: { ...BASE_INPUT, actorUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID } })).status).toBe(409);
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
  });

  it("does not accept a supplied hash override for grant-backed replay", async () => {
    const storedHash = "a".repeat(64);
    mocks.checkIdempotency.mockImplementation(async (_key, hash) => hash === storedHash
      ? { status: "cached", request: { runId: RUN_ID, ok: true } }
      : { status: "mismatch", existingHash: storedHash, providedHash: hash });
    expect((await invoke({ runId: RUN_ID, executionGrantId: GRANT_ID,
      input: { ...BASE_INPUT, actorUserId: "forged", executionRequestHash: storedHash } })).status).toBe(422);
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("hands a bound unleased API facade preclaim to execution", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "pending", request: { runId: RUN_ID, ok: null, leaseExpiresAt: null } });
    expect((await invoke({ runId: RUN_ID, input: { ...BASE_INPUT, executionRequestHash: "a".repeat(64) } })).status).toBe(200);
    expect(mocks.heartbeatRequest).toHaveBeenCalled();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).toHaveBeenCalledOnce();
  });

  it("authenticates before reading or replaying a completed request", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "cached", request: { runId: RUN_ID, ok: true } });
    const response = await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
      method: "POST", headers: { authorization: "Bearer wrong", "idempotency-key": "api:test" },
      body: JSON.stringify({ runId: RUN_ID, input: BASE_INPUT }),
    }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
    expect(response.status).toBe(401);
    expect(mocks.checkIdempotency).not.toHaveBeenCalled();
    expect(mocks.getRunByRunId).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
  });

  it.each([true, false].flatMap((ok) => [USER_ID, COGNI_SYSTEM_PRINCIPAL_USER_ID].map((user) => ({ ok, user }))))(
    "replays a matching claim-race result: $ok / $user", async ({ ok, user }) => {
      mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github",
        requestedBy: user === COGNI_SYSTEM_PRINCIPAL_USER_ID ? null : user });
      mocks.createPendingRequest.mockResolvedValue({ status: "cached", request: { runId: RUN_ID, ok, traceId: "original", errorCode: ok ? null : "timeout" } });
      const response = await invoke({ runId: RUN_ID, input: { ...BASE_INPUT, actorUserId: user } });
      expect(await response.json()).toEqual({ ok, runId: RUN_ID, traceId: "original", ...(ok ? {} : { error: "timeout" }) });
      expect(response.status).toBe(200);
      expect(mocks.markRunCompleted).toHaveBeenCalledOnce();
      expect(mocks.runGraph).not.toHaveBeenCalled();
      expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
      expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    });

  it.each(["cogni", "work-prioritizer"])("marks only a validated schedule of %s unattended", async (graph) => {
    for (const scheduled of [false, true]) {
      mocks.runGraph.mockClear();
      mocks.getRunByRunId.mockResolvedValue(scheduled ? { ...BASE_RUN, runId: RUN_ID, runKind: "system_scheduled", triggerSource: "temporal_schedule", graphId: `langgraph:${graph}`, triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") } : { ...BASE_RUN, runKind: "user_immediate", graphId: `langgraph:${graph}` });
      await POST(new NextRequest(`http://localhost/api/internal/graphs/langgraph:${graph}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": scheduled ? "schedule:2026-01-01T00:00:00.000Z" : "api:test" },
        body: JSON.stringify({ executionGrantId: scheduled ? "40000000-0000-4000-a000-000000000001" : null, runId: RUN_ID, input: { messages: [{ role: "user", content: "decide" }], modelRef: { providerKey: "platform", modelId: "test-model" }, actorUserId: USER_ID, billingAccountId: BILLING_ID, virtualKeyId: VIRTUAL_KEY_ID } }),
      }), { params: Promise.resolve({ graphId: `langgraph:${graph}` }) });
      expect(mocks.runGraph).toHaveBeenCalledWith(expect.anything(), scheduled ? expect.objectContaining({ unattended: true }) : expect.not.objectContaining({ unattended: expect.anything() }));
      expect(mocks.scopedRunKind).toBe(scheduled ? "system_scheduled" : "user_immediate");
      expect(mocks.scopedSignal).toBeInstanceOf(AbortSignal);
      expect(mocks.scopedSignal?.aborted).toBe(false);
    }
  });

  it.each([
    { ...BASE_RUN, runId: RUN_ID, runKind: "system_webhook", triggerSource: "temporal_schedule", graphId: "langgraph:work-prioritizer", triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") },
    { ...BASE_RUN, runId: RUN_ID, runKind: "system_scheduled", triggerSource: "temporal_schedule", graphId: "langgraph:other", triggerRef: "schedule", scheduledFor: new Date("2026-01-01T00:00:00.000Z") },
    null,
    { ...BASE_RUN, runId: RUN_ID, runKind: null, graphId: "langgraph:work-prioritizer" },
    { ...BASE_RUN, runId: RUN_ID, runKind: "system_scheduled", triggerSource: "temporal_schedule", graphId: "langgraph:work-prioritizer", triggerRef: "wrong", scheduledFor: new Date("2026-01-01T00:00:00.000Z") },
  ])("refuses unverified run facts before mutation or execution", async (record) => {
    mocks.getRunByRunId.mockResolvedValue(record);
    const response = await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:work-prioritizer/runs", {
      method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": "schedule:2026-01-01T00:00:00.000Z" },
      body: JSON.stringify({ executionGrantId: "40000000-0000-4000-a000-000000000001", runId: RUN_ID, input: { messages: [{ role: "user", content: "decide" }], modelRef: { providerKey: "platform", modelId: "test-model" } } }),
    }), { params: Promise.resolve({ graphId: "langgraph:work-prioritizer" }) });
    expect(response.status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("executes a grant-backed webhook with its durable requester and never marks it unattended", async () => {
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github", triggerRef: "delivery-1" });
    expect((await invoke({ executionGrantId: GRANT_ID, runId: RUN_ID, input: BASE_INPUT })).status).toBe(200);
    expect(mocks.validateGrant).toHaveBeenCalledWith(expect.anything(), GRANT_ID, "langgraph:default");
    expect(mocks.scopedRunKind).toBe("system_webhook");
    expect(mocks.runGraph).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID }), expect.not.objectContaining({ unattended: expect.anything() }));
  });

  it("creates and reads canonical API facts before executing when runId is omitted", async () => {
    let durable: typeof BASE_RUN | null = null;
    mocks.getRunByRunId.mockImplementation(async () => durable);
    mocks.createRun.mockImplementation(async (_actor, facts) => {
      durable = { ...BASE_RUN, ...facts };
      return durable;
    });
    mocks.createPendingRequest.mockImplementationOnce(async (_key, _hash, runId) => ({ status: "claimed", request: { runId } }));
    const response = await invoke({ input: BASE_INPUT });
    expect(response.status).toBe(200);
    const facts = mocks.createRun.mock.calls[0]?.[1];
    expect(facts).toMatchObject({ graphId: "langgraph:default", runKind: "user_immediate", triggerSource: "api", triggerRef: "api:test", requestedBy: USER_ID });
    expect(facts.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.runGraph).toHaveBeenCalledWith(expect.objectContaining({ runId: facts.runId }), expect.anything());
    expect(mocks.createPendingRequest.mock.invocationCallOrder[0]).toBeLessThan(mocks.createRun.mock.invocationCallOrder[0] as number);
    expect(mocks.createRun.mock.invocationCallOrder[0]).toBeLessThan(mocks.runGraph.mock.invocationCallOrder[0] as number);
  });

  it.each([undefined, {}, { providerKey: "platform" }])("validates optional-run model before any insertion: %s", async (modelRef) => {
    const response = await invoke({ input: { ...BASE_INPUT, modelRef } });
    expect(response.status).toBe(400);
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each(["pending", "mismatch", "cached"])("creates no optional-run orphan when losing the claim: %s", async (status) => {
    mocks.getRunByRunId.mockImplementation(async (_actor, runId) => runId === RUN_ID ? { ...BASE_RUN } : null);
    mocks.createPendingRequest.mockResolvedValueOnce({ status, request: { runId: RUN_ID, ok: true, traceId: "original" } });
    const response = await invoke({ input: BASE_INPUT });
    expect(response.status).toBe(status === "pending" ? 409 : status === "mismatch" ? 422 : 200);
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("creates the canonical claimed run after a crash before optional-run insertion", async () => {
    let durable: typeof BASE_RUN | null = null;
    mocks.checkIdempotency.mockResolvedValue({ status: "stale", request: { runId: RUN_ID } });
    mocks.getRunByRunId.mockImplementation(async () => durable);
    mocks.createRun.mockImplementation(async (_actor, facts) => { durable = { ...BASE_RUN, ...facts }; return durable; });
    expect((await invoke({ input: BASE_INPUT })).status).toBe(200);
    expect(mocks.createRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ runId: RUN_ID }));
    expect(mocks.runGraph).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID }), expect.anything());
  });

  it("finalizes optional-run insertion when executor setup throws", async () => {
    let durable: typeof BASE_RUN | null = null;
    mocks.getRunByRunId.mockImplementation(async () => durable);
    mocks.createPendingRequest.mockImplementationOnce(async (_key, _hash, runId) => ({ status: "claimed", request: { runId } }));
    mocks.createRun.mockImplementation(async (_actor, facts) => { durable = { ...BASE_RUN, ...facts }; return durable; });
    mocks.setupFailure = true;
    const response = await invoke({ input: BASE_INPUT });
    expect(await response.json()).toMatchObject({ ok: false, error: "internal" });
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("api:test", { ok: false, errorCode: "internal" });
    expect(mocks.markRunCompleted).toHaveBeenCalledWith(expect.anything(), expect.any(String), "error", "Graph execution failed", "internal");
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("leaves a failed optional-run insert reclaimable instead of caching a result without a ledger", async () => {
    mocks.getRunByRunId.mockResolvedValue(null);
    mocks.createRun.mockRejectedValueOnce(new Error("insert rolled back"));
    expect((await invoke({ input: BASE_INPUT })).status).toBe(503);
    expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("reconciles a committed optional-run insert after losing its commit response", async () => {
    let durable: typeof BASE_RUN | null = null;
    mocks.getRunByRunId.mockImplementation(async () => durable);
    mocks.createRun.mockImplementationOnce(async (_actor, facts) => {
      durable = { ...BASE_RUN, ...facts };
      throw new Error("commit response lost");
    });
    expect(await (await invoke({ input: BASE_INPUT })).json()).toMatchObject({ ok: false, error: "internal" });
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("api:test", { ok: false, errorCode: "internal" });
    expect(mocks.markRunCompleted).toHaveBeenCalledWith(expect.anything(), RUN_ID, "error", "Graph execution failed", "internal");
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("retains known success if ledger reconciliation fails after finalization", async () => {
    await mocks.publish.withImplementation(async () => undefined, async () => {
      mocks.markRunCompleted.mockRejectedValueOnce(new Error("transient ledger outage"));
      expect(await (await invoke()).json()).toMatchObject({ ok: true, runId: RUN_ID });
      expect(mocks.finalizeRequest.mock.calls.every((call) => call[1].ok === true)).toBe(true);
      expect(mocks.markRunCompleted.mock.calls.every((call) => call[2] === "success")).toBe(true);
    });
  });

  it("keeps omitted-run retries bound to their existing durable row", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "cached", request: { runId: RUN_ID, ok: true, traceId: null } });
    const response = await invoke({ input: BASE_INPUT });
    expect(await response.json()).toMatchObject({ ok: true, runId: RUN_ID });
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("returns definitive 422 conflicts before ledger reads or grant validation", async () => {
    mocks.checkIdempotency.mockResolvedValue({ status: "mismatch", existingHash: "old", providedHash: "new" });
    mocks.getRunByRunId.mockResolvedValue(null);
    expect((await invoke({ executionGrantId: GRANT_ID, runId: OTHER_RUN_ID, input: BASE_INPUT })).status).toBe(422);
    expect(mocks.getRunByRunId).not.toHaveBeenCalled();
    expect(mocks.validateGrant).not.toHaveBeenCalled();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
  });

  it.each(["new", "cached", "stale", "pending"])("refuses a different durable requester on %s", async (status) => {
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, requestedBy: "someone-else" });
    mocks.checkIdempotency.mockResolvedValue({ status, request: { runId: RUN_ID, ok: true } });
    expect((await invoke()).status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("binds a webhook requester to the validated grant owner, regardless of payload claims", async () => {
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github" });
    mocks.validateGrant.mockResolvedValue({ userId: "another-owner", billingAccountId: BILLING_ID });
    expect((await invoke({ executionGrantId: GRANT_ID, runId: RUN_ID, input: BASE_INPUT })).status).toBe(409);
    expect(mocks.validateGrant).toHaveBeenCalledOnce();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each(["cached", "pending", "stale"])("refuses explicitly conflicting runId on %s", async (status) => {
    mocks.checkIdempotency.mockResolvedValue({ status, request: { runId: OTHER_RUN_ID, ok: true } });
    expect((await invoke()).status).toBe(409);
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("checks the winning cached run after an atomic claim race", async () => {
    mocks.createPendingRequest.mockResolvedValue({ status: "cached", request: { runId: OTHER_RUN_ID, ok: true } });
    expect((await invoke()).status).toBe(409);
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("does not manufacture a run kind from a grant when no runId is given", async () => {
    mocks.getRunByRunId.mockResolvedValue(null);
    expect((await invoke({ executionGrantId: GRANT_ID, input: BASE_INPUT })).status).toBe(409);
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each(["runId", "graphId", "runKind", "requestedBy", "triggerSource", "triggerRef", "scheduleId", "scheduledFor"])("refuses idempotent create with conflicting %s", async (field) => {
    const different = field === "scheduledFor" ? new Date("2026-01-01") : field === "runId" ? OTHER_RUN_ID : "other";
    mocks.createRun.mockResolvedValue({ ...BASE_RUN, [field]: different });
    expect((await create({ runId: RUN_ID, graphId: BASE_RUN.graphId, runKind: BASE_RUN.runKind, triggerSource: BASE_RUN.triggerSource, triggerRef: BASE_RUN.triggerRef, requestedBy: USER_ID })).status).toBe(409);
  });

  it("accepts an exact idempotent create even after stateKey has been patched", async () => {
    mocks.createRun.mockResolvedValue({ ...BASE_RUN, stateKey: "host-derived-thread" });
    expect((await create({ runId: RUN_ID, graphId: BASE_RUN.graphId, runKind: BASE_RUN.runKind, triggerSource: BASE_RUN.triggerSource, triggerRef: BASE_RUN.triggerRef, requestedBy: USER_ID })).status).toBe(200);
  });

  it("refuses a different canonical identity returned by scheduled-slot creation", async () => {
    mocks.createRun.mockResolvedValue({ ...BASE_RUN, runId: OTHER_RUN_ID });
    expect((await create({ runId: RUN_ID })).status).toBe(409);
  });

  it("returns cancellation advice without invoking item writers for retired DELETE", async () => {
    const { getWorkItem, patchWorkItem } = await import("@/app/_facades/work/items.server");
    const response = await deleteItem(new NextRequest("http://localhost/api/v1/work/items/task.1", { method: "DELETE" }), { params: Promise.resolve({ id: "task.1" }) });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: "work_item_deletion_retired", message: expect.stringContaining("status=cancelled") });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(patchWorkItem).not.toHaveBeenCalled();
  });

  it("aborts cooperative execution at the host deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.runGraph.mockImplementationOnce(() => {
        const final = new Promise<{ ok: false; error: "timeout"; requestId: string }>((resolve) => {
          mocks.scopedSignal?.addEventListener("abort", () => resolve({ ok: false, error: "timeout", requestId: RUN_ID }), { once: true });
        });
        return {
          stream: (async function* () { await final; yield { type: "error" as const, error: "timeout" as const }; })(),
          final,
        };
      });
      const pending = POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
        method: "POST",
        headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": "api:deadline" },
        body: JSON.stringify({ executionGrantId: null, runId: RUN_ID, input: {
          messages: [{ role: "user", content: "hello" }], modelRef: { providerKey: "platform", modelId: "test-model" },
          actorUserId: USER_ID, billingAccountId: BILLING_ID, virtualKeyId: VIRTUAL_KEY_ID,
        } }),
      }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
      await vi.waitFor(() => expect(mocks.scopedSignal).toBeDefined());
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(mocks.scopedSignal?.reason).toMatchObject({ name: "AiExecutionError", code: "timeout" });
      expect(await (await pending).json()).toMatchObject({ ok: false, error: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a host deadline and clears its timer after execution", async () => {
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    try {
      await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
        method: "POST",
        headers: { authorization: "Bearer scheduler-secret-value-1234567890", "content-type": "application/json", "idempotency-key": "api:timer" },
        body: JSON.stringify({ executionGrantId: null, runId: RUN_ID, input: {
          messages: [{ role: "user", content: "hello" }], modelRef: { providerKey: "platform", modelId: "test-model" },
          actorUserId: USER_ID, billingAccountId: BILLING_ID, virtualKeyId: VIRTUAL_KEY_ID,
        } }),
      }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
      const index = setTimer.mock.calls.findIndex((args) => args[1] === 15 * 60_000);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
      expect(mocks.scopedSignal?.aborted).toBe(false);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  it("finalizes failure when durable done publication rejects", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
            },
          }),
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      runId: RUN_ID,
      error: "internal",
    });
    expect(mocks.saveThread).toHaveBeenCalledOnce();
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("ai:scoped-key", {
      ok: false,
      errorCode: "internal",
    });
  });

  it("rejects a matching live pending run without executing it", async () => {
    const requestHash = "a".repeat(64);
    mocks.checkIdempotency.mockResolvedValue({
      status: "pending",
      request: {
        idempotencyKey: "ai:scoped-key",
        requestHash,
        runId: RUN_ID,
        traceId: null,
        ok: null,
        errorCode: null,
        createdAt: new Date(),
      },
    });

    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-secret-value-1234567890",
            "content-type": "application/json",
            "idempotency-key": "ai:scoped-key",
          },
          body: JSON.stringify({
            executionGrantId: null,
            runId: RUN_ID,
            input: {
              messages: [{ role: "user", content: "hello" }],
              modelRef: { providerKey: "platform", modelId: "test-model" },
              actorUserId: USER_ID,
              billingAccountId: BILLING_ID,
              virtualKeyId: VIRTUAL_KEY_ID,
              stateKey: "thread-1",
              executionRequestHash: requestHash,
            },
          }),
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );

    expect(response.status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });
});

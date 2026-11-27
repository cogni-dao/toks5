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
import { toUserId } from "@cogni/ids";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN_ID = "a0000000-0000-4000-a000-000000000001";
const USER_ID = "10000000-0000-4000-a000-000000000001";
const BILLING_ID = "20000000-0000-4000-a000-000000000001";
const VIRTUAL_KEY_ID = "30000000-0000-4000-a000-000000000001";

const mocks = vi.hoisted(() => ({
  listRunsByUser: vi.fn(),
  workflowStart: vi.fn().mockResolvedValue(undefined),
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
  markRunStarted: vi.fn().mockResolvedValue(undefined),
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
  serverEnv: () => ({ SCHEDULER_API_TOKEN: "scheduler-secret-value-1234567890", AUTH_SECRET: "test-secret-at-least-thirty-two-characters" }),
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

vi.mock("@/shared/config", () => ({ getNodeId: () => "toks5" }));
vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: async () => ({ id: BILLING_ID, defaultVirtualKeyId: VIRTUAL_KEY_ID }),
}));
vi.mock("@/bootstrap/container", () => ({
  getTemporalWorkflowClient: async () => ({ client: { start: mocks.workflowStart }, taskQueue: "test" }),
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getContainer: () => ({
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      heartbeatRequest: mocks.heartbeatRequest,
      finalizeRequest: mocks.finalizeRequest,
    },
    graphRunRepository: {
      listRunsByUser: mocks.listRunsByUser,
      markRunStarted: mocks.markRunStarted,
      markRunCompleted: mocks.markRunCompleted,
      patchRunStateKey: mocks.patchRunStateKey,
      getRunByRunId: mocks.getRunByRunId,
      createRun: mocks.createRun,
    },
    agentAuthority: { payerFor: async () => null },
    log: { info: vi.fn() },
    accountsForUser: () => ({}),
    executionGrantWorkerPort: { validateGrantForGraph: mocks.validateGrant },
    serviceAccountService: { getBillingAccountById: mocks.billingAccount },
    providerResolver: {},
    connectionBroker: undefined,
    runStream: {
      subscribe: async function* () { yield { event: { type: "done" } }; },
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

import { GET as listRuns } from "@/app/api/v1/ai/runs/route";
import { completionStream } from "@/app/_facades/ai/completion.server";
import { makeNoopLogger } from "@/shared/observability";
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
    mocks.finalizeRequest.mockReset().mockResolvedValue(undefined);
    mocks.publish.mockReset().mockImplementation(async (_runId: string, event: { type: string }) => {
      if (event.type === "done") throw new Error("redis unavailable");
    });
    mocks.setupFailure = false;
    mocks.scopedSignal = undefined;
    mocks.scopedRunKind = undefined;
    mocks.checkIdempotency.mockReset().mockResolvedValue({ status: "new" });
    mocks.billingAccount.mockReset().mockResolvedValue({ defaultVirtualKeyId: VIRTUAL_KEY_ID });
    mocks.getRunByRunId.mockReset().mockResolvedValue({ ...BASE_RUN });
    mocks.createRun.mockReset().mockImplementation(async (_actor, facts) => ({ ...BASE_RUN, ...facts }));
    mocks.validateGrant.mockReset().mockResolvedValue({ userId: USER_ID, billingAccountId: BILLING_ID });
    mocks.createPendingRequest.mockReset().mockResolvedValue({ status: "claimed", request: { runId: RUN_ID } });
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
      expect(mocks.markRunStarted).not.toHaveBeenCalled();
      expect(mocks.runGraph).not.toHaveBeenCalled();
      expect(mocks.createPendingRequest).not.toHaveBeenCalled();
      expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
      expect(mocks.finalizeRequest).not.toHaveBeenCalled();
      expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
      if (!cached) expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    } else {
      expect(mocks.markRunStarted).toHaveBeenCalledWith(expect.anything(), RUN_ID, expect.any(String));
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
      const storedBody = JSON.stringify({ runId: RUN_ID, executionGrantId: GRANT_ID, input: context });
      const hash = createHash("sha256").update("langgraph:default\n").update(storedBody).digest("hex");
      const cached = state === "success" || state === "error";
      const record = { runId: RUN_ID, requestHash: hash, traceId: "original-trace", ok: state === "success",
        errorCode: state === "error" ? "timeout" : null,
        leaseExpiresAt: state === "stale" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" };
      mocks.checkIdempotency.mockImplementation(async (_key, requestHash) => cached && requestHash !== hash
        ? { status: "mismatch", existingHash: hash, providedHash: requestHash }
        : state === "new" ? { status: "new" } : { status: cached ? "cached" : state, request: record });
      const response = await POST(new NextRequest("http://localhost/api/internal/graphs/langgraph:default/runs", {
        method: "POST", headers: { authorization: "Bearer scheduler-secret-value-1234567890", "idempotency-key": key }, body: rawBody,
      }), { params: Promise.resolve({ graphId: "langgraph:default" }) });
      expect(response.status).toBe(cached && humanMismatch ? 422 : humanMismatch || state === "pending" ? 409 : 200);
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

  it.each(["graphId", "requestedBy", "runKind", "triggerSource"])("refuses fresh grant identity mismatch: %s", async (field) => {
    mocks.getRunByRunId.mockResolvedValue({ ...BASE_RUN, runKind: "system_webhook", triggerSource: "webhook:github", [field]: "forged" });
    expect((await invoke({ runId: RUN_ID, executionGrantId: GRANT_ID, input: BASE_INPUT })).status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it("refuses fresh subjectless admission against a subjectful webhook ledger", async () => {
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
    expect(mocks.createPendingRequest).toHaveBeenCalledWith("api:test", "a".repeat(64), RUN_ID, expect.any(String), expect.any(String));
    expect(mocks.runGraph).toHaveBeenCalledOnce();
  });

  it.each([
    true,
    false,
  ])("finalizes the actual completion facade reservation through worker handoff: %s", async (success) => {
    type Claim = {
      runId: string;
      requestHash: string;
      ok: boolean | null;
      leaseExpiresAt: string | null;
      traceId: string | null;
      errorCode?: string;
    };
    const claims = new Map<string, Claim>();
    mocks.checkIdempotency.mockImplementation(
      async (key: string, hash: string) => {
        const request = claims.get(key);
        return !request
          ? { status: "new" }
          : request.requestHash !== hash
            ? {
                status: "mismatch",
                existingHash: request.requestHash,
                providedHash: hash,
              }
            : { status: request.ok !== null ? "cached" : "pending", request };
      }
    );
    mocks.createPendingRequest.mockImplementation(
      async (
        key: string,
        hash: string,
        runId: string,
        traceId: string,
        lease?: string
      ) => {
        const claim = claims.get(key);
        if (claim?.leaseExpiresAt) return { status: "pending", request: claim };
        const request = {
          runId,
          requestHash: hash,
          traceId,
          ok: null,
          leaseExpiresAt: lease ?? null,
        };
        claims.set(key, request);
        return { status: "claimed", request };
      }
    );
    mocks.finalizeRequest.mockImplementation(
      async (key: string, outcome: { ok: boolean }) => {
        const claim = claims.get(key);
        if (!claim) throw new Error("Finalizing an unreserved claim");
        Object.assign(claim, outcome);
      }
    );
    mocks.publish.mockResolvedValue(undefined);
    const completion = await completionStream(
      {
        messages: BASE_INPUT.messages as [{ role: "user"; content: string }],
        modelRef: BASE_INPUT.modelRef,
        sessionUser: {
          id: toUserId(USER_ID),
          walletAddress: null,
          displayName: null,
          avatarColor: null,
        },
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      {
        reqId: "facade-request",
        traceId: "trace",
        routeId: "test",
        log: makeNoopLogger(),
        clock: { now: () => new Date().toISOString() },
      }
    );
    // Consume the actual facade's subscription so it cleans up.
    for await (const _event of completion.stream) {
      /* fixture stream */
    }
    const workflow = mocks.workflowStart.mock.calls.at(-1)?.[1].args[0];
    expect(workflow.runId).toBe(completion.runId);
    // Canonical GraphRunWorkflow creates these facts before executeGraphActivity.
    const creation = await create({
      runId: workflow.runId,
      graphId: workflow.graphId,
      runKind: workflow.runKind,
      triggerSource: workflow.triggerSource,
      triggerRef: workflow.triggerRef,
      requestedBy: workflow.requestedBy,
    });
    expect(creation.status).toBe(200);
    mocks.getRunByRunId.mockResolvedValue({
      ...BASE_RUN,
      runId: workflow.runId,
      triggerRef: workflow.triggerRef,
    });
    if (!success) mocks.setupFailure = true;
    const callback = () =>
      POST(
        new NextRequest(
          "http://localhost/api/internal/graphs/langgraph:default/runs",
          {
            method: "POST",
            headers: {
              authorization: "Bearer scheduler-secret-value-1234567890",
              "idempotency-key": `api:${workflow.runId}`,
            },
            body: JSON.stringify({
              executionGrantId: workflow.executionGrantId,
              input: workflow.input,
              runId: workflow.runId,
            }),
          }
        ),
        { params: Promise.resolve({ graphId: "langgraph:default" }) }
      );
    const responses = await Promise.all([callback(), callback()]);
    expect(
      responses.every(
        (response) => response.status === 200 || response.status === 409
      )
    ).toBe(true);
    const response = responses.find((result) => result.status === 200);
    expect(response).toBeDefined();
    expect(claims.size).toBe(1);
    expect(workflow.triggerRef).toMatch(/^ai:[0-9a-f]{64}$/);
    expect(claims.get(workflow.triggerRef)).toMatchObject({
      runId: workflow.runId,
      ok: success,
    });
    expect(claims.has(`api:${workflow.runId}`)).toBe(false);
    expect([...claims.values()].every((claim) => claim.ok !== null)).toBe(true);
    expect(mocks.finalizeRequest).toHaveBeenCalledWith(
      workflow.triggerRef,
      expect.objectContaining({ ok: success })
    );
    const replay = await callback();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await response.json());
    expect(claims.size).toBe(1);
    expect(mocks.runGraph).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(mocks.finalizeRequest).toHaveBeenCalledOnce();
  });

  const historicalReplays = [
    "optional API without graph row",
    "API duplicate lost-response inserts",
    "facade duplicate lost-response inserts",
    "migrated schedule without identity",
    "completed claim with pending ledger",
    "completed claim with running ledger",
  ];
  it.each(
    historicalReplays.flatMap((producer) =>
      [true, false].map((ok) => ({ producer, ok }))
    )
  )("returns historical terminal receipt without reexecution: $producer / $ok", async ({
    producer,
    ok,
  }) => {
    const scheduled = producer.startsWith("migrated");
    const optional = producer.startsWith("optional");
    const facade = producer.startsWith("facade");
    const key = scheduled
      ? "schedule:2026-01-01T00:00:00.000Z"
      : optional
        ? "api:test"
        : `api:${RUN_ID}`;
    const input = scheduled
      ? { messages: BASE_INPUT.messages, modelRef: BASE_INPUT.modelRef }
      : {
          ...BASE_INPUT,
          ...(facade ? { executionRequestHash: "a".repeat(64) } : {}),
        };
    const body = {
      ...(optional ? {} : { runId: RUN_ID }),
      executionGrantId: scheduled ? GRANT_ID : null,
      input,
    };
    const rawBody = JSON.stringify(body);
    const requestHash = facade
      ? "a".repeat(64)
      : createHash("sha256")
          .update("langgraph:default\n")
          .update(rawBody)
          .digest("hex");
    // These are the records the old producers left: the base optional-run
    // route finalized execution_requests without creating graph_runs; the
    // base non-scheduled createRun did a plain INSERT on every HTTP retry;
    // migration 0021 added the scheduled identity columns with no backfill.
    const request = {
      idempotencyKey: key,
      requestHash,
      runId: RUN_ID,
      ok,
      traceId: "historical-trace",
      errorCode: ok ? null : "timeout",
      leaseExpiresAt: null,
    };
    mocks.checkIdempotency.mockImplementation(async (callerKey, hash) =>
      callerKey !== key
        ? { status: "new" }
        : hash === requestHash
          ? { status: "cached", request }
          : {
              status: "mismatch",
              existingHash: requestHash,
              providedHash: hash,
            }
    );
    if (producer.includes("duplicate")) {
      mocks.getRunByRunId.mockRejectedValue(
        new Error("Ambiguous historical graph run identity")
      );
    } else {
      mocks.getRunByRunId.mockResolvedValue(
        optional
          ? null
          : scheduled
            ? {
                ...BASE_RUN,
                graphId: null,
                runKind: null,
                triggerSource: null,
                triggerRef: null,
                requestedBy: null,
              }
            : {
                ...BASE_RUN,
                status: producer.includes("pending") ? "pending" : "running",
              }
      );
    }
    const revoked = new Error("Grant revoked");
    revoked.name = "GrantRevokedError";
    mocks.validateGrant.mockRejectedValue(revoked);
    const replay = (bytes = rawBody, graphId = "langgraph:default") =>
      POST(
        new NextRequest(
          `http://localhost/api/internal/graphs/${graphId}/runs`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer scheduler-secret-value-1234567890",
              "idempotency-key": key,
            },
            body: bytes,
          }
        ),
        { params: Promise.resolve({ graphId }) }
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await replay();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok,
        runId: RUN_ID,
        traceId: "historical-trace",
        ...(ok ? {} : { error: "timeout" }),
      });
    }
    expect(mocks.getRunByRunId).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      ok ? "success" : "error",
      ok ? undefined : "Graph execution failed",
      ok ? undefined : "timeout"
    );
    if (!facade) {
      // Exact bytes AND graph path are bound, including grant and requester.
      expect(
        (
          await replay(
            JSON.stringify({
              ...body,
              input: { ...input, actorUserId: OTHER_RUN_ID },
            })
          )
        ).status
      ).toBe(422);
      expect((await replay(rawBody, "langgraph:other")).status).toBe(422);
      expect((await replay(`${rawBody} `)).status).toBe(422);
    } else {
      expect(
        (await replay(JSON.stringify({ ...body, runId: OTHER_RUN_ID }))).status
      ).toBe(409);
      expect(
        (
          await replay(
            JSON.stringify({
              ...body,
              input: { ...input, executionRequestHash: "b".repeat(64) },
            })
          )
        ).status
      ).toBe(422);
    }
    expect(mocks.validateGrant).not.toHaveBeenCalled();
    expect(mocks.billingAccount).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunStarted).not.toHaveBeenCalled();
    expect(mocks.patchRunStateKey).not.toHaveBeenCalled();
    expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each(
    ["pending", "stale"].flatMap((state) =>
      [false, true].map((unleased) => ({ state, unleased }))
    )
  )("never uses terminal compatibility for incomplete historical claims: $state / $unleased", async ({
    state,
    unleased,
  }) => {
    mocks.checkIdempotency.mockResolvedValue({
      status: state,
      request: {
        runId: RUN_ID,
        ok: null,
        leaseExpiresAt: unleased ? null : "2020-01-01T00:00:00.000Z",
      },
    });
    mocks.getRunByRunId.mockResolvedValue(null);
    const response = await invoke({
      runId: RUN_ID,
      input: {
        ...BASE_INPUT,
        ...(unleased ? { executionRequestHash: "a".repeat(64) } : {}),
      },
    });
    expect(response.status).toBe(409);
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.markRunStarted).not.toHaveBeenCalled();
    expect(mocks.markRunCompleted).not.toHaveBeenCalled();
    expect(mocks.heartbeatRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeRequest).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each([null, new Date("2026-11-27T12:00:00.123Z")])("emits and accepts composite history cursors for %s", async (startedAt) => {
    const row = { ...BASE_RUN, id: RUN_ID, startedAt, completedAt: null, status: "pending", errorCode: null, errorMessage: null };
    mocks.listRunsByUser.mockResolvedValue([row, { ...row, id: OTHER_RUN_ID }]);
    const first = await listRuns(new NextRequest("http://localhost/api/v1/ai/runs?limit=1"));
    expect(first.status).toBe(200);
    const body = await first.json();
    const cursor = `v1|${startedAt?.toISOString() ?? "null"}|${RUN_ID}`;
    expect(body.nextCursor).toBe(cursor);
    mocks.listRunsByUser.mockResolvedValue([]);
    expect((await listRuns(new NextRequest(`http://localhost/api/v1/ai/runs?limit=1&cursor=${encodeURIComponent(cursor)}`))).status).toBe(200);
    expect(mocks.listRunsByUser).toHaveBeenLastCalledWith(expect.anything(), USER_ID, { limit: 1, cursor });
    expect((await listRuns(new NextRequest("http://localhost/api/v1/ai/runs?cursor=invalid"))).status).toBe(400);
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
    expect(mocks.createRun.mock.invocationCallOrder[0]).toBeLessThan(mocks.markRunStarted.mock.invocationCallOrder[0] as number);
    expect(mocks.markRunStarted.mock.invocationCallOrder[0]).toBeLessThan(mocks.runGraph.mock.invocationCallOrder[0] as number);
  });

  it("retains system ownership for optional API history", async () => {
    mocks.getRunByRunId.mockResolvedValue(null);
    mocks.publish.mockResolvedValue(undefined);
    expect((await invoke({ input: { ...BASE_INPUT, actorUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID } })).status).toBe(200);
    expect(mocks.createRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedBy: COGNI_SYSTEM_PRINCIPAL_USER_ID }));
  });

  it.each([undefined, {}, { providerKey: "platform" }])("validates optional-run model before any insertion: %s", async (modelRef) => {
    const response = await invoke({ input: { ...BASE_INPUT, modelRef } });
    expect(response.status).toBe(400);
    expect(mocks.createRun).not.toHaveBeenCalled();
    expect(mocks.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.markRunStarted).not.toHaveBeenCalled();
    expect(mocks.runGraph).not.toHaveBeenCalled();
  });

  it.each(["pending", "mismatch", "cached"])("creates no optional-run orphan when losing the claim: %s", async (status) => {
    mocks.getRunByRunId.mockResolvedValue(null);
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

  it("reconciles a start transition failure without executing", async () => {
    mocks.markRunStarted.mockRejectedValueOnce(new Error("start failed"));
    const response = await invoke();
    expect(await response.json()).toMatchObject({ ok: false, error: "internal" });
    expect(mocks.finalizeRequest).toHaveBeenCalledWith("api:test", { ok: false, errorCode: "internal" });
    expect(mocks.markRunCompleted).toHaveBeenCalledWith(expect.anything(), RUN_ID, "error", "Graph execution failed", "internal");
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

  it.each(["new", "stale", "pending"])("refuses a different durable requester on fresh or incomplete %s", async (status) => {
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

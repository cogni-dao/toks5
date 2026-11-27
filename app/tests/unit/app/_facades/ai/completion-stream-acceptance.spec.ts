// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/ai/completion-stream-acceptance`
 * Purpose: Prove durable acceptance and caller-claim convergence at worker admission.
 * Scope: Completion facade and internal admission with mocked persistence and execution ports.
 * Invariants: One caller claim is finalized; replay never reexecutes; conflicts precede Temporal/Redis.
 * Side-effects: none
 * @internal
 */

import { createHash, createHmac } from "node:crypto";
import type { RunStreamPort } from "@cogni/graph-execution-core";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { TEST_SESSION_USER_1 } from "@tests/_fakes";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNoopLogger, type RequestContext } from "@/shared/observability";

const mocks = vi.hoisted(() => {
  const claims = new Map<
    string,
    {
      requestHash: string;
      runId: string;
      leaseExpiresAt: string | null;
      ok?: boolean;
      errorCode?: string | null;
    }
  >();
  const runs = new Map<
    string,
    {
      runId: string;
      graphId: string;
      runKind: string;
      triggerSource: string;
      triggerRef: string | null;
      requestedBy: string;
    }
  >();
  return {
    deployEnvironment: "production",
    localInproc: undefined as "true" | "false" | undefined,
    claims,
    runs,
    executions: 0,
    executionOk: true,
    getRunByRunId: vi.fn(
      async (_actor: unknown, runId: string) => runs.get(runId) ?? null
    ),
    finalizeRequest: vi.fn(
      async (
        key: string,
        outcome: { ok: boolean; errorCode: string | null }
      ) => {
        const claim = claims.get(key);
        if (!claim) throw new Error("Missing claim");
        Object.assign(claim, outcome);
      }
    ),
    workflowStart: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn<RunStreamPort["subscribe"]>(() =>
      (async function* () {
        await new Promise<never>(() => undefined);
      })()
    ),
    checkIdempotency: vi.fn(async (key: string, requestHash: string) => {
      const existing = claims.get(key);
      if (!existing) return { status: "new" as const };
      if (existing.requestHash !== requestHash) {
        return {
          status: "mismatch" as const,
          existingHash: existing.requestHash,
          providedHash: requestHash,
        };
      }
      return {
        status:
          existing.ok === undefined
            ? ("pending" as const)
            : ("cached" as const),
        request: { ...existing, idempotencyKey: key },
      };
    }),
    createPendingRequest: vi.fn(
      async (
        key: string,
        requestHash: string,
        runId: string,
        _traceId: string | null,
        leaseExpiresAt?: string
      ) => {
        const existing = claims.get(key);
        if (existing) {
          if (
            leaseExpiresAt &&
            existing.leaseExpiresAt === null &&
            existing.ok === undefined &&
            existing.requestHash === requestHash
          ) {
            existing.leaseExpiresAt = leaseExpiresAt;
            return { status: "claimed", request: existing };
          }
          throw new Error("duplicate claim");
        }
        const claim = {
          requestHash,
          runId,
          leaseExpiresAt: leaseExpiresAt ?? null,
        };
        claims.set(key, claim);
        return { status: "claimed", request: claim };
      }
    ),
  };
});

vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: () => ({ accountService: {} }),
  getTemporalWorkflowClient: async () => ({
    client: { start: mocks.workflowStart },
    taskQueue: "scheduler-tasks",
  }),
  getContainer: () => ({
    runStream: {
      subscribe: mocks.subscribe,
      publish: vi.fn(),
      expire: vi.fn(),
    },
    agentAuthority: { payerFor: async () => null },
    serviceAccountService: { getBillingAccountById: async () => null },
    log: { info: () => undefined },
    graphRunRepository: {
      getRunByRunId: mocks.getRunByRunId,
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
    },
    accountsForUser: () => ({}),
    providerResolver: {},
    executionRequestPort: {
      checkIdempotency: mocks.checkIdempotency,
      createPendingRequest: mocks.createPendingRequest,
      finalizeRequest: mocks.finalizeRequest,
      heartbeatRequest: vi.fn(),
    },
  }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "billing-1",
    defaultVirtualKeyId: "vk-1",
  }),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => "node-template" }));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    AUTH_SECRET: "stable-completion-idempotency-secret",
    SCHEDULER_API_TOKEN: "scheduler-test-secret",
    DEPLOY_ENVIRONMENT: mocks.deployEnvironment,
    COGNI_LOCAL_INPROC: mocks.localInproc,
  }),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_options: unknown, handler: (...args: unknown[]) => unknown) =>
    (request: NextRequest, context: unknown) =>
      handler(ctx, request, undefined, context),
}));
vi.mock("@/bootstrap/graph-executor.factory", () => ({
  createGraphExecutor: () => ({}),
  createScopedGraphExecutor: () => ({
    runGraph: () => {
      mocks.executions++;
      return {
        stream: (async function* () {
          yield { type: "done" };
        })(),
        final: Promise.resolve({
          ok: mocks.executionOk,
          error: mocks.executionOk ? undefined : "internal",
          usage: { promptTokens: 0, completionTokens: 0 },
        }),
      };
    },
  }),
}));
vi.mock("@/features/ai/public.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/ai/public.server")>()),
  executeStream: vi.fn(),
}));
vi.mock("@/features/ai/services/billing", () => ({ commitUsageFact: vi.fn() }));
vi.mock("@/features/ai/services/preflight-credit-check", () => ({
  preflightCreditCheck: vi.fn(),
}));

const ctx: RequestContext = {
  log: makeNoopLogger(),
  reqId: "request-1",
  traceId: "00000000000000000000000000000000",
  routeId: "ai.chat",
  clock: { now: () => "2025-01-01T00:00:00.000Z" },
};

describe("completionStream durable acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deployEnvironment = "production";
    mocks.localInproc = undefined;
    mocks.executions = 0;
    mocks.executionOk = true;
  });
  afterEach(() => {
    vi.useRealTimers();
    mocks.claims.clear();
    mocks.runs.clear();
  });

  it("reuses an exact durable idempotency claim without storing a raw prompt hash", async () => {
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const input = {
      messages: [{ role: "user" as const, content: "hello" }],
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "caller-key",
      acceptanceMode: "workflow-start" as const,
    };

    await completionStream(input, ctx);
    const alreadyStarted = new Error("already started");
    Object.setPrototypeOf(
      alreadyStarted,
      WorkflowExecutionAlreadyStartedError.prototype
    );
    mocks.workflowStart.mockRejectedValueOnce(alreadyStarted);
    await completionStream(input, ctx);

    expect(mocks.claims.size).toBe(1);
    const persistedHash = [...mocks.claims.values()][0]?.requestHash;
    expect(persistedHash).not.toBe(
      createHash("sha256").update("hello", "utf8").digest("hex")
    );
    const canonicalRequest = JSON.stringify({
      graphId: "langgraph:default",
      messages: [{ content: "hello", role: "user" }],
      modelRef: { modelId: "test-model", providerKey: "platform" },
      stateKey: null,
    });
    expect(persistedHash).toBe(
      createHmac("sha256", "stable-completion-idempotency-secret")
        .update("completion-request:v1\0", "utf8")
        .update(canonicalRequest, "utf8")
        .digest("hex")
    );
    expect(persistedHash).not.toBe(
      createHmac("sha256", "stable-completion-idempotency-secret")
        .update("chat-prompt:v1\0", "utf8")
        .update(canonicalRequest, "utf8")
        .digest("hex")
    );
    expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("rejects changed content or graph before Temporal start and subscription", async () => {
    const { completionStream, CompletionIdempotencyConflictError } =
      await import("@/app/_facades/ai/completion.server");
    const base = {
      messages: [{ role: "user" as const, content: "hello" }],
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "caller-key",
      acceptanceMode: "workflow-start" as const,
    };

    await completionStream(base, ctx);
    await expect(
      completionStream(
        { ...base, messages: [{ role: "user", content: "changed" }] },
        ctx
      )
    ).rejects.toBeInstanceOf(CompletionIdempotencyConflictError);
    await expect(
      completionStream({ ...base, graphName: "langgraph:other" }, ctx)
    ).rejects.toBeInstanceOf(CompletionIdempotencyConflictError);

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it.each([
    "content",
    "graph",
  ])("allows only one concurrent changed %s request to claim the key", async (changed) => {
    const { completionStream, CompletionIdempotencyConflictError } =
      await import("@/app/_facades/ai/completion.server");
    const base = {
      modelRef: { providerKey: "platform" as const, modelId: "test-model" },
      sessionUser: TEST_SESSION_USER_1,
      graphName: "langgraph:default",
      idempotencyKey: "concurrent-key",
      acceptanceMode: "workflow-start" as const,
    };

    const outcomes = await Promise.allSettled([
      completionStream(
        { ...base, messages: [{ role: "user", content: "first" }] },
        ctx
      ),
      completionStream(
        {
          ...base,
          graphName: changed === "graph" ? "langgraph:other" : base.graphName,
          messages: [
            { role: "user", content: changed === "graph" ? "first" : "second" },
          ],
        },
        ctx
      ),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(CompletionIdempotencyConflictError),
    });
    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("scopes execution idempotency by node and billing account", async () => {
    const { scopeExecutionIdempotencyKey } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const callerKey = "chat:thread-1:message-1";

    const firstAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-1",
      "user-1",
      callerKey
    );
    const secondAccount = scopeExecutionIdempotencyKey(
      "node-template",
      "billing-2",
      "user-1",
      callerKey
    );

    expect(firstAccount).not.toBe(secondAccount);
    expect(firstAccount).toBe(
      scopeExecutionIdempotencyKey(
        "node-template",
        "billing-1",
        "user-1",
        callerKey
      )
    );
    expect(firstAccount).not.toBe(
      scopeExecutionIdempotencyKey(
        "node-template",
        "billing-1",
        "user-2",
        callerKey
      )
    );
  });

  it("returns after Temporal start without awaiting the first Redis event", async () => {
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );

    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        stateKey: "thread-1",
        messageId: "message-1",
        serverRunId: "123e4567-e89b-42d3-a456-426614174000",
        idempotencyKey: "chat:thread-1:message-1",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    expect(mocks.workflowStart).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(accepted.runId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });

  it("emits the first-event deadline as an in-band timeout", async () => {
    vi.useFakeTimers();
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(nextEvent).resolves.toEqual({
      done: false,
      value: { type: "error", error: "timeout" },
    });
  });

  it("keeps a local stream attached when cold execution starts after twenty seconds", async () => {
    vi.useFakeTimers();
    mocks.deployEnvironment = "local";
    mocks.localInproc = "true";
    mocks.subscribe.mockImplementationOnce(() =>
      (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        yield {
          id: "1-0",
          event: { type: "done" as const, finishReason: "stop" as const },
        };
      })()
    );
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      ctx
    );
    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: { type: "done", finishReason: "stop" },
    });
    await expect(accepted.final).resolves.toMatchObject({ ok: true });
  });

  it.each([
    { environment: "local", flag: "true" as const, deadline: 180_000 },
    { environment: "production", flag: "true" as const, deadline: 20_000 },
    { environment: "local", flag: undefined, deadline: 20_000 },
  ])("bounds first-event waiting at $deadline for $environment/$flag", async ({
    environment,
    flag,
    deadline,
  }) => {
    vi.useFakeTimers();
    mocks.deployEnvironment = environment;
    mocks.localInproc = flag;
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
      },
      ctx
    );
    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    let settled = false;
    void nextEvent.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(nextEvent).resolves.toMatchObject({
      value: { type: "error", error: "timeout" },
    });
  });

  it("treats subscriber abort as detach without stream-ended failure", async () => {
    const abortController = new AbortController();
    const warn = vi.spyOn(ctx.log, "warn");
    mocks.subscribe.mockImplementationOnce((_runId, signal: AbortSignal) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })()
    );
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const accepted = await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        acceptanceMode: "workflow-start",
        abortSignal: abortController.signal,
      },
      ctx
    );

    const nextEvent = accepted.stream[Symbol.asyncIterator]().next();
    abortController.abort();

    await expect(nextEvent).resolves.toEqual({ done: true, value: undefined });
    await expect(accepted.final).resolves.toMatchObject({
      ok: false,
      error: "aborted",
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "stream_ended_no_terminal" }),
      expect.anything()
    );
  });

  it.each(
    [undefined, "123e4567-e89b-42d3-a456-426614174000"].flatMap((serverRunId) =>
      [true, false].map((ok) => ({ serverRunId, ok }))
    )
  )("finalizes one caller claim with serverRunId $serverRunId and ok=$ok", async ({
    serverRunId,
    ok,
  }) => {
    mocks.executionOk = ok;
    const { completionStream } = await import(
      "@/app/_facades/ai/completion.server"
    );
    const { POST } = await import(
      "@/app/api/internal/graphs/[graphId]/runs/route"
    );
    await completionStream(
      {
        messages: [{ role: "user", content: "hello" }],
        modelRef: { providerKey: "platform", modelId: "test-model" },
        sessionUser: TEST_SESSION_USER_1,
        graphName: "langgraph:default",
        idempotencyKey: "producer-key",
        acceptanceMode: "workflow-start",
        ...(serverRunId ? { serverRunId } : {}),
      },
      ctx
    );
    // The actual workflow persists these fields before the worker sends api:runId.
    const workflow = mocks.workflowStart.mock.calls[0]?.[1].args[0];
    mocks.runs.set(workflow.runId, workflow);
    const invokeWorker = () =>
      POST(
        new NextRequest(
          "http://localhost/api/internal/graphs/langgraph:default/runs",
          {
            method: "POST",
            headers: {
              authorization: "Bearer scheduler-test-secret",
              "idempotency-key": `api:${workflow.runId}`,
            },
            body: JSON.stringify({
              runId: workflow.runId,
              executionGrantId: null,
              input: workflow.input,
            }),
          }
        ),
        { params: Promise.resolve({ graphId: workflow.graphId }) }
      );
    expect((await invokeWorker()).status).toBe(200);
    expect(mocks.executions).toBe(1);
    expect(mocks.claims.size).toBe(1);
    expect(mocks.claims.get(workflow.triggerRef)).toMatchObject({
      runId: workflow.runId,
      ok,
    });
    expect((await invokeWorker()).status).toBe(200);
    expect(mocks.executions).toBe(1);
  });

  it.each([
    true,
    false,
  ])("preserves historical wire-claim replay: ok=%s", async (ok) => {
    const { POST } = await import(
      "@/app/api/internal/graphs/[graphId]/runs/route"
    );
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const input = { actorUserId: TEST_SESSION_USER_1.id };
    const body = JSON.stringify({ runId, input });
    const requestHash = createHash("sha256")
      .update("langgraph:default\n")
      .update(body)
      .digest("hex");
    mocks.runs.set(runId, {
      runId,
      graphId: "langgraph:default",
      runKind: "user_immediate",
      triggerSource: "api",
      triggerRef: `ai:${"a".repeat(64)}`,
      requestedBy: TEST_SESSION_USER_1.id,
    });
    mocks.claims.set(`api:${runId}`, {
      runId,
      requestHash,
      leaseExpiresAt: null,
      ok,
      errorCode: ok ? null : "internal",
    });
    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-test-secret",
            "idempotency-key": `api:${runId}`,
          },
          body,
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok, runId });
    expect(mocks.executions).toBe(0);
    expect(mocks.claims.size).toBe(1);
  });

  it.each([
    "missing",
    "wrong-owner",
    "wrong-graph",
    "wrong-kind",
    "missing-claim",
    "wrong-hash",
    "wrong-run",
  ])("refuses unbound caller provenance: %s", async (fault) => {
    const { POST } = await import(
      "@/app/api/internal/graphs/[graphId]/runs/route"
    );
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const key = `ai:${"a".repeat(64)}`;
    const requestHash = "b".repeat(64);
    const input = {
      actorUserId: TEST_SESSION_USER_1.id,
      executionRequestHash: requestHash,
    };
    if (fault !== "missing")
      mocks.runs.set(runId, {
        runId,
        graphId:
          fault === "wrong-graph" ? "langgraph:other" : "langgraph:default",
        runKind: fault === "wrong-kind" ? "system_webhook" : "user_immediate",
        triggerSource: "api",
        triggerRef: key,
        requestedBy:
          fault === "wrong-owner" ? "someone-else" : TEST_SESSION_USER_1.id,
      });
    if (fault !== "missing-claim")
      mocks.claims.set(key, {
        runId: fault === "wrong-run" ? "other-run" : runId,
        requestHash: fault === "wrong-hash" ? "c".repeat(64) : requestHash,
        leaseExpiresAt: null,
      });
    const before = structuredClone([...mocks.claims]);
    const response = await POST(
      new NextRequest(
        "http://localhost/api/internal/graphs/langgraph:default/runs",
        {
          method: "POST",
          headers: {
            authorization: "Bearer scheduler-test-secret",
            "idempotency-key": `api:${runId}`,
          },
          body: JSON.stringify({ runId, input }),
        }
      ),
      { params: Promise.resolve({ graphId: "langgraph:default" }) }
    );
    expect(response.status).toBe(fault === "wrong-hash" ? 422 : 409);
    expect([...mocks.claims]).toEqual(before);
    expect(mocks.executions).toBe(0);
  });
});

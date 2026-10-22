// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/services/syncGovernanceSchedules`
 * Purpose: Unit tests for governance schedule sync logic.
 * Scope: Tests sync function with mocked ScheduleControlPort; verifies create/update/resume/skip/prune behavior. Does not test Temporal integration or DB operations.
 * Invariants: Prune pauses (never deletes); conflict = update or skip or resume; idempotent on repeat.
 * Side-effects: none (all deps mocked)
 * Links: src/features/governance/services/syncGovernanceSchedules.ts
 * @public
 */

import {
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleDescription,
} from "@cogni/scheduler-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleSyncDeps,
  governanceScheduleId,
  syncGovernanceSchedules,
} from "@/features/governance/services/syncGovernanceSchedules";
import type { GovernanceConfig } from "@/shared/config";

const GRANT_ID = "test-grant-id-001";
const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const MOCK_DB_SCHEDULE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Counter-based mock to return unique dbScheduleIds per call */
let upsertCallCount = 0;

function makeMockDeps(
  overrides?: Partial<GovernanceScheduleSyncDeps>
): GovernanceScheduleSyncDeps {
  upsertCallCount = 0;
  return {
    ensureGovernanceGrant: vi.fn().mockResolvedValue(GRANT_ID),
    upsertGovernanceScheduleRow: vi.fn().mockImplementation(() => {
      upsertCallCount++;
      return Promise.resolve(`${MOCK_DB_SCHEDULE_ID}-${upsertCallCount}`);
    }),
    systemUserId: SYSTEM_USER_ID,
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi.fn().mockResolvedValue(null),
      listScheduleIds: vi.fn().mockResolvedValue([]),
    },
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

function makeConfig(
  charters: Array<{
    charter: string;
    cron: string;
    entrypoint: string;
    timezone?: string;
  }>
): GovernanceConfig {
  return {
    schedules: charters.map((c) => ({
      charter: c.charter,
      cron: c.cron,
      timezone: c.timezone ?? "UTC",
      entrypoint: c.entrypoint,
    })),
  };
}

/** Helper: build a ScheduleDescription matching the desired config (no drift) */
function makeMatchingDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; timezone?: string; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: opts?.timezone ?? "UTC",
    input: { message: entrypoint, model: "kimi-k2.5" },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

/** Helper: build a ScheduleDescription with stale config (drift) */
function makeDriftedDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: "UTC",
    // Stale: missing model field (the bug we're fixing)
    input: { message: entrypoint },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

describe("syncGovernanceSchedules", () => {
  let deps: GovernanceScheduleSyncDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  it("creates schedules for each charter in config", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      { charter: "GOVERN", cron: "0 * * * *", entrypoint: "GOVERN" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([
      "governance:community",
      "governance:govern",
    ]);
    // Upsert called for each schedule before Temporal creation
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(2);
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalScheduleId: "governance:community",
        ownerUserId: SYSTEM_USER_ID,
        graphId: "sandbox:openclaw",
      })
    );
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(2);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "governance:community",
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
        cron: "0 */6 * * *",
        timezone: "UTC",
        graphId: "sandbox:openclaw",
        executionGrantId: GRANT_ID,
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
        overlapPolicy: "skip",
        catchupWindowMs: 0,
      })
    );
  });

  it("ensures governance grant before creating schedules", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    await syncGovernanceSchedules(config, deps);

    expect(deps.ensureGovernanceGrant).toHaveBeenCalledOnce();
  });

  it("skips when schedule exists, is running, and config matches", async () => {
    const matchingDesc = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(matchingDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.skipped).toEqual(["governance:community"]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when config has changed (model drift)", async () => {
    const driftedDesc = makeDriftedDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(result.skipped).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:community",
      expect.objectContaining({
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
      })
    );
    // Running schedule — should not be resumed
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when dbScheduleId link drift detected", async () => {
    // Temporal schedule has dbScheduleId: null (legacy), DB row returns a UUID
    const descWithNullLink = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { dbScheduleId: null }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(descWithNullLink);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:community",
      expect.objectContaining({
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
      })
    );
  });

  it("updates and resumes a paused schedule with changed config", async () => {
    const driftedPaused = makeDriftedDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedPaused);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual(["governance:community"]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledOnce();
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      "governance:community"
    );
  });

  it("resumes paused schedule when config matches", async () => {
    const pausedDesc = makeMatchingDesc(
      "governance:community",
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(pausedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.resumed).toEqual(["governance:community"]);
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      "governance:community"
    );
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("pauses stale governance schedules not in config", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:community", "governance:old-charter"]),
    });

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.paused).toEqual(["governance:old-charter"]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      "governance:old-charter"
    );
  });

  // CROSS_TENANT_PRUNE (bug.5009): the shared Temporal namespace also holds the
  // operator's node-scoped `governance:{nodeId}:{charter}` dispatch schedules. A
  // node's flat prune MUST NOT pause them — doing so stopped forks' prod epochs
  // from self-sustaining (a paused schedule skips its cron).
  const DISPATCH_ID = "governance:11111111-2222-4333-8444-555555555555:ledger_ingest";

  it("does NOT pause the operator's node-scoped dispatch schedule", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:community", DISPATCH_ID]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual([]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalledWith(
      DISPATCH_ID
    );
  });

  it("still prunes its own stale flat id while ignoring a dispatch schedule", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([
          "governance:community",
          "governance:old-charter",
          DISPATCH_ID,
        ]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual(["governance:old-charter"]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalledWith(
      DISPATCH_ID
    );
  });

  it("handles externally deleted schedules during prune gracefully", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:deleted-charter"]),
    });
    deps.scheduleControl.pauseSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlNotFoundError("governance:deleted-charter")
      );

    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    // Should not throw, and should not list as paused
    expect(result.paused).toEqual([]);
  });

  it("is idempotent: no-op on repeat call with same config", async () => {
    // Use a stable dbScheduleId for both calls
    const stableDbId = "stable-db-id-for-idempotency";
    deps.upsertGovernanceScheduleRow = vi.fn().mockResolvedValue(stableDbId);

    // First call: all schedules created
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result1 = await syncGovernanceSchedules(config, deps);
    expect(result1.created).toEqual(["governance:community"]);

    // Second call: schedule exists now with matching config + same dbScheduleId
    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlConflictError("governance:community")
      );
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(
      makeMatchingDesc("governance:community", "0 */6 * * *", "COMMUNITY", {
        dbScheduleId: stableDbId,
      })
    );

    const result2 = await syncGovernanceSchedules(config, deps);
    expect(result2.skipped).toEqual(["governance:community"]);
    expect(result2.created).toEqual([]);
    expect(result2.updated).toEqual([]);
  });

  it("returns empty result for config with no schedules", async () => {
    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resumed).toEqual([]);
    expect(result.paused).toEqual([]);
  });
});

describe("GRAPH_CHARTER — governance schedule `graph:` (story.5101)", () => {
  const GRAPH_GRANT_ID = "test-graph-grant-id-001";
  const PRIORITIZER = {
    charter: "WORK_PRIORITIZER",
    cron: "0 * * * *",
    timezone: "UTC",
    entrypoint: "PRIORITIZE",
    graph: "langgraph:work-prioritizer",
    model: "gpt-oss-120b",
  };
  const LEDGER = {
    scopeId: "10a91d46-194b-509f-a9b5-ec4d597e9ee2",
    scopeKey: "default",
    epochLengthDays: 7,
    activitySources: {
      github: { attributionPipeline: "cogni-v0.0", sourceRefs: ["o/r"] },
    },
  };
  const created = (deps: GovernanceScheduleSyncDeps) =>
    vi
      .mocked(deps.scheduleControl.createSchedule)
      .mock.calls.map(([params]) => params);

  it("runs the declared langgraph graph via GraphRunWorkflow with a messages + platform modelRef input", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    const result = await syncGovernanceSchedules(
      { schedules: [PRIORITIZER] },
      deps
    );

    expect(result.created).toEqual(["governance:work_prioritizer"]);
    const [params] = created(deps);
    expect(params).toMatchObject({
      scheduleId: "governance:work_prioritizer",
      graphId: "langgraph:work-prioritizer",
      executionGrantId: GRAPH_GRANT_ID,
      cron: "0 * * * *",
      input: {
        messages: [{ role: "user", content: "PRIORITIZE" }],
        modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
      },
    });
    expect(params?.workflowType).toBeUndefined();
    expect(params?.taskQueueOverride).toBeUndefined();
    expect(deps.ensureGraphGrant).toHaveBeenCalledWith(
      "langgraph:work-prioritizer"
    );
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "langgraph:work-prioritizer",
        executionGrantId: GRAPH_GRANT_ID,
      })
    );
  });

  it("appends a trusted policy payload to the graph message as a fenced json block", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const payload = { workPrioritization: { policyVersion: "v5.0" } };
    await syncGovernanceSchedules(
      { schedules: [{ ...PRIORITIZER, payload }] },
      deps
    );
    const [params] = created(deps);
    expect(params?.input).toEqual({
      messages: [
        {
          role: "user",
          content: `PRIORITIZE\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        },
      ],
      modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
    });
  });

  it("GRAPH_CRON_DRIFT: a cron change on a graph charter updates the Temporal schedule", async () => {
    const existing = (nextRunAtIso: string): ScheduleDescription => ({
      scheduleId: "governance:work_prioritizer",
      nextRunAtIso,
      lastRunAtIso: null,
      isPaused: false,
      cron: null,
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "PRIORITIZE" }],
        modelRef: { providerKey: "platform", modelId: PRIORITIZER.model },
      },
      dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
    });
    const make = (nextCronRun: string) => {
      const deps = makeMockDeps({
        ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
        nextCronRun: vi.fn().mockReturnValue(nextCronRun),
      });
      deps.scheduleControl.createSchedule = vi
        .fn()
        .mockRejectedValue(
          new ScheduleControlConflictError("governance:work_prioritizer")
        );
      deps.scheduleControl.describeSchedule = vi
        .fn()
        .mockResolvedValue(existing("2026-10-21T03:00:00.000Z"));
      return deps;
    };

    const changed = make("2026-10-21T02:55:00.000Z");
    const r1 = await syncGovernanceSchedules(
      { schedules: [{ ...PRIORITIZER, cron: "*/5 * * * *" }] },
      changed
    );
    expect(r1.updated).toEqual(["governance:work_prioritizer"]);
    expect(changed.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:work_prioritizer",
      expect.objectContaining({ cron: "*/5 * * * *" })
    );

    const same = make("2026-10-21T03:00:00.000Z");
    const r2 = await syncGovernanceSchedules(
      { schedules: [PRIORITIZER] },
      same
    );
    expect(r2.skipped).toEqual(["governance:work_prioritizer"]);
    expect(same.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("keeps a charter WITHOUT graph on sandbox:openclaw byte-for-byte", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    await syncGovernanceSchedules(
      makeConfig([
        { charter: "HEARTBEAT", cron: "0 * * * *", entrypoint: "HEARTBEAT" },
      ]),
      deps
    );
    const [params] = created(deps);
    expect(params?.graphId).toBe("sandbox:openclaw");
    expect(params?.executionGrantId).toBe(GRANT_ID);
    expect(params?.input).toEqual({ message: "HEARTBEAT", model: "kimi-k2.5" });
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
  });

  it("LEDGER_PRESERVED: a graph charter beside LEDGER_INGEST leaves the CollectEpoch schedule on the governance grant", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const result = await syncGovernanceSchedules(
      {
        schedules: [
          PRIORITIZER,
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
            // `graph` is ignored on LEDGER_INGEST
            graph: "langgraph:work-prioritizer",
            model: "gpt-oss-120b",
          },
        ],
        ledger: LEDGER,
      },
      deps
    );
    expect(result.created).toEqual([
      "governance:work_prioritizer",
      "governance:ledger_ingest",
    ]);
    const ledger = created(deps).find(
      (p) => p.scheduleId === "governance:ledger_ingest"
    );
    expect(ledger?.workflowType).toBe("CollectEpochWorkflow");
    expect(ledger?.graphId).toBe("ledger:ingest");
    expect(ledger?.executionGrantId).toBe(GRANT_ID);
    expect(deps.ensureGraphGrant).toHaveBeenCalledTimes(1);
    expect(result.paused).toEqual([]);
  });

  it("skips (and lets prune pause) a graph charter when no graph grant dep is wired", async () => {
    const deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:work_prioritizer"]),
    });
    const result = await syncGovernanceSchedules(
      { schedules: [PRIORITIZER] },
      deps
    );
    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["governance:work_prioritizer"]);
    expect(result.paused).toEqual(["governance:work_prioritizer"]);
  });
});

describe("governanceScheduleId", () => {
  it("lowercases charter name", () => {
    expect(governanceScheduleId("COMMUNITY")).toBe("governance:community");
    expect(governanceScheduleId("ENGINEERING")).toBe("governance:engineering");
    expect(governanceScheduleId("GOVERN")).toBe("governance:govern");
  });
});

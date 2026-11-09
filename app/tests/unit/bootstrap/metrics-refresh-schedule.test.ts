// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/metrics-refresh-schedule`
 * Purpose: The goal-metric refresh clock registers once on boot, retries boundedly, preserves pause state, and reaches Temporal as a NodeTaskWorkflow payload while graph schedules keep their shape.
 * Scope: Unit — container and Temporal client mocked.
 * Links: src/bootstrap/jobs/metrics-refresh.job.ts, src/adapters/server/temporal/schedule-control.adapter.ts
 * @internal
 */

import type { CreateScheduleParams } from "@cogni/scheduler-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleArgs } from "@/adapters/server/temporal/schedule-control.adapter";

const mocks = vi.hoisted(() => ({
  describeSchedule: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  ensureGrant: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    executionGrantPort: { ensureGrant: mocks.ensureGrant },
    scheduleControl: {
      describeSchedule: mocks.describeSchedule,
      createSchedule: mocks.createSchedule,
      updateSchedule: mocks.updateSchedule,
    },
  }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ warn: mocks.warn }),
}));

const GRANT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("VITEST", "false");
  mocks.ensureGrant.mockResolvedValue({ id: GRANT });
  mocks.describeSchedule.mockResolvedValue(null);
  mocks.createSchedule.mockResolvedValue(undefined);
  mocks.updateSchedule.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("automatic metric clock activation", () => {
  it("registers one scoped clock on boot without an ops request", async () => {
    const { startMetricsSyncOnBoot } = await import(
      "@/bootstrap/jobs/metrics-refresh.job"
    );
    startMetricsSyncOnBoot();
    startMetricsSyncOnBoot();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "metrics:test-node:refresh",
        cron: "* * * * *",
        workflowType: "NodeTaskWorkflow",
        overlapPolicy: "skip",
      })
    );
    expect(mocks.ensureGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["task:dispatch:test-node:/api/internal/metrics/refresh"],
      })
    );
  });

  it("keeps unit-test processes inert", async () => {
    vi.stubEnv("APP_ENV", "test");
    const { startMetricsSyncOnBoot } = await import(
      "@/bootstrap/jobs/metrics-refresh.job"
    );
    startMetricsSyncOnBoot();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ensureGrant).not.toHaveBeenCalled();
  });

  it("bounds unsuccessful boot reconciliation", async () => {
    mocks.describeSchedule.mockRejectedValue(new Error("unavailable"));
    const { startMetricsSyncOnBoot } = await import(
      "@/bootstrap/jobs/metrics-refresh.job"
    );
    startMetricsSyncOnBoot();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.ensureGrant).toHaveBeenCalledTimes(8);
    expect(mocks.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "metrics", exhausted: true }),
      "Schedule startup reconcile failed"
    );
  });

  it("reconciles an ambiguous create without making another clock", async () => {
    mocks.describeSchedule
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ isPaused: true, nextRunAtIso: null });
    mocks.createSchedule.mockRejectedValueOnce(new Error("response lost"));
    const { ensureMetricsRefreshSchedule } = await import(
      "@/bootstrap/jobs/metrics-refresh.job"
    );
    const result = await ensureMetricsRefreshSchedule();
    expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scheduleId: "metrics:test-node:refresh",
      paused: true,
    });
  });
});

describe("Temporal schedule args", () => {
  const base = {
    scheduleId: "metrics:test-node:refresh",
    nodeId: "test-node",
    ownerUserId: "owner",
    cron: "* * * * *",
    timezone: "UTC",
    executionGrantId: GRANT,
    input: { executionGrantId: GRANT },
  } as unknown as CreateScheduleParams;

  it("maps a node task to the NodeTaskWorkflow payload", () => {
    expect(
      scheduleArgs({
        ...base,
        graphId: "task:/api/internal/metrics/refresh",
        workflowType: "NodeTaskWorkflow",
      })
    ).toEqual({
      nodeId: "test-node",
      route: "/api/internal/metrics/refresh",
      payload: { executionGrantId: GRANT },
      scheduleId: "metrics:test-node:refresh",
      executionGrantId: GRANT,
    });
  });

  it("refuses node-task routes outside /api/internal/", () => {
    for (const graphId of [
      "task:/api/v1/metrics",
      "task:/api/internal/../v1/x",
      "task:/api/internal/x?y=1",
    ])
      expect(() =>
        scheduleArgs({ ...base, graphId, workflowType: "NodeTaskWorkflow" })
      ).toThrow("invalid_task_route");
  });

  it("keeps graph-run schedules on their existing shape", () => {
    expect(scheduleArgs({ ...base, graphId: "langgraph:brain" })).toEqual({
      nodeId: "test-node",
      graphId: "langgraph:brain",
      executionGrantId: GRANT,
      input: { executionGrantId: GRANT },
      runKind: "system_scheduled",
      triggerSource: "temporal_schedule",
      triggerRef: "metrics:test-node:refresh",
      requestedBy: "owner",
      dbScheduleId: null,
      temporalScheduleId: "metrics:test-node:refresh",
    });
  });
});

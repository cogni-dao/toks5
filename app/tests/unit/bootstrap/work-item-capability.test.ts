// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemsContentPort } from "@cogni/work-items";
import { toWorkItemId, rankScore } from "@cogni/work-items";
import { createWorkItemCapability } from "../../../src/bootstrap/capabilities/work-item";
const scores = {
  goal: { v: 3 },
  time: { v: 2 },
  unblocks: { v: 1 },
  ease: { v: 3 },
  confidence: { v: 2 },
  agent: { v: 3 },
};
const item = {
  id: toWorkItemId("task.0001"),
  type: "task",
  title: "Scored",
  status: "cancelled",
  node: "toks5",
  actor: "either",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 2,
  deployVerified: false,
  createdAt: "2026-10-23",
  updatedAt: "2026-10-23",
  scores,
} as WorkItem;
describe("TOKS5 live score writer", () => {
  it("resolves each actor at invocation, reads six fields/rank and fails closed without actor", async () => {
    let actor = "actor-a";
    const patch = vi.fn().mockResolvedValue(item);
    const capability = createWorkItemCapability({
      workItemQuery: {} as never,
      workItemCommand: {} as never,
      backlogReader: {
        get: vi.fn(),
        list: vi.fn().mockResolvedValue({ items: [item] }),
      },
      backlogWriter: {
        patch: patch as WorkItemsContentPort["patch"],
        principalId: () => actor,
      },
    });
    const input = { id: item.id, expectedRevision: 1, set: { scores } };
    await capability.patch(input);
    actor = "actor-b";
    const result = await capability.patch(input);
    expect(patch.mock.calls.map((call) => call[1])).toEqual([
      "actor-a",
      "actor-b",
    ]);
    expect(result.scores).toEqual(scores);
    expect(result.rankScore).toBe(rankScore(scores));
    expect((await capability.query({ ids: [item.id] }))[0]?.scores).toEqual(
      scores
    );
    actor = "";
    await expect(capability.patch(input)).rejects.toThrow(
      "authenticated actor"
    );
    expect(patch).toHaveBeenCalledTimes(2);
    actor = "actor-b";
    await expect(
      capability.patch({ id: item.id, set: { priority: 1 } })
    ).rejects.toThrow("node admin");
    expect(patch).toHaveBeenCalledTimes(2);
  });
  it("forwards mixed triage plus foreign content unchanged and preserves the package ownership denial", async () => {
    const denied = Object.assign(
      new Error("Not authorized to mutate work item"),
      { name: "WorkItemAuthorizationError" }
    );
    const patch = vi.fn().mockRejectedValue(denied);
    const capability = createWorkItemCapability({
      workItemQuery: {} as never,
      workItemCommand: {} as never,
      backlogWriter: { patch, principalId: () => "foreign-creator" },
    });
    const input = {
      id: item.id,
      expectedRevision: 1,
      set: { scores, summary: "foreign content" },
    };
    await expect(capability.patch(input)).rejects.toBe(denied);
    expect(patch).toHaveBeenCalledWith(input, "foreign-creator");
  });
});

// Existing story.5101 read/fallback contract remains intact when live writes are absent.
describe("work item capability legacy fallback", () => {
  it("forwards the query to the live backlog and falls back when not wired", async () => {
    const markdown = {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const backlog = {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const deps = {
      workItemQuery: markdown as never,
      workItemCommand: {} as never,
    };
    await createWorkItemCapability({ ...deps, backlogReader: backlog }).query({
      statuses: ["needs_implement"],
    });
    expect(backlog.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
    expect(markdown.list).not.toHaveBeenCalled();
    await createWorkItemCapability(deps).query({
      statuses: ["needs_implement"],
    });
    expect(markdown.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
  });
  it("uses Markdown commands when no live writer is wired", async () => {
    const markdown = { get: vi.fn().mockResolvedValue(item), list: vi.fn() };
    const commands = {
      patch: vi.fn().mockResolvedValue(item),
      transitionStatus: vi.fn().mockResolvedValue({ ...item, status: "done" }),
    };
    const backlog = { get: vi.fn(), list: vi.fn() };
    const capability = createWorkItemCapability({
      workItemQuery: markdown as never,
      workItemCommand: commands as never,
      backlogReader: backlog,
    });
    await capability.patch({ id: item.id, set: { priority: 3 } });
    await capability.transitionStatus({ id: item.id, toStatus: "done" });
    expect(commands.patch).toHaveBeenCalledTimes(1);
    expect(commands.transitionStatus).toHaveBeenCalledTimes(1);
    expect(backlog.get).not.toHaveBeenCalled();
    expect(backlog.list).not.toHaveBeenCalled();
  });
});

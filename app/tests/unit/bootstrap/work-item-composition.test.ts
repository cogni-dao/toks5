// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import type { WorkItem, WorkItemsContentPort } from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import { composeWorkItemContent } from "../../../src/bootstrap/capabilities/work-item-composition";

const item = {
  id: toWorkItemId("task.0001"),
  type: "task",
  title: "Current content",
  status: "cancelled",
  node: "toks5",
  actor: "either",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-10-23",
  updatedAt: "2026-10-23",
  scores: {
    goal: { v: 3 },
    time: { v: 2 },
    unblocks: { v: 1 },
    ease: { v: 3 },
    confidence: { v: 2 },
    agent: { v: 3 },
  },
} as WorkItem;
function setup() {
  const old = {
    ...item,
    title: "Stale legacy content",
    revision: 2,
    scores: undefined,
    claimedByRun: "run-a",
    claimedAt: "2026-10-23",
    lastCommand: "/implement",
  };
  const content = {
    get: vi.fn().mockResolvedValue(item),
    list: vi.fn().mockResolvedValue({
      items: [item],
      pageInfo: { endCursor: null, hasMore: false },
    }),
    listSummaries: vi.fn().mockResolvedValue({
      items: [],
      pageInfo: { endCursor: null, hasMore: false },
    }),
    history: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    patch: vi.fn().mockResolvedValue(item),
    delete: vi.fn(),
  };
  const legacy = {
    get: vi.fn().mockResolvedValue(old),
    list: vi.fn().mockResolvedValue({
      items: [old],
      pageInfo: { endCursor: null, hasMore: false },
    }),
    claim: vi.fn().mockResolvedValue(old),
    heartbeat: vi.fn().mockResolvedValue(old),
    release: vi.fn().mockResolvedValue({
      ...old,
      claimedByRun: undefined,
      claimedAt: undefined,
      lastCommand: undefined,
    }),
    delete: vi.fn().mockResolvedValue(true),
  };
  return {
    content,
    legacy,
    port: composeWorkItemContent(content as WorkItemsContentPort, legacy),
  };
}
describe("TOKS5 shared content / legacy v1 composition", () => {
  it("overlays only claim fields, preserving primary score content and revision", async () => {
    const { legacy, port } = setup();
    expect(await port.get(item.id)).toEqual({
      ...item,
      claimedByRun: "run-a",
      claimedAt: "2026-10-23",
      lastCommand: "/implement",
    });
    expect((await port.list()).items[0]).toMatchObject({
      title: item.title,
      revision: 8,
      scores: item.scores,
      claimedByRun: "run-a",
    });
    // BOUNDED_CLAIM_OVERLAY (task.0056): the overlay reads exactly the page's ids.
    expect(legacy.list).toHaveBeenCalledWith({ ids: [item.id], limit: 1 });
  });
  it("preserves lease inputs/fences and DELETE while CAS reaches only new content", async () => {
    const { content, legacy, port } = setup();
    const claim = {
      id: item.id,
      runId: "run-a",
      principalId: "actor-a",
      command: "/implement",
    };
    expect((await port.claim(claim)).scores).toEqual(item.scores);
    expect(legacy.claim).toHaveBeenCalledWith(claim);
    await port.heartbeat(claim);
    await port.release(claim);
    expect(legacy.heartbeat).toHaveBeenCalledWith(claim);
    expect(legacy.release).toHaveBeenCalledWith(claim);
    const conflict = Object.assign(new Error("foreign run"), {
      name: "WorkItemLeaseConflictError",
    });
    legacy.heartbeat.mockRejectedValueOnce(conflict);
    await expect(port.heartbeat({ ...claim, runId: "run-b" })).rejects.toBe(
      conflict
    );
    const patch = {
      id: item.id,
      expectedRevision: 8,
      set: { scores: item.scores },
    };
    await port.patch(patch, "collaborator");
    expect(content.patch).toHaveBeenCalledWith(patch, "collaborator");
    await port.delete(item.id, "creator");
    expect(legacy.delete).toHaveBeenCalledWith(item.id, "creator");
    expect(content.delete).not.toHaveBeenCalled();
  });
  it("forwards listSummaries, history and the change reason to the content port", async () => {
    const { content, port } = setup();
    const options = { maxScanRows: 10 };
    await port.listSummaries({ limit: 5 }, options);
    expect(content.listSummaries).toHaveBeenCalledWith({ limit: 5 }, options);
    await port.history?.(item.id);
    expect(content.history).toHaveBeenCalledWith(item.id);
    const patch = { id: item.id, reason: "why", set: { title: "t" } };
    await port.patch(patch, "collaborator");
    expect(content.patch).toHaveBeenCalledWith(patch, "collaborator");
  });
  it("forwards the composed board read with its bounds, and omits it when absent (task.0056)", async () => {
    const { content, legacy } = setup();
    const pages = { columns: [], queryCount: 1 };
    const listBoardColumns = vi.fn().mockResolvedValue(pages);
    const port = composeWorkItemContent(
      { ...content, listBoardColumns } as WorkItemsContentPort,
      legacy
    );
    const signal = new AbortController().signal;
    await expect(
      port.listBoardColumns?.({}, ["done"], 20, { signal })
    ).resolves.toBe(pages);
    expect(listBoardColumns).toHaveBeenCalledWith({}, ["done"], 20, { signal });
    expect(legacy.list).not.toHaveBeenCalled();
    expect(
      composeWorkItemContent(content as WorkItemsContentPort, legacy)
        .listBoardColumns
    ).toBeUndefined();
  });
  it("omits history when the content port has none", () => {
    const { content, legacy } = setup();
    const { history: _history, ...noHistory } = content;
    const port = composeWorkItemContent(
      noHistory as WorkItemsContentPort,
      legacy
    );
    expect(port.history).toBeUndefined();
  });
});

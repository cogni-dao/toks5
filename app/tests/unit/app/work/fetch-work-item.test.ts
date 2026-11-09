// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Covers exact-item cookie-auth fetches, the unknown-id error state, and the bounded summary/board fetchers (task.0056). */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchWorkBoard,
  fetchWorkItem,
  fetchWorkItems,
  WorkItemFetchError,
} from "@/app/(app)/work/_api/fetchWorkItems";

describe("fetchWorkItem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the encoded exact-item endpoint with same-origin auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "story.5000" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWorkItem("story.5000")).resolves.toMatchObject({
      id: "story.5000",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/story.5000",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      })
    );
  });

  it("surfaces unknown ids for the human not-found state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "Work item not found: bug.9999" }),
      })
    );

    const error = await fetchWorkItem("bug.9999").catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkItemFetchError);
    expect(error).toMatchObject({
      message: "Work item not found: bug.9999",
      status: 404,
    });
  });

  it("keeps operational failures distinct from not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "Work-item store is busy" }),
      })
    );

    await expect(fetchWorkItem("task.5174")).rejects.toMatchObject({
      name: "WorkItemFetchError",
      message: "Work-item store is busy",
      status: 503,
    });
  });

  it("encodes a logical percent sequence once at the API boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "bug.%2F" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkItem("bug.%2F");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/items/bug.%252F",
      expect.any(Object)
    );
  });
});

describe("bounded work list fetchers (task.0056)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetchWorkItems requests exactly one summaries page and never follows its cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          items: [{ id: "task.1" }],
          pageInfo: { endCursor: "next", hasMore: true },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    const page = await fetchWorkItems(
      new URLSearchParams("statuses=needs_implement&limit=25"),
      signal
    );

    expect(page.pageInfo).toEqual({ endCursor: "next", hasMore: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/summaries?statuses=needs_implement&limit=25",
      expect.objectContaining({ signal, credentials: "same-origin" })
    );
  });

  it("fetchWorkBoard requests one board and carries the HTTP status on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "invalid input" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWorkBoard(new URLSearchParams("statuses=nope"))
    ).rejects.toMatchObject({ name: "WorkItemFetchError", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/work/board?statuses=nope"
    );
  });
});

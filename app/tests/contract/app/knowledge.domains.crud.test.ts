// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Toks5 HTTP delegation against the published package fake; no database mocks. */
import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import type { SessionUser } from "@cogni/node-shared";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

let store: FakeKnowledgeStoreAdapter;
const principal: SessionUser = {
  id: "agent-user", walletAddress: null, displayName: "agent", avatarColor: null,
};
let user: SessionUser | null = principal;
const log = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => user) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log, clock: { now: () => new Date("2026-10-29T00:00:00Z") },
    config: { unhandledErrorPolicy: "rethrow" }, knowledgeStorePort: store,
  })),
}));
import * as route from "@/app/api/v1/knowledge/domains/[domain]/route";

async function request(domain: string, method: "GET" | "PATCH" | "DELETE", body?: unknown) {
  let result: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  await testApiHandler({
    appHandler: route, params: { domain }, url: `/api/v1/knowledge/domains/${domain}`,
    async test({ fetch }) {
      const response = await fetch({ method,
        headers: { "content-type": "application/json", authorization: "Bearer test" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      result = { status: response.status, body: await response.json() };
    },
  });
  return result;
}

beforeEach(async () => {
  vi.clearAllMocks(); log.child.mockImplementation(() => log); user = principal;
  store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "scratch", name: "Scratch", description: "clear me" });
});

describe("Toks5 domain item HTTP delegation", () => {
  it("lets a bearer principal read, clear metadata, and delete an empty domain", async () => {
    expect((await request("scratch", "GET")).body).toMatchObject({ id: "scratch", entryCount: 0 });
    expect((await request("scratch", "PATCH", { name: "Renamed", description: null })).body)
      .toMatchObject({ id: "scratch", name: "Renamed", description: null });
    // Repeating identical metadata remains delegated to package no-op handling.
    expect((await request("scratch", "PATCH", { name: "Renamed", description: null })).status).toBe(200);
    expect(await request("scratch", "DELETE")).toEqual({ status: 200, body: { id: "scratch", deleted: true } });
    expect((await request("scratch", "GET")).status).toBe(404);
  });

  it("rejects immutable id edits and empty patches without changing the domain", async () => {
    for (const body of [{ id: "renamed" }, {}]) expect((await request("scratch", "PATCH", body)).status).toBe(400);
    expect((await request("scratch", "GET")).body).toMatchObject({ id: "scratch", name: "Scratch" });
  });

  it("refuses every baseline domain and a populated domain without mutation", async () => {
    for (const id of ["meta", "mission", "strategy"]) {
      expect(await request(id, "DELETE")).toMatchObject({ status: 409, body: { errorCode: "domain_protected" } });
    }
    await store.withWrite({ operationId: "test.seed", message: "seed" }, async (write) => {
      await write.upsertKnowledge({ id: "entry-a", domain: "scratch", title: "Entry A", content: "alpha", sourceType: "agent" });
    });
    expect(await request("scratch", "DELETE")).toMatchObject({ status: 409, body: { errorCode: "domain_not_empty", entryCount: 1 } });
    expect((await request("scratch", "GET")).body).toMatchObject({ id: "scratch", entryCount: 1 });
    expect((await request("missing", "DELETE")).status).toBe(404);
    expect((await request("missing", "PATCH", { name: "New" })).status).toBe(404);
  });

  it("uses the existing required-session perimeter for every verb", async () => {
    user = null;
    for (const method of ["GET", "PATCH", "DELETE"] as const)
      expect(await request("scratch", method, method === "PATCH" ? { name: "New" } : undefined))
        .toEqual({ status: 401, body: { error: "Session required" } });
  });
});

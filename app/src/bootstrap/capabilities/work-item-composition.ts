// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** TOKS5 keeps its v1 lease/delete authority while adopting released score content. */
import type { WorkItem, WorkItemsContentPort } from "@cogni/work-items";
import type { WorkItemsDoltgresPort as LegacyPort } from "@cogni/work-items-legacy/adapters/doltgres";
import type { WorkItemsDoltgresPort } from "@/ports/server";

function withClaim(content: WorkItem, legacy: WorkItem | null): WorkItem {
  return {
    ...content,
    ...(legacy?.claimedByRun && { claimedByRun: legacy.claimedByRun }),
    ...(legacy?.claimedAt && { claimedAt: legacy.claimedAt }),
    ...(legacy?.lastCommand && { lastCommand: legacy.lastCommand }),
  };
}

/** No lease-token synthesis or PostgreSQL cutover; shared bridge locks serialize writers. */
export function composeWorkItemContent(
  content: WorkItemsContentPort,
  legacy: Pick<
    LegacyPort,
    "get" | "list" | "claim" | "heartbeat" | "release" | "delete"
  >
): WorkItemsDoltgresPort {
  const refresh = async (item: WorkItem): Promise<WorkItem> => {
    const current = await content.get(item.id);
    if (!current) throw new Error(`Work item not found: ${item.id}`);
    return withClaim(current, item);
  };
  return {
    get: async (id) => {
      const item = await content.get(id);
      return item ? withClaim(item, await legacy.get(id)) : null;
    },
    list: async (query = {}) => {
      const page = await content.list(query);
      if (!page.items.length) return page;
      const oldPage = await legacy.list(query);
      const claims = new Map(oldPage.items.map((item) => [item.id, item]));
      return {
        ...page,
        items: page.items.map((item) =>
          withClaim(item, claims.get(item.id) ?? null)
        ),
      };
    },
    create: (input, principal) => content.create(input, principal),
    patch: async (input, principal) =>
      withClaim(
        await content.patch(input, principal),
        await legacy.get(input.id)
      ),
    delete: (id, principal) => legacy.delete(id, principal),
    claim: async (input) => refresh(await legacy.claim(input)),
    heartbeat: async (input) => refresh(await legacy.heartbeat(input)),
    release: async (input) => refresh(await legacy.release(input)),
  };
}

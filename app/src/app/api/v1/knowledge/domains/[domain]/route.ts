// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/domains/[domain]/route`
 * Purpose: Expose domain read, partial update and empty-domain deletion on Toks5.
 * Scope: Thin node-owned delivery adapter; delegates storage to the released knowledge-store port.
 * Invariants: All verbs use the same authenticated-principal permission as collection POST.
 * Side-effects: HTTP responses and delegated Dolt reads/writes.
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @public
 */
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleDelete, handleGet, handleUpdate } from "../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type DomainContext = { params: Promise<{ domain: string }> };

export const GET = wrapRouteHandlerWithLogging<DomainContext>(
  { routeId: "knowledge.domains.get", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, user, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleGet((await context.params).domain, user);
  }
);
export const PATCH = wrapRouteHandlerWithLogging<DomainContext>(
  { routeId: "knowledge.domains.update", auth: { mode: "required", getSessionUser } },
  async (ctx, request, user, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleUpdate(request, (await context.params).domain, user, ctx.log);
  }
);
export const DELETE = wrapRouteHandlerWithLogging<DomainContext>(
  { routeId: "knowledge.domains.delete", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, user, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    return handleDelete((await context.params).domain, user, ctx.log);
  }
);

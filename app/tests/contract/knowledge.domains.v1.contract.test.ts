// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Domain HTTP wire examples; storage invariants remain owned by knowledge-store. */
import {
  DomainsErrorResponseSchema,
  domainsDeleteOperation,
  domainsGetOperation,
  domainsUpdateOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("Toks5 domain item contracts", () => {
  it("allows clearing a description without changing the immutable domain id", () => {
    expect(
      domainsUpdateOperation.input.parse({
        domain: "build-evals",
        body: { description: null },
      })
    ).toEqual({ domain: "build-evals", body: { description: null } });
    for (const body of [{}, { id: "renamed" }, { name: "" }, { extra: true }]) {
      expect(
        domainsUpdateOperation.input.safeParse({ domain: "build-evals", body })
          .success
      ).toBe(false);
    }
    expect(
      domainsGetOperation.input.safeParse({ domain: "Bad_ID" }).success
    ).toBe(false);
    expect(
      domainsDeleteOperation.output.parse({ id: "empty", deleted: true })
    ).toEqual({ id: "empty", deleted: true });
  });

  it("preserves write-outcome receipts and existing perimeter errors", () => {
    const receipt = {
      error: "unknown write outcome",
      errorCode: "knowledge_write_outcome_unknown",
      retryable: false,
      operationId: "probe-operation",
      branch: "main",
      commitHash: null,
    };
    expect(DomainsErrorResponseSchema.parse(receipt)).toEqual(receipt);
    for (const body of [
      { error: "Unauthorized" },
      { error: "Session required" },
      { error: "Internal server error" },
      {
        status: "error",
        reason: "CONTAINER_INIT_FAILED",
        message: "unavailable",
      },
    ])
      expect(DomainsErrorResponseSchema.parse(body)).toEqual(body);
    expect(
      DomainsErrorResponseSchema.safeParse({ error: "domain missing" }).success
    ).toBe(false);
  });
});

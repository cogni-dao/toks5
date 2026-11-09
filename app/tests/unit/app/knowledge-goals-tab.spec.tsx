// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-goals-tab`
 * Purpose: Prove red's mount of the published Goals capability (story.0021): the Goals tab renders the package board and its badge from one goals read, and the entry page hands `?observation=` to the evidence view. The board, chart and read client themselves are proven in packages/knowledge-base-ui.
 * Scope: React Query plus the browser fetch boundary, rendering the real `@cogni/knowledge-base-ui/goals` entry. No live network.
 * Invariants: ONE_CACHE_ENTRY (board and badge share one read).
 * Side-effects: global (stubbed fetch)
 * Links: app/src/app/(app)/knowledge/view.tsx, app/src/app/(app)/knowledge/_components/GoalsMount.tsx
 * @vitest-environment jsdom
 * @internal
 */

import { GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeMetricEvidence } from "@/app/(app)/knowledge/_components/GoalsMount";
import { KnowledgeDashboardView } from "@/app/(app)/knowledge/view";

const navigation = vi.hoisted(() => ({
  mode: "browse",
  observation: null as string | null,
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () =>
    new URLSearchParams({
      mode: navigation.mode,
      ...(navigation.observation
        ? { observation: navigation.observation }
        : {}),
    }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid", () => ({
  DataGrid: () => null,
  DataGridContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility",
  () => ({ DataGridColumnVisibility: () => null })
);
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-pagination", () => ({
  DataGridPagination: () => null,
}));
vi.mock("@cogni/node-ui-kit/reui/data-grid/data-grid-table", () => ({
  DataGridTable: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/AddDomainSheet", () => ({
  AddDomainSheet: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/KnowledgeDetail", () => ({
  KnowledgeDetail: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/ContributionDetail", () => ({
  ContributionDetail: () => null,
}));
vi.mock("@/app/(app)/knowledge/_components/GraphView", () => ({
  GraphView: () => null,
}));
vi.mock("@/components", () => ({
  Button: ({ children, onClick }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.push.mockReset();
  navigation.mode = "browse";
  navigation.observation = null;
});

/** One goal whose only KPI is behind pace: the badge reads "1 goal needs attention". */
function oneBehindGoal() {
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "local",
    goals: [
      {
        id: "goal-x",
        title: "Goal: Ship it",
        evaluateAt: "2027-01-31T00:00:00.000Z",
        configurationError: false,
        kpis: [
          {
            binding: {
              metricId: "m",
              comparator: "gte",
              target: { value: 1, unit: "ratio" },
            },
            metric: {
              id: "m",
              title: "Ratio",
              calculatorId: "work.convergence@1",
              cadenceSeconds: 3600,
              maxAgeSeconds: 7200,
            },
            assessment: {
              status: "behind",
              reason: null,
              value: 0.8,
              unit: "ratio",
              observationId: "00000000-0000-4000-8000-000000000001",
              observedAt: "2026-11-02T10:00:00.000Z",
              comparator: "gte",
              target: { value: 1, unit: "ratio" },
              deadline: "2027-01-31T00:00:00.000Z",
              pace: { observed: 0.01, needed: 0.014 },
            },
            trend: null,
          },
        ],
        hypotheses: [],
        moreHypotheses: false,
        hypothesesUnavailable: false,
      },
    ],
  });
}

describe("Knowledge Goals tab", () => {
  it("mounts the package board under one provider, sharing a single goals read with the tab badge", async () => {
    navigation.mode = "goals";
    const data = oneBehindGoal();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/v1/metrics/goals") return Response.json(data);
      if (url.startsWith("/api/v1/knowledge/contributions"))
        return Response.json({ contributions: [] });
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client()}>
        <KnowledgeDashboardView
          initialList={{ items: [], domains: [] }}
          initialDomains={{ domains: [] }}
        />
      </QueryClientProvider>
    );
    await screen.findByText("Goal: Ship it");
    const goals = screen.getByRole("button", { name: /^Goals/ });
    await waitFor(() => expect(goals.textContent).toContain("1"));
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/v1/metrics/goals")
    ).toHaveLength(1);
  });
});

describe("Knowledge metric evidence mount", () => {
  it("hands the page's ?observation= to the published evidence view", async () => {
    const id = "00000000-0000-4000-8000-000000000009";
    navigation.observation = id;
    const definition = {
      id: "work",
      title: "Work",
      revision: "1",
      spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
    };
    const reading = {
      id,
      metricId: "work",
      definitionRevision: "1",
      definitionHash: "hash1",
      calculatorVersion: "work.count@1",
      paramsHash: "params1",
      node: "test",
      environment: "test",
      dataScope: "test",
      window: { start: "2026-11-02T00:00:00Z", end: "2026-11-02T01:00:00Z" },
      sourceWatermarks: [{ source: "work", asOf: "2026-11-02T00:00:00Z" }],
      observedAt: "2026-11-02T01:00:00Z",
      status: "ok",
      value: 5,
      unit: "items",
      reason: null,
      evidenceRefs: ["node:work"],
    };
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/v1/metrics/work"
        ? Response.json({
            definition,
            latestAttempt: reading,
            lastGood: reading,
            viewState: "ok",
            history: [reading],
          })
        : url === `/api/v1/metrics/work/observations/${id}`
          ? Response.json({ definition, observation: reading })
          : new Response("{}", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={client()}>
        <KnowledgeMetricEvidence id="work" />
      </QueryClientProvider>
    );
    await screen.findByText(/Linked immutable evidence/);
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "/api/v1/metrics/work",
      `/api/v1/metrics/work/observations/${id}`,
    ]);
  });
});

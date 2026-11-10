// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node composition. The calculators, budgets, source allow-list and metric
 * tools are published in @cogni-dao/metrics and @cogni-dao/ai-tools; this
 * node binds its own id and its one goal-progress reader.
 */
import { createMetricTools } from "@cogni/shared-ai-tools";
import type { GoalsProgress, MetricService } from "@cogni-dao/metrics";
import {
	createGoalMetrics as createPublishedGoalMetrics,
	createGoalProgressReader,
	createGoalSource,
} from "@cogni-dao/metrics/knowledge";
import type { Sql } from "postgres";
import { getNodeId } from "@/shared/config";

export { createGoalProgressReader, createGoalSource };

export function createGoalMetrics(deps: {
	knowledgeSql: Sql;
	observationsSql: Sql;
	environment: string;
	log(event: object): void;
}) {
	return createPublishedGoalMetrics({ ...deps, node: getNodeId() });
}

/** Inject the node's one goal-progress reader so the route and tool share it. */
export function createGoalMetricTools(deps: {
	metrics: () => MetricService | undefined;
	goalProgress: () => Promise<GoalsProgress>;
}) {
	return createMetricTools(deps.metrics, { goalProgress: deps.goalProgress });
}

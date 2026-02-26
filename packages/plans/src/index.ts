/**
 * @adit/plans — SpecFlow-inspired plan artifact generator.
 */

export { renderIntentTemplate } from "./templates/intent.js";
export { renderRoadmapTemplate } from "./templates/roadmap.js";
export { renderTaskTemplate } from "./templates/task.js";
export {
  createPlanManager,
  type PlanManager,
} from "./generator/plan-manager.js";

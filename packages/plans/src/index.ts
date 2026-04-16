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

// Document spec and templates
export {
  DOC_TYPES,
  DOC_TYPE_IDS,
  extractH2Headings,
  extractSectionContents,
  classifyDocument,
  validateDocument,
  type DocTypeSpec,
  type DocValidationResult,
} from "./templates/doc-spec.js";

export { renderProjectOverviewTemplate } from "./templates/doc-project-overview.js";
export { renderArchitectureTemplate } from "./templates/doc-architecture.js";
export { renderApiReferenceTemplate } from "./templates/doc-api-reference.js";
export { renderDataModelTemplate } from "./templates/doc-data-model.js";
export { renderBusinessContextTemplate } from "./templates/doc-business-context.js";
export { renderConventionsTemplate } from "./templates/doc-conventions.js";

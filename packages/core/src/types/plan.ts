/**
 * SpecFlow-inspired plan types.
 *
 * Plans follow a hierarchy: Intent → Roadmap → Tasks
 * Sessions and events can be linked to specific tasks.
 */

export type PlanType = "intent" | "roadmap" | "task";

export type PlanStatus =
  | "draft"
  | "active"
  | "completed"
  | "abandoned";

/** A plan artifact (intent doc, roadmap, or task) */
export interface AditPlan {
  /** ULID */
  id: string;
  /** Project this plan belongs to */
  projectId: string;
  /** 'intent' | 'roadmap' | 'task' */
  planType: PlanType;
  /** Parent plan (roadmap→intent, task→roadmap) */
  parentPlanId: string | null;
  title: string;
  /** Markdown content */
  contentMd: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string | null;
  /** Vector clock for sync */
  vclockJson: string;
  /** Soft delete */
  deletedAt: string | null;
}

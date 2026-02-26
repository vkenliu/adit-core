/**
 * Plan manager — creates and manages SpecFlow artifacts.
 *
 * Plans are stored both as Markdown files in .adit/plans/ and
 * as records in the database for timeline linking and cloud sync.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  generateId,
  createClock,
  serialize,
  insertPlan,
  getPlanById,
  listPlans,
  getChildPlans,
  updatePlanStatus,
  type AditConfig,
  type AditPlan,
  type PlanType,
  type PlanStatus,
} from "@adit/core";
import { renderIntentTemplate } from "../templates/intent.js";
import { renderRoadmapTemplate } from "../templates/roadmap.js";
import { renderTaskTemplate } from "../templates/task.js";

export interface PlanManager {
  /** Create a new intent document */
  createIntent(title: string): AditPlan;

  /** Create a roadmap under an intent */
  createRoadmap(title: string, intentId: string): AditPlan;

  /** Create a task under a roadmap */
  createTask(title: string, roadmapId: string, phase: string): AditPlan;

  /** List all plans of a given type */
  list(planType?: PlanType): AditPlan[];

  /** Get plan by ID */
  get(id: string): AditPlan | null;

  /** Get child plans */
  getChildren(parentId: string): AditPlan[];

  /** Update plan status */
  setStatus(id: string, status: PlanStatus): void;

  /** Get the plans directory path */
  getPlansDir(): string;
}

export function createPlanManager(
  db: Database.Database,
  config: AditConfig,
): PlanManager {
  const plansDir = join(config.dataDir, "plans");
  mkdirSync(plansDir, { recursive: true });

  return {
    createIntent(title: string): AditPlan {
      const id = generateId();
      const content = renderIntentTemplate(title);
      const vclock = serialize(createClock(config.clientId));

      // Write to database
      insertPlan(db, {
        id,
        projectId: config.projectId,
        planType: "intent",
        title,
        contentMd: content,
        vclockJson: vclock,
      });

      // Write markdown file
      const fileName = `intent-${sanitizeFilename(title)}.md`;
      writeFileSync(join(plansDir, fileName), content);

      return getPlanById(db, id)!;
    },

    createRoadmap(title: string, intentId: string): AditPlan {
      const intent = getPlanById(db, intentId);
      if (!intent) throw new Error(`Intent not found: ${intentId}`);

      const id = generateId();
      const content = renderRoadmapTemplate(title, intent.title);
      const vclock = serialize(createClock(config.clientId));

      insertPlan(db, {
        id,
        projectId: config.projectId,
        planType: "roadmap",
        parentPlanId: intentId,
        title,
        contentMd: content,
        vclockJson: vclock,
      });

      const fileName = `roadmap-${sanitizeFilename(title)}.md`;
      writeFileSync(join(plansDir, fileName), content);

      return getPlanById(db, id)!;
    },

    createTask(title: string, roadmapId: string, phase: string): AditPlan {
      const roadmap = getPlanById(db, roadmapId);
      if (!roadmap) throw new Error(`Roadmap not found: ${roadmapId}`);

      const id = generateId();
      const content = renderTaskTemplate(title, roadmap.title, phase);
      const vclock = serialize(createClock(config.clientId));

      insertPlan(db, {
        id,
        projectId: config.projectId,
        planType: "task",
        parentPlanId: roadmapId,
        title,
        contentMd: content,
        vclockJson: vclock,
      });

      const fileName = `task-${sanitizeFilename(title)}.md`;
      writeFileSync(join(plansDir, fileName), content);

      return getPlanById(db, id)!;
    },

    list(planType?: PlanType): AditPlan[] {
      return listPlans(db, config.projectId, planType);
    },

    get(id: string): AditPlan | null {
      return getPlanById(db, id);
    },

    getChildren(parentId: string): AditPlan[] {
      return getChildPlans(db, parentId);
    },

    setStatus(id: string, status: PlanStatus): void {
      const vclock = serialize(createClock(config.clientId));
      updatePlanStatus(db, id, status, vclock);
    },

    getPlansDir(): string {
      return plansDir;
    },
  };
}

/** Sanitize a title for use as a filename */
function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

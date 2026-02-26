/**
 * Plan CRUD operations (SpecFlow artifacts).
 */

import type Database from "better-sqlite3";
import type { AditPlan, PlanType, PlanStatus } from "../types/index.js";

export interface CreatePlanInput {
  id: string;
  projectId: string;
  planType: PlanType;
  parentPlanId?: string | null;
  title: string;
  contentMd: string;
  vclockJson: string;
}

export function insertPlan(
  db: Database.Database,
  input: CreatePlanInput,
): void {
  db.prepare(`
    INSERT INTO plans (id, project_id, plan_type, parent_plan_id, title, content_md, created_at, vclock_json)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    input.id,
    input.projectId,
    input.planType,
    input.parentPlanId ?? null,
    input.title,
    input.contentMd,
    input.vclockJson,
  );
}

export function getPlanById(
  db: Database.Database,
  id: string,
): AditPlan | null {
  const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPlan(row) : null;
}

export function listPlans(
  db: Database.Database,
  projectId: string,
  planType?: PlanType,
): AditPlan[] {
  let sql =
    "SELECT * FROM plans WHERE project_id = ? AND deleted_at IS NULL";
  const params: unknown[] = [projectId];

  if (planType) {
    sql += " AND plan_type = ?";
    params.push(planType);
  }
  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}

export function getChildPlans(
  db: Database.Database,
  parentPlanId: string,
): AditPlan[] {
  const rows = db
    .prepare(
      "SELECT * FROM plans WHERE parent_plan_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    )
    .all(parentPlanId) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}

export function updatePlanStatus(
  db: Database.Database,
  id: string,
  status: PlanStatus,
  vclockJson: string,
): void {
  db.prepare(
    "UPDATE plans SET status = ?, updated_at = datetime('now'), vclock_json = ? WHERE id = ?",
  ).run(status, vclockJson, id);
}

export function updatePlanContent(
  db: Database.Database,
  id: string,
  contentMd: string,
  vclockJson: string,
): void {
  db.prepare(
    "UPDATE plans SET content_md = ?, updated_at = datetime('now'), vclock_json = ? WHERE id = ?",
  ).run(contentMd, vclockJson, id);
}

function rowToPlan(row: Record<string, unknown>): AditPlan {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    planType: row.plan_type as PlanType,
    parentPlanId: (row.parent_plan_id as string) ?? null,
    title: row.title as string,
    contentMd: row.content_md as string,
    status: row.status as PlanStatus,
    createdAt: row.created_at as string,
    updatedAt: (row.updated_at as string) ?? null,
    vclockJson: row.vclock_json as string,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}

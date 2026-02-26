/**
 * SQLite schema migrations for ADIT.
 *
 * Migrations are applied in order. Each migration has an id and SQL.
 * The migrations table tracks which have been applied.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "create_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        client_id     TEXT NOT NULL,
        session_type  TEXT NOT NULL DEFAULT 'interactive',
        platform      TEXT NOT NULL DEFAULT 'claude-code',
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT,
        vclock_json   TEXT NOT NULL,
        deleted_at    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project
        ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON sessions(status) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 2,
    name: "create_events",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        parent_event_id TEXT REFERENCES events(id),
        sequence        INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        actor           TEXT NOT NULL,

        prompt_text     TEXT,
        cot_text        TEXT,
        response_text   TEXT,

        tool_name       TEXT,
        tool_input_json TEXT,
        tool_output_json TEXT,

        checkpoint_sha  TEXT,
        checkpoint_ref  TEXT,
        diff_stat_json  TEXT,

        git_branch      TEXT,
        git_head_sha    TEXT,
        env_snapshot_id TEXT,

        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        status          TEXT NOT NULL DEFAULT 'running',
        error_json      TEXT,
        labels_json     TEXT,
        plan_task_id    TEXT,

        vclock_json     TEXT NOT NULL,
        deleted_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(event_type) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_events_checkpoint
        ON events(checkpoint_sha) WHERE checkpoint_sha IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_actor
        ON events(actor) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 3,
    name: "create_env_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS env_snapshots (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        git_branch      TEXT NOT NULL,
        git_head_sha    TEXT NOT NULL,
        modified_files  TEXT,
        dep_lock_hash   TEXT,
        dep_lock_path   TEXT,
        env_vars_json   TEXT,
        node_version    TEXT,
        python_version  TEXT,
        os_info         TEXT,
        captured_at     TEXT NOT NULL,
        vclock_json     TEXT NOT NULL,
        deleted_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_env_session
        ON env_snapshots(session_id);
    `,
  },
  {
    id: 4,
    name: "create_plans",
    sql: `
      CREATE TABLE IF NOT EXISTS plans (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        plan_type       TEXT NOT NULL,
        parent_plan_id  TEXT REFERENCES plans(id),
        title           TEXT NOT NULL,
        content_md      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'draft',
        created_at      TEXT NOT NULL,
        updated_at      TEXT,
        vclock_json     TEXT NOT NULL,
        deleted_at      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_plans_project
        ON plans(project_id);
      CREATE INDEX IF NOT EXISTS idx_plans_type
        ON plans(plan_type) WHERE deleted_at IS NULL;
    `,
  },
  {
    id: 5,
    name: "create_diffs",
    sql: `
      CREATE TABLE IF NOT EXISTS diffs (
        id          TEXT PRIMARY KEY,
        event_id    TEXT NOT NULL REFERENCES events(id),
        diff_text   TEXT NOT NULL,
        file_filter TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_diffs_event
        ON diffs(event_id);
    `,
  },
  {
    id: 6,
    name: "add_env_snapshot_enrichment",
    sql: `
      ALTER TABLE env_snapshots ADD COLUMN container_info TEXT;
      ALTER TABLE env_snapshots ADD COLUMN runtime_versions_json TEXT;
      ALTER TABLE env_snapshots ADD COLUMN shell_info TEXT;
      ALTER TABLE env_snapshots ADD COLUMN system_resources_json TEXT;
      ALTER TABLE env_snapshots ADD COLUMN package_manager_json TEXT;
    `,
  },
  {
    id: 7,
    name: "create_sync_state",
    sql: `
      CREATE TABLE IF NOT EXISTS sync_state (
        server_url            TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        last_synced_event_id  TEXT,
        last_synced_at        TEXT,
        sync_version          INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

const db = require('../db');

const initDatabase = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      team_id TEXT,
      permissions TEXT NOT NULL DEFAULT '["admin"]',
      allowed_team_ids TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      grace_period_until INTEGER,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_app_id ON api_keys(app_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      audio_url TEXT NOT NULL,
      meeting_name TEXT NOT NULL,
      team_id TEXT,
      callback_url TEXT,
      backup_callback_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error_message TEXT,
      callback_status TEXT,
      callback_attempts INTEGER DEFAULT 0,
      callback_failure_reason TEXT,
      last_callback_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_app_id ON tasks(app_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

    CREATE TABLE IF NOT EXISTS callback_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      url TEXT NOT NULL,
      payload TEXT,
      status_code INTEGER,
      response_body TEXT,
      failure_reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      next_retry_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_callback_logs_task_id ON callback_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_callback_logs_next_retry ON callback_logs(next_retry_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      key_id TEXT,
      key_prefix TEXT,
      app_name TEXT,
      action TEXT NOT NULL,
      task_id TEXT,
      detail TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_task_id ON audit_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_app_id ON audit_logs(app_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      speaker_label TEXT NOT NULL,
      display_name TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_participants_task_id ON participants(task_id);

    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      speaker_label TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      text_content TEXT NOT NULL,
      confidence REAL DEFAULT 0.0,
      original_speaker_label TEXT,
      merged_from TEXT,
      corrected_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_segments_task_id ON segments(task_id);
    CREATE INDEX IF NOT EXISTS idx_segments_speaker ON segments(task_id, speaker_label);

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      segment_id INTEGER,
      feedback_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      team_id TEXT,
      created_at INTEGER NOT NULL,
      applied INTEGER DEFAULT 0,
      metadata TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_task_id ON feedback(task_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_team_type ON feedback(team_id, feedback_type);
  `);
};

module.exports = initDatabase;

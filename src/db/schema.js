const db = require('../db');

const initDatabase = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      audio_url TEXT NOT NULL,
      meeting_name TEXT NOT NULL,
      team_id TEXT,
      callback_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id);

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

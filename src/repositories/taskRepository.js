const db = require('../db');

const TaskStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

const createTask = ({ id, audioUrl, meetingName, teamId, callbackUrl, createdAt }) => {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, audio_url, meeting_name, team_id, callback_url, status, created_at)
    VALUES (@id, @audioUrl, @meetingName, @teamId, @callbackUrl, @status, @createdAt)
  `);
  stmt.run({
    id,
    audioUrl,
    meetingName,
    teamId: teamId || null,
    callbackUrl: callbackUrl || null,
    status: TaskStatus.PENDING,
    createdAt
  });
  return getTaskById(id);
};

const getTaskById = (id) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!row) return null;
  return mapRow(row);
};

const mapRow = (row) => ({
  id: row.id,
  audioUrl: row.audio_url,
  meetingName: row.meeting_name,
  teamId: row.team_id,
  callbackUrl: row.callback_url,
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  errorMessage: row.error_message
});

const updateTaskStatus = (id, status, extra = {}) => {
  const fields = ['status = ?'];
  const params = [status];

  if (extra.startedAt !== undefined) {
    fields.push('started_at = ?');
    params.push(extra.startedAt);
  }
  if (extra.completedAt !== undefined) {
    fields.push('completed_at = ?');
    params.push(extra.completedAt);
  }
  if (extra.errorMessage !== undefined) {
    fields.push('error_message = ?');
    params.push(extra.errorMessage);
  }

  params.push(id);
  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...params);
  return result.changes > 0;
};

const getTasksByTeamId = (teamId, limit = 20, offset = 0) => {
  const rows = db.prepare(`
    SELECT * FROM tasks WHERE team_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(teamId, limit, offset);
  return rows.map(mapRow);
};

module.exports = {
  TaskStatus,
  createTask,
  getTaskById,
  updateTaskStatus,
  getTasksByTeamId
};

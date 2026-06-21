const db = require('../db');

const TaskStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

const createTask = ({ id, appId, audioUrl, meetingName, teamId, callbackUrl, createdAt }) => {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, app_id, audio_url, meeting_name, team_id, callback_url, status, created_at)
    VALUES (@id, @appId, @audioUrl, @meetingName, @teamId, @callbackUrl, @status, @createdAt)
  `);
  stmt.run({
    id,
    appId,
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

const getTaskByIdAndAppId = (id, appId) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND app_id = ?').get(id, appId);
  if (!row) return null;
  return mapRow(row);
};

const mapRow = (row) => ({
  id: row.id,
  appId: row.app_id,
  audioUrl: row.audio_url,
  meetingName: row.meeting_name,
  teamId: row.team_id,
  callbackUrl: row.callback_url,
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  errorMessage: row.error_message,
  callbackStatus: row.callback_status,
  callbackAttempts: row.callback_attempts,
  lastCallbackAt: row.last_callback_at
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
  if (extra.callbackStatus !== undefined) {
    fields.push('callback_status = ?');
    params.push(extra.callbackStatus);
  }
  if (extra.callbackAttempts !== undefined) {
    fields.push('callback_attempts = ?');
    params.push(extra.callbackAttempts);
  }
  if (extra.lastCallbackAt !== undefined) {
    fields.push('last_callback_at = ?');
    params.push(extra.lastCallbackAt);
  }

  params.push(id);
  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...params);
  return result.changes > 0;
};

const queryTasks = ({ appId, teamId, allowedTeamIds, status, startTime, endTime, limit = 20, offset = 0 }) => {
  const conditions = ['t.app_id = ?'];
  const params = [appId];

  if (teamId) {
    conditions.push('t.team_id = ?');
    params.push(teamId);
  } else if (Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0) {
    const placeholders = allowedTeamIds.map(() => '?').join(',');
    conditions.push(`t.team_id IN (${placeholders})`);
    params.push(...allowedTeamIds);
  }
  if (status) {
    conditions.push('t.status = ?');
    params.push(status);
  }
  if (startTime) {
    conditions.push('t.created_at >= ?');
    params.push(startTime);
  }
  if (endTime) {
    conditions.push('t.created_at <= ?');
    params.push(endTime);
  }

  const where = conditions.join(' AND ');

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM tasks t WHERE ${where}`).get(...params);
  const total = countRow.total;

  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM segments s WHERE s.task_id = t.id) as segment_count
    FROM tasks t
    WHERE ${where}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const tasks = rows.map((r) => ({
    ...mapRow(r),
    segmentCount: r.segment_count
  }));

  return { tasks, total, limit, offset };
};

const getTasksByTeamId = (teamId, appId, limit = 20, offset = 0) => {
  return queryTasks({ appId, teamId, limit, offset });
};

module.exports = {
  TaskStatus,
  createTask,
  getTaskById,
  getTaskByIdAndAppId,
  updateTaskStatus,
  queryTasks,
  getTasksByTeamId
};

const db = require('../db');

const TaskStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

const createTask = ({ id, appId, audioUrl, meetingName, teamId, callbackUrl, backupCallbackUrl, createdAt }) => {
  const now = createdAt || Date.now();
  const stmt = db.prepare(`
    INSERT INTO tasks (id, app_id, audio_url, meeting_name, team_id, callback_url, backup_callback_url, status, created_at, updated_at)
    VALUES (@id, @appId, @audioUrl, @meetingName, @teamId, @callbackUrl, @backupCallbackUrl, @status, @createdAt, @updatedAt)
  `);
  stmt.run({
    id,
    appId,
    audioUrl,
    meetingName,
    teamId: teamId || null,
    callbackUrl: callbackUrl || null,
    backupCallbackUrl: backupCallbackUrl || null,
    status: TaskStatus.PENDING,
    createdAt: now,
    updatedAt: now
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
  backupCallbackUrl: row.backup_callback_url,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  errorMessage: row.error_message,
  callbackStatus: row.callback_status,
  callbackAttempts: row.callback_attempts,
  callbackFailureReason: row.callback_failure_reason,
  lastCallbackAt: row.last_callback_at
});

const updateTaskStatus = (id, status, extra = {}) => {
  const fields = ['status = ?', 'updated_at = ?'];
  const params = [status, Date.now()];

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
  if (extra.callbackFailureReason !== undefined) {
    fields.push('callback_failure_reason = ?');
    params.push(extra.callbackFailureReason);
  }

  params.push(id);
  const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...params);
  return result.changes > 0;
};

const queryTasks = ({ appId, teamId, allowedTeamIds, status, since, updatedSince, limit = 20, cursor = null }) => {
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
  if (since) {
    conditions.push('t.created_at >= ?');
    params.push(since);
  }
  if (updatedSince) {
    conditions.push('t.updated_at >= ?');
    params.push(updatedSince);
  }
  if (cursor) {
    const [cursorTs, cursorId] = decodeCursor(cursor);
    if (cursorTs && cursorId) {
      conditions.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))');
      params.push(cursorTs, cursorTs, cursorId);
    }
  }

  const where = conditions.join(' AND ');

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM tasks t WHERE ${where}`).get(...params);
  const total = countRow.total;

  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM segments s WHERE s.task_id = t.id) as segment_count
    FROM tasks t
    WHERE ${where}
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ?
  `).all(...params, limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  const tasks = resultRows.map((r) => ({
    ...mapRow(r),
    segmentCount: r.segment_count
  }));

  let nextCursor = null;
  if (hasMore && tasks.length > 0) {
    const last = tasks[tasks.length - 1];
    nextCursor = encodeCursor(last.updatedAt, last.id);
  }

  return { tasks, total, limit, nextCursor, hasMore };
};

const encodeCursor = (updatedAt, taskId) => {
  return Buffer.from(`${updatedAt}_${taskId}`, 'utf8').toString('base64');
};

const decodeCursor = (cursor) => {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = decoded.split('_');
    if (parts.length >= 2) {
      const ts = parseInt(parts[0], 10);
      const id = parts.slice(1).join('_');
      return [ts, id];
    }
    return [null, null];
  } catch (_) {
    return [null, null];
  }
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
  getTasksByTeamId,
  encodeCursor,
  decodeCursor
};

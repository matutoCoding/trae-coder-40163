const db = require('../db');

const createCallbackLog = ({ taskId, url, payload, statusCode, responseBody, attempt, createdAt, nextRetryAt }) => {
  const stmt = db.prepare(`
    INSERT INTO callback_logs (task_id, url, payload, status_code, response_body, attempt, created_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    taskId, url, payload || null, statusCode || null, responseBody || null,
    attempt || 1, createdAt, nextRetryAt || null
  );
  return info.lastInsertRowid;
};

const getCallbackLogsByTaskId = (taskId) => {
  const rows = db.prepare(`
    SELECT * FROM callback_logs WHERE task_id = ?
    ORDER BY created_at DESC LIMIT 10
  `).all(taskId);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    url: r.url,
    payload: r.payload,
    statusCode: r.status_code,
    responseBody: r.response_body,
    attempt: r.attempt,
    createdAt: r.created_at,
    nextRetryAt: r.next_retry_at
  }));
};

const getPendingRetries = (beforeTs) => {
  const rows = db.prepare(`
    SELECT * FROM callback_logs
    WHERE next_retry_at IS NOT NULL AND next_retry_at <= ?
    ORDER BY next_retry_at ASC LIMIT 50
  `).all(beforeTs);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    url: r.url,
    payload: r.payload,
    attempt: r.attempt,
    createdAt: r.created_at,
    nextRetryAt: r.next_retry_at
  }));
};

const clearNextRetry = (id) => {
  db.prepare('UPDATE callback_logs SET next_retry_at = NULL WHERE id = ?').run(id);
};

module.exports = {
  createCallbackLog,
  getCallbackLogsByTaskId,
  getPendingRetries,
  clearNextRetry
};

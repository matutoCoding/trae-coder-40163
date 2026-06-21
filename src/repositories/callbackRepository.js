const db = require('../db');

const createCallbackLog = ({ taskId, url, payload, statusCode, responseBody, failureReason, attempt, createdAt, nextRetryAt }) => {
  const stmt = db.prepare(`
    INSERT INTO callback_logs (task_id, url, payload, status_code, response_body, failure_reason, attempt, created_at, next_retry_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    taskId, url, payload || null, statusCode || null, responseBody || null,
    failureReason || null, attempt || 1, createdAt, nextRetryAt || null
  );
  return info.lastInsertRowid;
};

const getCallbackLogsByTaskId = (taskId, limit = 50) => {
  const rows = db.prepare(`
    SELECT * FROM callback_logs WHERE task_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(taskId, limit);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    url: r.url,
    payload: r.payload,
    statusCode: r.status_code,
    responseBody: r.response_body,
    failureReason: r.failure_reason,
    attempt: r.attempt,
    createdAt: r.created_at,
    nextRetryAt: r.next_retry_at
  }));
};

const getLatestFailedLog = (taskId) => {
  const row = db.prepare(`
    SELECT * FROM callback_logs
    WHERE task_id = ? AND (status_code IS NULL OR status_code < 200 OR status_code >= 300)
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId);
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    url: row.url,
    payload: row.payload,
    statusCode: row.status_code,
    responseBody: row.response_body,
    failureReason: row.failure_reason,
    attempt: row.attempt,
    createdAt: row.created_at,
    nextRetryAt: row.next_retry_at
  };
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
  getLatestFailedLog,
  getPendingRetries,
  clearNextRetry
};

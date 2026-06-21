const db = require('../db');

const createAuditLog = ({ appId, keyId, keyPrefix, appName, action, taskId, detail, ipAddress }) => {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (app_id, key_id, key_prefix, app_name, action, task_id, detail, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(appId, keyId || null, keyPrefix || null, appName || null, action, taskId || null, detail || null, ipAddress || null, Date.now());
};

const queryAuditLogs = ({ appId, taskId, action, startTime, endTime, limit = 50, offset = 0 }) => {
  const conditions = [];
  const params = [];

  if (appId) {
    conditions.push('a.app_id = ?');
    params.push(appId);
  }
  if (taskId) {
    conditions.push('a.task_id = ?');
    params.push(taskId);
  }
  if (action) {
    conditions.push('a.action = ?');
    params.push(action);
  }
  if (startTime) {
    conditions.push('a.created_at >= ?');
    params.push(startTime);
  }
  if (endTime) {
    conditions.push('a.created_at <= ?');
    params.push(endTime);
  }

  const where = conditions.length ? conditions.join(' AND ') : '1=1';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM audit_logs a WHERE ${where}`).get(...params);
  const total = countRow.total;

  const rows = db.prepare(`
    SELECT a.* FROM audit_logs a
    WHERE ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    logs: rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      keyId: r.key_id,
      keyPrefix: r.key_prefix,
      appName: r.app_name,
      action: r.action,
      taskId: r.task_id,
      detail: r.detail,
      ipAddress: r.ip_address,
      createdAt: r.created_at
    })),
    total,
    limit,
    offset
  };
};

module.exports = {
  createAuditLog,
  queryAuditLogs
};

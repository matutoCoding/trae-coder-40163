const db = require('../db');

const DEFAULT_QUOTA = {
  'task.submit': 1000,
  'task.query': 10000,
  'task.batch_query': 500,
  'feedback.submit': 1000,
  'callback.retry': 100,
  'api_key.create': 10,
  'api_key.update': 50,
  'api_key.revoke': 50,
  'api_key.rotate': 10
};

const ACTION_TYPES = Object.keys(DEFAULT_QUOTA);

const getTodayStr = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const getMidnightUTC = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
};

const parseQuota = (row) => {
  if (!row || !row.daily_quota) return { ...DEFAULT_QUOTA };
  try {
    const parsed = JSON.parse(row.daily_quota);
    return { ...DEFAULT_QUOTA, ...parsed };
  } catch (_) {
    return { ...DEFAULT_QUOTA };
  }
};

const recordUsage = ({ appId, keyId, teamId, action }) => {
  const date = getTodayStr();
  const stmt = db.prepare(`
    INSERT INTO quota_daily (app_id, key_id, team_id, date, action, count)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(app_id, key_id, team_id, date, action) DO UPDATE SET count = count + 1
  `);
  stmt.run(appId, keyId, teamId || null, date, action);
};

const getTodayUsage = ({ appId, keyId, teamId, action }) => {
  const date = getTodayStr();
  const row = db.prepare(`
    SELECT SUM(count) as total FROM quota_daily
    WHERE app_id = ? AND action = ? AND date = ?
      AND (? IS NULL OR key_id = ?)
      AND (? IS NULL OR team_id = ?)
  `).get(appId, action, date, keyId, keyId, teamId, teamId);
  return (row && row.total) || 0;
};

const checkQuota = (keyRow, action) => {
  if (!ACTION_TYPES.includes(action)) return { allowed: true };

  const quota = parseQuota(keyRow);
  const limit = quota[action] ?? DEFAULT_QUOTA[action] ?? 9999999;

  const used = getTodayUsage({ appId: keyRow.app_id, keyId: keyRow.id, action });

  if (used >= limit) {
    return {
      allowed: false,
      limit,
      used,
      remaining: 0,
      resetAt: getMidnightUTC(),
      action
    };
  }

  return {
    allowed: true,
    limit,
    used,
    remaining: limit - used,
    resetAt: getMidnightUTC()
  };
};

const getUsageStats = ({ appId, keyId, teamId, startDate, endDate }) => {
  const conditions = ['app_id = ?'];
  const params = [appId];

  if (keyId) {
    conditions.push('key_id = ?');
    params.push(keyId);
  }
  if (teamId) {
    conditions.push('team_id = ?');
    params.push(teamId);
  }
  if (startDate) {
    conditions.push('date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('date <= ?');
    params.push(endDate);
  }

  const where = conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT date, action, SUM(count) as total
    FROM quota_daily
    WHERE ${where}
    GROUP BY date, action
    ORDER BY date DESC, action
  `).all(...params);

  const byDate = new Map();
  const totals = {};

  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)[r.action] = r.total;
    totals[r.action] = (totals[r.action] || 0) + r.total;
  }

  const keyRows = keyId
    ? []
    : db.prepare(`
        SELECT id, key_prefix, app_name FROM api_keys WHERE app_id = ? AND is_active = 1
      `).all(appId);

  const perKey = [];
  if (!keyId) {
    for (const kr of keyRows) {
      const krows = db.prepare(`
        SELECT action, SUM(count) as total FROM quota_daily
        WHERE app_id = ? AND key_id = ?
          ${startDate ? 'AND date >= ?' : ''}
          ${endDate ? 'AND date <= ?' : ''}
        GROUP BY action
      `).all(appId, kr.id, ...(startDate ? [startDate] : []), ...(endDate ? [endDate] : []));
      const keyTotals = {};
      for (const r of krows) keyTotals[r.action] = r.total;
      perKey.push({
        keyId: kr.id,
        keyPrefix: kr.key_prefix,
        appName: kr.app_name,
        usage: keyTotals
      });
    }
  }

  return {
    totals,
    byDate: Object.fromEntries(byDate.entries()),
    perKey,
    period: {
      startDate: startDate || null,
      endDate: endDate || getTodayStr()
    }
  };
};

module.exports = {
  DEFAULT_QUOTA,
  ACTION_TYPES,
  recordUsage,
  getTodayUsage,
  checkQuota,
  getUsageStats,
  parseQuota,
  getTodayStr
};

const db = require('../db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const ALL_PERMISSIONS = ['admin', 'tasks:write', 'tasks:read', 'feedback:write'];

const normalizePermissions = (permissions) => {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return ['tasks:read'];
  }
  const uniq = [...new Set(permissions.filter((p) => typeof p === 'string'))];
  const filtered = uniq.filter((p) => ALL_PERMISSIONS.includes(p));
  return filtered.length ? filtered : ['tasks:read'];
};

const normalizeTeamIds = (teamIds) => {
  if (!Array.isArray(teamIds)) return null;
  const filtered = teamIds.filter((t) => typeof t === 'string' && t.trim().length > 0);
  return filtered.length ? filtered : null;
};

const parsePerms = (row) => {
  try {
    const arr = JSON.parse(row.permissions || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
};

const parseTeams = (row) => {
  if (!row.allowed_team_ids) return null;
  try {
    const arr = JSON.parse(row.allowed_team_ids);
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
};

const computeKeyStatus = (row) => {
  if (row.is_active !== 1) {
    if (row.grace_period_until && row.grace_period_until > Date.now()) return 'grace';
    return 'revoked';
  }
  return 'effective';
};

const maskKeyRow = (row) => ({
  id: row.id,
  appId: row.app_id,
  appName: row.app_name,
  keyPrefix: row.key_prefix,
  teamId: row.team_id,
  permissions: parsePerms(row),
  allowedTeamIds: parseTeams(row),
  isActive: row.is_active === 1,
  status: computeKeyStatus(row),
  gracePeriodUntil: row.grace_period_until || null,
  createdAt: row.created_at,
  revokedAt: row.revoked_at
});

const generateApiKey = (appName, teamId = null, options = {}) => {
  const rawKey = `vts_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);
  const appId = options.appId || `app_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const id = uuidv4();
  const createdAt = Date.now();
  const permissions = normalizePermissions(options.permissions);
  const allowedTeamIds = normalizeTeamIds(options.allowedTeamIds);
  const gracePeriodUntil = options.gracePeriodMinutes
    ? createdAt + options.gracePeriodMinutes * 60 * 1000
    : null;

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, app_id, app_name, key_hash, key_prefix, team_id, permissions, allowed_team_ids, is_active, grace_period_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  stmt.run(
    id,
    appId,
    appName,
    keyHash,
    keyPrefix,
    teamId || null,
    JSON.stringify(permissions),
    allowedTeamIds ? JSON.stringify(allowedTeamIds) : null,
    gracePeriodUntil,
    createdAt
  );

  return {
    id,
    appId,
    appName,
    apiKey: rawKey,
    keyPrefix,
    teamId: teamId || null,
    permissions,
    allowedTeamIds,
    gracePeriodUntil,
    createdAt
  };
};

const hashKey = (key) => {
  return crypto.createHash('sha256').update(key).digest('hex');
};

const validateKey = (rawKey) => {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const keyHash = hashKey(rawKey);
  const row = db.prepare(`
    SELECT id, app_id, app_name, key_prefix, team_id, permissions, allowed_team_ids, is_active, grace_period_until
    FROM api_keys WHERE key_hash = ?
  `).get(keyHash);
  if (!row) return null;

  if (row.is_active !== 1) {
    if (row.grace_period_until && row.grace_period_until > Date.now()) {
      // grace period: still valid
    } else {
      return null;
    }
  }

  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    keyPrefix: row.key_prefix,
    teamId: row.team_id,
    permissions: parsePerms(row),
    allowedTeamIds: parseTeams(row)
  };
};

const getKeyById = (id) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  return row ? maskKeyRow(row) : null;
};

const getKeysByAppId = (appId) => {
  const rows = db.prepare(`
    SELECT * FROM api_keys WHERE app_id = ? ORDER BY created_at DESC
  `).all(appId);
  return rows.map(maskKeyRow);
};

const revokeKey = (id) => {
  const result = db.prepare(`
    UPDATE api_keys SET is_active = 0, revoked_at = ?, grace_period_until = NULL WHERE id = ?
  `).run(Date.now(), id);
  return result.changes > 0;
};

const setKeyGracePeriod = (id, gracePeriodMinutes) => {
  const until = Date.now() + gracePeriodMinutes * 60 * 1000;
  db.prepare(`
    UPDATE api_keys SET grace_period_until = ? WHERE id = ?
  `).run(until, id);
  return getKeyById(id);
};

const rotateKey = (oldKeyId, gracePeriodMinutes = 60) => {
  const oldKey = getKeyById(oldKeyId);
  if (!oldKey) return null;

  const newKey = generateApiKey(oldKey.appName, oldKey.teamId, {
    appId: oldKey.appId,
    permissions: oldKey.permissions,
    allowedTeamIds: oldKey.allowedTeamIds
  });

  db.prepare(`
    UPDATE api_keys SET is_active = 0, grace_period_until = ? WHERE id = ?
  `).run(Date.now() + gracePeriodMinutes * 60 * 1000, oldKeyId);

  return { oldKey: getKeyById(oldKeyId), newKey };
};

const updateKey = (id, updates = {}) => {
  const existing = getKeyById(id);
  if (!existing) return null;

  const fields = [];
  const params = [];

  if (updates.appName !== undefined) {
    fields.push('app_name = ?');
    params.push(updates.appName);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    params.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.allowedTeamIds !== undefined) {
    const arr = normalizeTeamIds(updates.allowedTeamIds);
    fields.push('allowed_team_ids = ?');
    params.push(arr ? JSON.stringify(arr) : null);
  }

  if (!fields.length) return existing;

  params.push(id);
  db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getKeyById(id);
};

const TEST_APP_ID = 'app_test_default';
const TEST_API_KEY = 'vts_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ensureTestKey = () => {
  const keyHash = hashKey(TEST_API_KEY);
  const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (existing) return;
  db.prepare(`
    INSERT INTO api_keys (id, app_id, app_name, key_hash, key_prefix, team_id, permissions, allowed_team_ids, is_active, grace_period_until, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 1, NULL, ?)
  `).run(
    'test-key-id',
    TEST_APP_ID,
    'Test App',
    keyHash,
    TEST_API_KEY.slice(0, 8),
    JSON.stringify(['admin', 'tasks:write', 'tasks:read', 'feedback:write']),
    Date.now()
  );
};

module.exports = {
  generateApiKey,
  validateKey,
  getKeyById,
  getKeysByAppId,
  revokeKey,
  updateKey,
  setKeyGracePeriod,
  rotateKey,
  ensureTestKey,
  TEST_APP_ID,
  TEST_API_KEY,
  ALL_PERMISSIONS
};

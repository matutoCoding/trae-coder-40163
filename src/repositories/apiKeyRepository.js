const db = require('../db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const generateApiKey = (appName, teamId = null) => {
  const rawKey = `vts_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);
  const appId = `app_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const id = uuidv4();
  const createdAt = Date.now();

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, app_id, app_name, key_hash, key_prefix, team_id, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  stmt.run(id, appId, appName, keyHash, keyPrefix, teamId || null, createdAt);

  return {
    id,
    appId,
    appName,
    apiKey: rawKey,
    keyPrefix,
    teamId: teamId || null,
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
    SELECT id, app_id, app_name, key_prefix, team_id, is_active
    FROM api_keys WHERE key_hash = ? AND is_active = 1
  `).get(keyHash);
  if (!row) return null;
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name,
    keyPrefix: row.key_prefix,
    teamId: row.team_id
  };
};

const revokeKey = (id) => {
  const result = db.prepare(`
    UPDATE api_keys SET is_active = 0, revoked_at = ? WHERE id = ?
  `).run(Date.now(), id);
  return result.changes > 0;
};

const getKeysByAppId = (appId) => {
  const rows = db.prepare(`
    SELECT id, app_id, app_name, key_prefix, team_id, is_active, created_at, revoked_at
    FROM api_keys WHERE app_id = ?
    ORDER BY created_at DESC
  `).all(appId);
  return rows.map((r) => ({
    id: r.id,
    appId: r.app_id,
    appName: r.app_name,
    keyPrefix: r.key_prefix,
    teamId: r.team_id,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    revokedAt: r.revoked_at
  }));
};

const TEST_APP_ID = 'app_test_default';
const TEST_API_KEY = 'vts_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ensureTestKey = () => {
  const keyHash = hashKey(TEST_API_KEY);
  const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (existing) return;
  db.prepare(`
    INSERT INTO api_keys (id, app_id, app_name, key_hash, key_prefix, team_id, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, ?)
  `).run('test-key-id', TEST_APP_ID, 'Test App', keyHash, TEST_API_KEY.slice(0, 8), Date.now());
};

module.exports = {
  generateApiKey,
  validateKey,
  revokeKey,
  getKeysByAppId,
  ensureTestKey,
  TEST_APP_ID,
  TEST_API_KEY
};

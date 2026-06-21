const { validateKey, ensureTestKey, TEST_APP_ID, TEST_API_KEY } = require('../repositories/apiKeyRepository');
const { createAuditLog } = require('../repositories/auditLogRepository');

const TEST_KEY_INFO = {
  id: 'test-key-id',
  appId: TEST_APP_ID,
  appName: 'Test App',
  keyPrefix: TEST_API_KEY.slice(0, 8),
  teamId: null,
  permissions: ['admin', 'tasks:write', 'tasks:read', 'feedback:write'],
  allowedTeamIds: null
};

const authMiddleware = (req, res, next) => {
  let keyInfo = null;

  if (process.env.NODE_ENV === 'test') {
    ensureTestKey();
    keyInfo = TEST_KEY_INFO;
  } else {
    const authHeader = req.headers['authorization'];
    let apiKey = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7).trim();
    }
    if (!apiKey) {
      apiKey = req.headers['x-api-key'];
    }
    if (!apiKey) {
      return res.status(401).json({
        code: 'MISSING_API_KEY',
        message: '缺少 API Key，请在 Authorization: Bearer <key> 或 X-API-Key 头中提供'
      });
    }

    keyInfo = validateKey(apiKey);
    if (!keyInfo) {
      return res.status(401).json({
        code: 'INVALID_API_KEY',
        message: 'API Key 无效或已吊销'
      });
    }
  }

  req.apiKeyId = keyInfo.id;
  req.appId = keyInfo.appId;
  req.keyInfo = keyInfo;
  req.permissions = keyInfo.permissions;
  req.allowedTeamIds = keyInfo.allowedTeamIds;

  req.audit = (action, taskId, detail) => {
    createAuditLog({
      appId: keyInfo.appId,
      keyId: keyInfo.id,
      keyPrefix: keyInfo.keyPrefix,
      appName: keyInfo.appName,
      action,
      taskId: taskId || null,
      detail: detail || null,
      ipAddress: req.ip || null
    });
  };

  next();
};

const requirePermission = (...perms) => {
  return (req, res, next) => {
    const has = req.permissions || [];
    if (has.includes('admin')) return next();
    for (const p of perms) {
      if (!has.includes(p)) {
        return res.status(403).json({
          code: 'PERMISSION_DENIED',
          message: `当前 API Key 缺少 ${perms.join(' / ')} 权限`
        });
      }
    }
    next();
  };
};

const checkTeamAllowed = (req, teamId) => {
  const allowed = req.allowedTeamIds;
  if (!allowed || allowed.length === 0) return null;
  if (!teamId) return null;
  if (allowed.includes(teamId)) return null;
  return {
    httpStatus: 403,
    code: 'TEAM_NOT_ALLOWED',
    message: `当前 API Key 无权访问团队 '${teamId}'`
  };
};

const isTeamAllowed = (req, teamId) => {
  const allowed = req.allowedTeamIds;
  if (!allowed || allowed.length === 0) return true;
  if (!teamId) return true;
  return allowed.includes(teamId);
};

module.exports = {
  authMiddleware,
  requirePermission,
  checkTeamAllowed,
  isTeamAllowed,
  default: authMiddleware
};

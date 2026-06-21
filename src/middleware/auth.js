const { validateKey, ensureTestKey, TEST_APP_ID, TEST_API_KEY, getRawKeyById } = require('../repositories/apiKeyRepository');
const { createAuditLog } = require('../repositories/auditLogRepository');
const { recordUsage, checkQuota, ACTION_TYPES } = require('../repositories/usageRepository');

const TEST_KEY_INFO = {
  id: 'test-key-id',
  appId: TEST_APP_ID,
  appName: 'Test App',
  keyPrefix: TEST_API_KEY.slice(0, 8),
  teamId: null,
  permissions: ['admin', 'tasks:write', 'tasks:read', 'feedback:write'],
  allowedTeamIds: null
};

const mapPathToAction = (method, path) => {
  if (path === '/health') return null;
  if (path.startsWith('/api-keys')) return null;

  if (path === '/tasks/batch' && method === 'POST') return 'task.batch_query';
  if (path === '/tasks' && method === 'POST') return 'task.submit';
  if (path === '/tasks' && method === 'GET') return 'task.query';
  if (path.match(/^\/tasks\/[^/]+$/) && method === 'GET') return 'task.query';
  if (path.match(/^\/tasks\/[^/]+\/callbacks$/) && method === 'GET') return 'task.query';
  if (path.match(/^\/tasks\/[^/]+\/callbacks\/retry$/) && method === 'POST') return 'callback.retry';
  if (path.match(/^\/tasks\/[^/]+\/feedback$/) && method === 'POST') return 'feedback.submit';
  if (path.startsWith('/teams') && method === 'GET') return 'task.query';
  if (path.startsWith('/audit') && method === 'GET') return null;
  if (path.startsWith('/usage') && method === 'GET') return null;
  return null;
};

const authMiddleware = (req, res, next) => {
  let keyInfo = null;
  let rawKeyRow = null;

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

  rawKeyRow = rawKeyRow || getRawKeyById(keyInfo.id);

  const action = mapPathToAction(req.method, req.path);
  if (process.env.NODE_ENV !== 'test' && action && ACTION_TYPES.includes(action) && rawKeyRow) {
    const quotaCheck = checkQuota(rawKeyRow, action);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        code: 'QUOTA_EXCEEDED',
        message: `今日 '${action}' 配额已用完（${quotaCheck.used}/${quotaCheck.limit}）`,
        data: {
          action,
          limit: quotaCheck.limit,
          used: quotaCheck.used,
          remaining: quotaCheck.remaining,
          resetAt: quotaCheck.resetAt
        }
      });
    }
    req.quotaInfo = quotaCheck;
  }

  req.apiKeyId = keyInfo.id;
  req.appId = keyInfo.appId;
  req.keyInfo = keyInfo;
  req.permissions = keyInfo.permissions;
  req.allowedTeamIds = keyInfo.allowedTeamIds;

  req.audit = (a, taskId, detail) => {
    createAuditLog({
      appId: keyInfo.appId,
      keyId: keyInfo.id,
      keyPrefix: keyInfo.keyPrefix,
      appName: keyInfo.appName,
      action: a,
      taskId: taskId || null,
      detail: detail || null,
      ipAddress: req.ip || null
    });
  };

  req.recordUsage = (a, teamId) => {
    if (!a || !ACTION_TYPES.includes(a)) return;
    recordUsage({
      appId: keyInfo.appId,
      keyId: keyInfo.id,
      teamId: teamId || null,
      action: a
    });
  };

  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    if (res.statusCode >= 200 && res.statusCode < 300 && action) {
      const tid = res.locals && res.locals.taskIdForUsage;
      recordUsage({
        appId: keyInfo.appId,
        keyId: keyInfo.id,
        teamId: tid ? null : (req.body && req.body.teamId ? req.body.teamId : null),
        action
      });
    }
  });

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
  mapPathToAction,
  default: authMiddleware
};

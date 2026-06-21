const { validateKey, ensureTestKey, TEST_APP_ID } = require('../repositories/apiKeyRepository');

const authMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV === 'test') {
    ensureTestKey();
    req.appId = TEST_APP_ID;
    return next();
  }

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

  const keyInfo = validateKey(apiKey);
  if (!keyInfo) {
    return res.status(401).json({
      code: 'INVALID_API_KEY',
      message: 'API Key 无效或已吊销'
    });
  }

  req.appId = keyInfo.appId;
  next();
};

module.exports = authMiddleware;

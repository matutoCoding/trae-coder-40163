const resetTestDb = () => {
  const db = require('../src/db');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS callback_logs;
    DROP TABLE IF EXISTS feedback;
    DROP TABLE IF EXISTS segments;
    DROP TABLE IF EXISTS participants;
    DROP TABLE IF EXISTS tasks;
    DROP TABLE IF EXISTS api_keys;
  `);
  db.pragma('foreign_keys = ON');

  const initDatabase = require('../src/db/schema');
  initDatabase();

  const modules = [
    '../src/repositories/taskRepository',
    '../src/repositories/participantRepository',
    '../src/repositories/segmentRepository',
    '../src/repositories/feedbackRepository',
    '../src/repositories/apiKeyRepository',
    '../src/repositories/callbackRepository',
    '../src/repositories/auditLogRepository',
    '../src/services/taskService',
    '../src/middleware/auth',
    '../src/app'
  ];
  for (const m of modules) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { resetTestDb, sleep };

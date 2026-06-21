const fs = require('fs');
const path = require('path');

const resetTestDb = () => {
  const dbPath = path.join(__dirname, '..', '..', 'data', 'test.db');
  const shmPath = dbPath + '-shm';
  const walPath = dbPath + '-wal';
  for (const p of [dbPath, shmPath, walPath]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
  }
  try { delete require.cache[require.resolve('../src/db')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/repositories/taskRepository')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/repositories/participantRepository')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/repositories/segmentRepository')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/repositories/feedbackRepository')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/services/taskService')]; } catch (_) {}
  try { delete require.cache[require.resolve('../src/app')]; } catch (_) {}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { resetTestDb, sleep };

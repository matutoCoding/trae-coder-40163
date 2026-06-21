const path = require('path');
const Database = require('better-sqlite3');

const isTest = process.env.NODE_ENV === 'test';
const dbPath = isTest
  ? path.join(__dirname, '..', '..', 'data', 'test.db')
  : path.join(__dirname, '..', '..', 'data', 'app.db');

const fs = require('fs');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;

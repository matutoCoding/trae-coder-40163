const db = require('../db');

const FeedbackType = {
  SPEAKER_RENAME: 'speaker_rename',
  SEGMENT_MERGE: 'segment_merge',
  TEXT_CORRECTION: 'text_correction',
  SEGMENT_SPLIT: 'segment_split'
};

const mapFeedback = (row) => ({
  id: row.id,
  taskId: row.task_id,
  segmentId: row.segment_id,
  feedbackType: row.feedback_type,
  oldValue: row.old_value,
  newValue: row.new_value,
  teamId: row.team_id,
  createdAt: row.created_at,
  applied: row.applied === 1,
  metadata: row.metadata ? JSON.parse(row.metadata) : null
});

const createFeedback = (taskId, feedbackList) => {
  if (!feedbackList || feedbackList.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO feedback
    (task_id, segment_id, feedback_type, old_value, new_value, team_id, created_at, metadata)
    VALUES (@taskId, @segmentId, @feedbackType, @oldValue, @newValue, @teamId, @createdAt, @metadata)
  `);
  const tx = db.transaction((list) => {
    for (const f of list) {
      stmt.run({
        taskId,
        segmentId: f.segmentId || null,
        feedbackType: f.feedbackType,
        oldValue: f.oldValue || null,
        newValue: f.newValue || null,
        teamId: f.teamId || null,
        createdAt: f.createdAt,
        metadata: f.metadata ? JSON.stringify(f.metadata) : null
      });
    }
  });
  tx(feedbackList);
  return getFeedbackByTaskId(taskId);
};

const getFeedbackByTaskId = (taskId) => {
  const rows = db.prepare(`
    SELECT * FROM feedback WHERE task_id = ? ORDER BY created_at ASC
  `).all(taskId);
  return rows.map(mapFeedback);
};

const getFeedbackByTeamId = (teamId, feedbackType = null, limit = 100) => {
  let sql = 'SELECT * FROM feedback WHERE team_id = ?';
  const params = [teamId];
  if (feedbackType) {
    sql += ' AND feedback_type = ?';
    params.push(feedbackType);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFeedback);
};

const markFeedbackApplied = (id) => {
  const result = db.prepare('UPDATE feedback SET applied = 1 WHERE id = ?').run(id);
  return result.changes > 0;
};

const buildSpeakerRenamesByTeam = (teamId) => {
  if (!teamId) return {};
  const renames = getFeedbackByTeamId(teamId, FeedbackType.SPEAKER_RENAME, 500);
  const map = {};
  const applied = new Set();
  for (const r of renames) {
    const key = `${r.taskId}|${r.oldValue}`;
    if (applied.has(key)) continue;
    map[r.oldValue] = r.newValue;
    applied.add(key);
  }
  return map;
};

module.exports = {
  FeedbackType,
  createFeedback,
  getFeedbackByTaskId,
  getFeedbackByTeamId,
  markFeedbackApplied,
  buildSpeakerRenamesByTeam
};

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

const getTeamLearningOverview = (teamId, appId) => {
  if (!teamId) return null;

  const appIdCondition = appId ? ' AND f.task_id IN (SELECT id FROM tasks WHERE app_id = ?)' : '';
  const baseParams = appId ? [teamId, appId] : [teamId];

  const typeStats = db.prepare(`
    SELECT feedback_type, COUNT(*) as count
    FROM feedback f
    WHERE f.team_id = ?${appIdCondition}
    GROUP BY feedback_type
  `).all(...baseParams);

  const statsByType = {};
  let totalFeedback = 0;
  for (const row of typeStats) {
    statsByType[row.feedback_type] = row.count;
    totalFeedback += row.count;
  }

  const renameRows = db.prepare(`
    SELECT DISTINCT old_value, new_value
    FROM feedback
    WHERE team_id = ? AND feedback_type = ? AND old_value IS NOT NULL
    ORDER BY created_at DESC LIMIT 50
  `).all(teamId, FeedbackType.SPEAKER_RENAME);
  const speakerMappings = renameRows.map((r) => ({
    from: r.old_value,
    to: r.new_value
  }));

  const recentFeedback = getFeedbackByTeamId(teamId, null, 10);

  const taskCountRow = db.prepare(`
    SELECT COUNT(DISTINCT f.task_id) as count
    FROM feedback f
    WHERE f.team_id = ?${appIdCondition}
  `).get(...baseParams);

  return {
    teamId,
    totalFeedback,
    feedbackByType: statsByType,
    speakerMappings,
    totalMergeCount: statsByType[FeedbackType.SEGMENT_MERGE] || 0,
    totalRenameCount: statsByType[FeedbackType.SPEAKER_RENAME] || 0,
    totalTextCorrectionCount: statsByType[FeedbackType.TEXT_CORRECTION] || 0,
    tasksWithFeedback: taskCountRow ? taskCountRow.count : 0,
    recentFeedback: recentFeedback.map((f) => ({
      id: f.id,
      taskId: f.taskId,
      feedbackType: f.feedbackType,
      oldValue: f.oldValue,
      newValue: f.newValue,
      createdAt: f.createdAt
    }))
  };
};

module.exports = {
  FeedbackType,
  createFeedback,
  getFeedbackByTaskId,
  getFeedbackByTeamId,
  markFeedbackApplied,
  buildSpeakerRenamesByTeam,
  getTeamLearningOverview
};

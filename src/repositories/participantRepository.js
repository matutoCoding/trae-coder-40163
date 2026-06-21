const db = require('../db');

const createParticipants = (taskId, participants) => {
  if (!participants || participants.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO participants (task_id, speaker_label, display_name)
    VALUES (?, ?, ?)
  `);
  const tx = db.transaction((list) => {
    for (const p of list) {
      stmt.run(taskId, p.speakerLabel, p.displayName || null);
    }
  });
  tx(participants);
  return getParticipantsByTaskId(taskId);
};

const getParticipantsByTaskId = (taskId) => {
  const rows = db.prepare(`
    SELECT id, task_id, speaker_label, display_name
    FROM participants WHERE task_id = ?
  `).all(taskId);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    speakerLabel: r.speaker_label,
    displayName: r.display_name
  }));
};

const updateParticipantDisplayName = (taskId, speakerLabel, displayName) => {
  const result = db.prepare(`
    UPDATE participants SET display_name = ?
    WHERE task_id = ? AND speaker_label = ?
  `).run(displayName, taskId, speakerLabel);
  return result.changes > 0;
};

module.exports = {
  createParticipants,
  getParticipantsByTaskId,
  updateParticipantDisplayName
};

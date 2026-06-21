const db = require('../db');

const mapSegment = (row) => ({
  id: row.id,
  taskId: row.task_id,
  speakerLabel: row.speaker_label,
  startTime: row.start_time,
  endTime: row.end_time,
  textContent: row.text_content,
  confidence: row.confidence,
  originalSpeakerLabel: row.original_speaker_label,
  mergedFrom: row.merged_from
    ? row.merged_from.split(',').filter(Boolean).map((s) => Number(s))
    : null,
  correctedAt: row.corrected_at
});

const createSegments = (taskId, segments) => {
  if (!segments || segments.length === 0) return [];
  const stmt = db.prepare(`
    INSERT INTO segments (task_id, speaker_label, start_time, end_time, text_content, confidence)
    VALUES (@taskId, @speakerLabel, @startTime, @endTime, @textContent, @confidence)
  `);
  const tx = db.transaction((list) => {
    for (const s of list) {
      stmt.run({
        taskId,
        speakerLabel: s.speakerLabel,
        startTime: s.startTime,
        endTime: s.endTime,
        textContent: s.textContent,
        confidence: s.confidence ?? 0.85
      });
    }
  });
  tx(segments);
  return getSegmentsByTaskId(taskId);
};

const getSegmentsByTaskId = (taskId) => {
  const rows = db.prepare(`
    SELECT * FROM segments WHERE task_id = ? ORDER BY start_time ASC
  `).all(taskId);
  return rows.map(mapSegment);
};

const getSegmentById = (id) => {
  const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
  return row ? mapSegment(row) : null;
};

const updateSegmentSpeaker = (id, newSpeakerLabel, correctedAt) => {
  const segment = getSegmentById(id);
  if (!segment) return null;
  const originalLabel = segment.originalSpeakerLabel || segment.speakerLabel;
  db.prepare(`
    UPDATE segments
    SET speaker_label = ?, original_speaker_label = ?, corrected_at = ?
    WHERE id = ?
  `).run(newSpeakerLabel, originalLabel, correctedAt, id);
  return getSegmentById(id);
};

const mergeSegments = (taskId, segmentIds, correctedAt) => {
  if (!segmentIds || segmentIds.length < 2) return null;
  const ids = segmentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM segments WHERE id IN (${ids}) AND task_id = ?
    ORDER BY start_time ASC
  `).all(...segmentIds, taskId);

  if (rows.length < 2) return null;

  const minStart = Math.min(...rows.map((r) => r.start_time));
  const maxEnd = Math.max(...rows.map((r) => r.end_time));
  const mergedText = rows.map((r) => r.text_content).join(' ');
  const mainSpeaker = rows[0].speaker_label;
  const avgConfidence = rows.reduce((sum, r) => sum + (r.confidence || 0), 0) / rows.length;
  const mergedFrom = rows.map((r) => r.id).join(',');
  const originalSpeaker = rows[0].original_speaker_label || rows[0].speaker_label;

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM segments WHERE id IN (${ids})`).run(...segmentIds);
    const stmt = db.prepare(`
      INSERT INTO segments
      (task_id, speaker_label, start_time, end_time, text_content, confidence, original_speaker_label, merged_from, corrected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      taskId, mainSpeaker, minStart, maxEnd, mergedText, avgConfidence,
      originalSpeaker, mergedFrom, correctedAt
    );
    return info.lastInsertRowid;
  });

  const newId = tx();
  return getSegmentById(newId);
};

const updateSegmentText = (id, newText, correctedAt) => {
  db.prepare(`
    UPDATE segments SET text_content = ?, corrected_at = ? WHERE id = ?
  `).run(newText, correctedAt, id);
  return getSegmentById(id);
};

module.exports = {
  createSegments,
  getSegmentsByTaskId,
  getSegmentById,
  updateSegmentSpeaker,
  mergeSegments,
  updateSegmentText
};

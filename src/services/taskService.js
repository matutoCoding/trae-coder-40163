const { v4: uuidv4 } = require('uuid');
const {
  TaskStatus,
  createTask,
  getTaskById,
  updateTaskStatus
} = require('../repositories/taskRepository');
const {
  createParticipants,
  getParticipantsByTaskId,
  updateParticipantDisplayName
} = require('../repositories/participantRepository');
const {
  createSegments,
  getSegmentsByTaskId,
  updateSegmentSpeaker,
  mergeSegments,
  updateSegmentText
} = require('../repositories/segmentRepository');
const {
  FeedbackType,
  createFeedback,
  getFeedbackByTaskId,
  buildSpeakerRenamesByTeam
} = require('../repositories/feedbackRepository');
const { simulateDiarization } = require('./transcriptionEngine');

const now = () => Date.now();

class TaskService {
  submitTask(payload) {
    const { audioUrl, meetingName, teamId, callbackUrl, participants = [] } = payload;
    const taskId = uuidv4();
    const createdAt = now();

    const task = createTask({
      id: taskId,
      audioUrl,
      meetingName,
      teamId,
      callbackUrl,
      createdAt
    });

    if (participants && participants.length > 0) {
      const normalized = participants.map((p, idx) => ({
        speakerLabel: p.speakerLabel || `发言人${idx + 1}`,
        displayName: p.displayName || null
      }));
      createParticipants(taskId, normalized);
    }

    this.scheduleProcessing(taskId, payload);

    return { taskId, status: task.status, createdAt };
  }

  scheduleProcessing(taskId, payload) {
    const delayMs = this._calculateDelay(payload);
    setTimeout(() => this.processTask(taskId, payload).catch((err) => {
      console.error('[TaskService] 处理任务失败:', taskId, err.message);
      updateTaskStatus(taskId, TaskStatus.FAILED, { errorMessage: err.message });
    }), delayMs);
  }

  _calculateDelay(payload) {
    if (process.env.NODE_ENV === 'test') return 20;
    return 1500 + Math.random() * 2500;
  }

  async processTask(taskId, payload) {
    const task = getTaskById(taskId);
    if (!task || task.status !== TaskStatus.PENDING) return;

    updateTaskStatus(taskId, TaskStatus.PROCESSING, { startedAt: now() });

    try {
      const hintCount = payload.participants ? payload.participants.length : 0;
      const rawSegments = simulateDiarization(task.audioUrl, task.meetingName, hintCount);

      const renames = task.teamId ? buildSpeakerRenamesByTeam(task.teamId) : {};
      const mappedSegments = rawSegments.map((s) => ({
        ...s,
        speakerLabel: renames[s.speakerLabel] || s.speakerLabel
      }));

      createSegments(taskId, mappedSegments);
      updateTaskStatus(taskId, TaskStatus.COMPLETED, { completedAt: now() });

      if (task.callbackUrl) {
        this._fireCallback(task.callbackUrl, taskId);
      }
    } catch (err) {
      updateTaskStatus(taskId, TaskStatus.FAILED, {
        completedAt: now(),
        errorMessage: err.message
      });
      throw err;
    }
  }

  _fireCallback(url, taskId) {
    if (process.env.NODE_ENV === 'test') return;
    const http = require('http');
    const https = require('https');
    const client = url.startsWith('https') ? https : http;
    const body = JSON.stringify({ taskId, status: 'completed', event: 'task_finished' });
    try {
      const u = new URL(url);
      const req = client.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      });
      req.on('error', () => {});
      req.write(body);
      req.end();
    } catch (_) { /* ignore */ }
  }

  getTaskResult(taskId) {
    const task = getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在' }, httpStatus: 404 };
    }

    const participants = getParticipantsByTaskId(taskId);
    const segments = getSegmentsByTaskId(taskId);
    const feedback = getFeedbackByTaskId(taskId);

    const bySpeaker = this._groupBySpeaker(segments);
    const speakers = this._buildSpeakers(bySpeaker, participants);

    return {
      data: {
        taskId: task.id,
        meetingName: task.meetingName,
        status: task.status,
        teamId: task.teamId,
        timestamps: {
          submittedAt: task.createdAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt
        },
        progress: this._calcProgress(task),
        errorMessage: task.errorMessage,
        participants: participants.map((p) => ({
          speakerLabel: p.speakerLabel,
          displayName: p.displayName
        })),
        speakers,
        segments: segments.map(this._formatSegment),
        feedbacks: feedback.map((f) => ({
          id: f.id,
          feedbackType: f.feedbackType,
          segmentId: f.segmentId,
          oldValue: f.oldValue,
          newValue: f.newValue,
          createdAt: f.createdAt,
          metadata: f.metadata
        }))
      }
    };
  }

  _calcProgress(task) {
    switch (task.status) {
      case TaskStatus.PENDING: return 0;
      case TaskStatus.PROCESSING: return 50;
      case TaskStatus.COMPLETED: return 100;
      case TaskStatus.FAILED: return 100;
      default: return 0;
    }
  }

  _groupBySpeaker(segments) {
    const map = new Map();
    for (const s of segments) {
      if (!map.has(s.speakerLabel)) map.set(s.speakerLabel, []);
      map.get(s.speakerLabel).push(s);
    }
    return map;
  }

  _buildSpeakers(bySpeaker, participants) {
    const displayMap = new Map(participants.map((p) => [p.speakerLabel, p.displayName]));
    const result = [];
    for (const [label, segs] of bySpeaker) {
      const totalDuration = segs.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
      const text = segs.map((s) => s.textContent).join(' ');
      result.push({
        speakerLabel: label,
        displayName: displayMap.get(label) || null,
        segmentCount: segs.length,
        totalDuration: parseFloat(totalDuration.toFixed(2)),
        summary: text.slice(0, 120) + (text.length > 120 ? '...' : '')
      });
    }
    return result;
  }

  _formatSegment(s) {
    return {
      id: s.id,
      speakerLabel: s.speakerLabel,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: parseFloat((s.endTime - s.startTime).toFixed(2)),
      textContent: s.textContent,
      confidence: s.confidence,
      originalSpeakerLabel: s.originalSpeakerLabel,
      mergedFrom: s.mergedFrom,
      correctedAt: s.correctedAt
    };
  }

  submitFeedback(taskId, payload) {
    const task = getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在' }, httpStatus: 404 };
    }

    const { corrections = [], teamId } = payload;
    if (!corrections || corrections.length === 0) {
      return { error: { code: 'EMPTY_CORRECTIONS', message: '未提供任何修正信息' }, httpStatus: 400 };
    }

    const validated = [];
    const errors = [];
    const ts = now();

    for (let i = 0; i < corrections.length; i++) {
      const c = corrections[i];
      const check = this._applyCorrection(taskId, c, ts);
      if (check.error) {
        errors.push({ index: i, ...check.error });
      } else {
        validated.push({
          ...c,
          feedbackType: c.type,
          createdAt: ts,
          teamId: teamId || task.teamId
        });
      }
    }

    const saved = validated.length > 0 ? createFeedback(taskId, validated) : [];

    return {
      data: {
        taskId,
        appliedCount: saved.length,
        skippedCount: errors.length,
        errors,
        feedbacks: saved.map((f) => ({
          id: f.id,
          feedbackType: f.feedbackType,
          segmentId: f.segmentId,
          oldValue: f.oldValue,
          newValue: f.newValue,
          createdAt: f.createdAt
        }))
      }
    };
  }

  _applyCorrection(taskId, correction, ts) {
    const { type } = correction;
    switch (type) {
      case FeedbackType.SPEAKER_RENAME:
        return this._applySpeakerRename(taskId, correction, ts);
      case FeedbackType.SEGMENT_MERGE:
        return this._applySegmentMerge(taskId, correction, ts);
      case FeedbackType.TEXT_CORRECTION:
        return this._applyTextCorrection(taskId, correction, ts);
      default:
        return { error: { code: 'UNKNOWN_TYPE', message: `不支持的修正类型: ${type}` } };
    }
  }

  _applySpeakerRename(taskId, correction, ts) {
    const { segmentId, oldSpeakerLabel, newSpeakerLabel, scope = 'segment' } = correction;
    if (!newSpeakerLabel) {
      return { error: { code: 'MISSING_NEW_LABEL', message: '缺少新的发言人标签' } };
    }
    if (scope === 'segment') {
      if (!segmentId) {
        return { error: { code: 'MISSING_SEGMENT_ID', message: '分段模式下必须指定 segmentId' } };
      }
      const updated = updateSegmentSpeaker(segmentId, newSpeakerLabel, ts);
      if (!updated) {
        return { error: { code: 'SEGMENT_NOT_FOUND', message: `片段 ${segmentId} 不存在` } };
      }
      correction.oldValue = oldSpeakerLabel || updated.originalSpeakerLabel;
      correction.newValue = newSpeakerLabel;
      correction.segmentId = segmentId;
      correction.metadata = { scope: 'segment' };
      return {};
    }
    if (scope === 'task' || scope === 'team') {
      const segments = getSegmentsByTaskId(taskId);
      let target;
      if (oldSpeakerLabel) {
        target = oldSpeakerLabel;
      } else if (correction.segmentId) {
        target = segments.find((s) => s.id === correction.segmentId)?.speakerLabel;
      }
      if (!target) {
        return { error: { code: 'MISSING_OLD_LABEL', message: '任务/团队级别重命名需要指定旧发言人标签' } };
      }
      for (const s of segments) {
        if (s.speakerLabel === target || s.originalSpeakerLabel === target) {
          updateSegmentSpeaker(s.id, newSpeakerLabel, ts);
        }
      }
      if (scope === 'task' || scope === 'team') {
        updateParticipantDisplayName(taskId, target, newSpeakerLabel);
      }
      correction.oldValue = target;
      correction.newValue = newSpeakerLabel;
      correction.segmentId = null;
      correction.metadata = { scope, taskId };
      return {};
    }
    return { error: { code: 'INVALID_SCOPE', message: `不支持的作用域: ${scope}` } };
  }

  _applySegmentMerge(taskId, correction, ts) {
    const { segmentIds } = correction;
    if (!segmentIds || segmentIds.length < 2) {
      return { error: { code: 'INVALID_SEGMENT_IDS', message: '合并至少需要 2 个片段 ID' } };
    }
    const merged = mergeSegments(taskId, segmentIds, ts);
    if (!merged) {
      return { error: { code: 'MERGE_FAILED', message: '合并片段失败，请确认 segmentIds 属于同一任务' } };
    }
    correction.oldValue = segmentIds.join(',');
    correction.newValue = String(merged.id);
    correction.segmentId = merged.id;
    correction.metadata = {
      startTime: merged.startTime,
      endTime: merged.endTime,
      mergedCount: segmentIds.length
    };
    return {};
  }

  _applyTextCorrection(taskId, correction, ts) {
    const { segmentId, oldText, newText } = correction;
    if (!segmentId) {
      return { error: { code: 'MISSING_SEGMENT_ID', message: '必须指定 segmentId' } };
    }
    if (newText === undefined || newText === null) {
      return { error: { code: 'MISSING_NEW_TEXT', message: '缺少修正后的文本' } };
    }
    const updated = updateSegmentText(segmentId, newText, ts);
    if (!updated) {
      return { error: { code: 'SEGMENT_NOT_FOUND', message: `片段 ${segmentId} 不存在` } };
    }
    correction.oldValue = oldText || updated.textContent;
    correction.newValue = newText;
    correction.segmentId = segmentId;
    correction.metadata = { changed: oldText !== newText };
    return {};
  }
}

module.exports = new TaskService();
module.exports.TaskService = TaskService;

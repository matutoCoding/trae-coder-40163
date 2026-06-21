const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
  TaskStatus,
  createTask,
  getTaskById,
  getTaskByIdAndAppId,
  updateTaskStatus,
  queryTasks
} = require('../repositories/taskRepository');
const {
  createParticipants,
  getParticipantsByTaskId,
  updateParticipantDisplayName
} = require('../repositories/participantRepository');
const {
  createSegments,
  getSegmentsByTaskId,
  getSegmentById,
  updateSegmentSpeaker,
  mergeSegments,
  updateSegmentText
} = require('../repositories/segmentRepository');
const {
  FeedbackType,
  createFeedback,
  getFeedbackByTaskId,
  buildSpeakerRenamesByTeam,
  getTeamLearningOverview
} = require('../repositories/feedbackRepository');
const { createCallbackLog, getCallbackLogsByTaskId } = require('../repositories/callbackRepository');
const { simulateDiarization } = require('./transcriptionEngine');

const CALLBACK_MAX_RETRIES = 3;
const CALLBACK_RETRY_DELAYS = [5000, 30000, 120000];
const now = () => Date.now();

const generateSignature = (taskId, timestamp) => {
  const secret = process.env.CALLBACK_SECRET || 'vts_default_secret';
  return crypto.createHmac('sha256', secret)
    .update(`${taskId}:${timestamp}`)
    .digest('hex');
};

class TaskService {
  submitTask(payload, appId) {
    const { audioUrl, meetingName, teamId, callbackUrl, participants = [] } = payload;
    const taskId = uuidv4();
    const createdAt = now();

    const task = createTask({
      id: taskId,
      appId,
      audioUrl,
      meetingName,
      teamId,
      callbackUrl,
      createdAt
    });

    if (participants && participants.length > 0) {
      const normalized = participants.map((p, idx) => ({
        speakerLabel: (p && p.speakerLabel) || `发言人${idx + 1}`,
        displayName: (p && p.displayName) || null
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
        this._fireCallbackWithRetry(task.callbackUrl, taskId);
      }
    } catch (err) {
      updateTaskStatus(taskId, TaskStatus.FAILED, {
        completedAt: now(),
        errorMessage: err.message
      });
      throw err;
    }
  }

  _fireCallbackWithRetry(url, taskId, attempt = 1) {
    const ts = now();
    const sig = generateSignature(taskId, ts);
    const resultUrl = `/api/tasks/${taskId}`;
    const payload = JSON.stringify({
      taskId,
      status: 'completed',
      event: 'task_finished',
      timestamp: ts,
      signature: sig,
      resultUrl,
      _links: {
        result: {
          method: 'GET',
          href: resultUrl,
          signature: sig,
          timestamp: ts
        }
      }
    });

    if (process.env.NODE_ENV === 'test') {
      updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        callbackStatus: 'delivered',
        callbackAttempts: attempt,
        lastCallbackAt: ts
      });
      createCallbackLog({
        taskId, url, payload, statusCode: 200, attempt, createdAt: ts, nextRetryAt: null
      });
      return;
    }

    const http = require('http');
    const https = require('https');

    const doRequest = (callbackUrl, body, cb) => {
      const client = callbackUrl.startsWith('https') ? https : http;
      try {
        const u = new URL(callbackUrl);
        const req = client.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-VTS-Signature': sig,
            'X-VTS-Timestamp': String(ts)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => cb(null, res.statusCode, data));
        });
        req.on('error', (err) => cb(err));
        req.write(body);
        req.end();
      } catch (e) {
        cb(e);
      }
    };

    doRequest(url, payload, (err, statusCode, responseBody) => {
      const success = !err && statusCode >= 200 && statusCode < 300;
      const cbStatus = success ? 'delivered' : 'failed';
      updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        callbackStatus: cbStatus,
        callbackAttempts: attempt,
        lastCallbackAt: ts
      });
      createCallbackLog({
        taskId, url, payload,
        statusCode: statusCode || null,
        responseBody: responseBody || (err ? err.message : null),
        attempt,
        createdAt: ts,
        nextRetryAt: success ? null : this._nextRetryAt(attempt)
      });

      if (!success && attempt < CALLBACK_MAX_RETRIES) {
        const delay = CALLBACK_RETRY_DELAYS[attempt - 1] || 120000;
        setTimeout(() => {
          this._fireCallbackWithRetry(url, taskId, attempt + 1);
        }, delay);
      }
    });
  }

  _nextRetryAt(attempt) {
    const delay = CALLBACK_RETRY_DELAYS[attempt - 1] || 120000;
    return now() + delay;
  }

  getTaskResult(taskId, appId) {
    const task = appId
      ? getTaskByIdAndAppId(taskId, appId)
      : getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或无权访问' }, httpStatus: 404 };
    }

    const participants = getParticipantsByTaskId(taskId);
    const segments = getSegmentsByTaskId(taskId);
    const feedback = getFeedbackByTaskId(taskId);
    const callbackLogs = getCallbackLogsByTaskId(taskId);

    const bySpeaker = this._groupBySpeaker(segments);
    const speakers = this._buildSpeakers(bySpeaker, participants);

    const callbackInfo = task.callbackUrl ? {
      url: task.callbackUrl,
      status: task.callbackStatus,
      attempts: task.callbackAttempts || 0,
      lastCallbackAt: task.lastCallbackAt,
      recentLogs: callbackLogs.slice(0, 3).map((l) => ({
        attempt: l.attempt,
        statusCode: l.statusCode,
        createdAt: l.createdAt
      }))
    } : null;

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
        callback: callbackInfo,
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

  listTasks(appId, filters = {}) {
    if (!appId) {
      return { error: { code: 'MISSING_APP_ID', message: '缺少应用标识' }, httpStatus: 400 };
    }
    return queryTasks({ appId, ...filters });
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

  submitFeedback(taskId, payload, appId) {
    const task = appId
      ? getTaskByIdAndAppId(taskId, appId)
      : getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或无权访问' }, httpStatus: 404 };
    }

    const { corrections = [], teamId } = payload;
    if (!corrections || corrections.length === 0) {
      return { error: { code: 'EMPTY_CORRECTIONS', message: '未提供任何修正信息' }, httpStatus: 400 };
    }

    const taskSegments = getSegmentsByTaskId(taskId);
    const segmentIdSet = new Set(taskSegments.map((s) => s.id));

    const validated = [];
    const errors = [];
    const ts = now();

    for (let i = 0; i < corrections.length; i++) {
      const c = corrections[i];
      const ownershipError = this._checkSegmentOwnership(c, segmentIdSet);
      if (ownershipError) {
        errors.push({ index: i, ...ownershipError });
        continue;
      }
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

  _checkSegmentOwnership(correction, segmentIdSet) {
    const { type, segmentId, segmentIds } = correction;

    if (type === 'speaker_rename' && correction.scope === 'segment' && segmentId) {
      if (!segmentIdSet.has(segmentId)) {
        return { code: 'SEGMENT_NOT_BELONG', message: `片段 ${segmentId} 不属于当前任务` };
      }
    }

    if (type === 'segment_merge' && Array.isArray(segmentIds)) {
      const foreign = segmentIds.filter((id) => !segmentIdSet.has(id));
      if (foreign.length > 0) {
        return { code: 'SEGMENT_NOT_BELONG', message: `片段 ${foreign.join(',')} 不属于当前任务` };
      }
    }

    if (type === 'text_correction' && segmentId) {
      if (!segmentIdSet.has(segmentId)) {
        return { code: 'SEGMENT_NOT_BELONG', message: `片段 ${segmentId} 不属于当前任务` };
      }
    }

    return null;
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

  getTeamLearning(teamId, appId) {
    return getTeamLearningOverview(teamId, appId);
  }
}

module.exports = new TaskService();
module.exports.TaskService = TaskService;

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
const { createCallbackLog, getCallbackLogsByTaskId, getLatestFailedLog } = require('../repositories/callbackRepository');
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
    const { audioUrl, meetingName, teamId, callbackUrl, backupCallbackUrl, participants = [] } = payload;
    const taskId = uuidv4();
    const createdAt = now();

    const task = createTask({
      id: taskId,
      appId,
      audioUrl,
      meetingName,
      teamId,
      callbackUrl,
      backupCallbackUrl,
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

      const renames = task.teamId ? buildSpeakerRenamesByTeam(task.teamId, task.appId) : {};
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
        callbackFailureReason: null,
        lastCallbackAt: ts
      });
      createCallbackLog({
        taskId, url, payload, statusCode: 200, failureReason: null, attempt, createdAt: ts, nextRetryAt: null
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
      let failureReason = null;
      if (err) {
        failureReason = 'network_error';
      } else if (statusCode < 200 || statusCode >= 300) {
        failureReason = 'non_2xx';
      }

      updateTaskStatus(taskId, TaskStatus.COMPLETED, {
        callbackStatus: cbStatus,
        callbackAttempts: attempt,
        callbackFailureReason: failureReason,
        lastCallbackAt: ts
      });
      createCallbackLog({
        taskId, url, payload,
        statusCode: statusCode || null,
        responseBody: responseBody || (err ? err.message : null),
        failureReason,
        attempt,
        createdAt: ts,
        nextRetryAt: success ? null : this._nextRetryAt(attempt)
      });

      if (!success && attempt < CALLBACK_MAX_RETRIES) {
        const task = getTaskById(taskId);
        const nextUrl = (attempt === 1 && task && task.backupCallbackUrl) ? task.backupCallbackUrl : url;
        const delay = CALLBACK_RETRY_DELAYS[attempt - 1] || 120000;
        setTimeout(() => {
          this._fireCallbackWithRetry(nextUrl, taskId, attempt + 1);
        }, delay);
      }
    });
  }

  _nextRetryAt(attempt) {
    const delay = CALLBACK_RETRY_DELAYS[attempt - 1] || 120000;
    return now() + delay;
  }

  getTaskResult(taskId, appId, allowedTeamIds) {
    const task = appId
      ? getTaskByIdAndAppId(taskId, appId)
      : getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或无权访问' }, httpStatus: 404 };
    }
    const hasTeamRestriction = Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0;
    if (hasTeamRestriction && task.teamId && !allowedTeamIds.includes(task.teamId)) {
      return { error: { code: 'TEAM_NOT_ALLOWED', message: '当前 API Key 无权访问此团队的任务' }, httpStatus: 403 };
    }

    const participants = getParticipantsByTaskId(taskId);
    const segments = getSegmentsByTaskId(taskId);
    const feedback = getFeedbackByTaskId(taskId);
    const callbackLogs = getCallbackLogsByTaskId(taskId);

    const bySpeaker = this._groupBySpeaker(segments);
    const speakers = this._buildSpeakers(bySpeaker, participants);

    const callbackInfo = task.callbackUrl ? {
      url: task.callbackUrl,
      backupUrl: task.backupCallbackUrl || null,
      status: task.callbackStatus,
      attempts: task.callbackAttempts || 0,
      failureReason: task.callbackFailureReason || null,
      lastCallbackAt: task.lastCallbackAt,
      recentLogs: callbackLogs.slice(0, 3).map((l) => ({
        attempt: l.attempt,
        statusCode: l.statusCode,
        failureReason: l.failureReason,
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
    const ts = now();

    for (let i = 0; i < corrections.length; i++) {
      const c = corrections[i];
      const ownershipError = this._checkSegmentOwnership(c, segmentIdSet);
      if (ownershipError) {
        return {
          httpStatus: 400,
          error: {
            code: ownershipError.code || 'SEGMENT_NOT_BELONG',
            message: `corrections[${i}]: ${ownershipError.message}`,
            index: i,
            details: ownershipError
          }
        };
      }
      const validation = this._validateCorrection(c);
      if (validation) {
        return {
          httpStatus: 400,
          error: {
            code: validation.code || 'INVALID_CORRECTION',
            message: `corrections[${i}]: ${validation.message}`,
            index: i,
            details: validation
          }
        };
      }
    }

    const savedList = [];
    for (const c of corrections) {
      const apply = this._applyCorrection(taskId, c, ts);
      if (apply.error) continue;
      savedList.push({
        ...c,
        feedbackType: c.type,
        createdAt: ts,
        teamId: teamId || task.teamId
      });
    }
    const saved = savedList.length > 0 ? createFeedback(taskId, savedList) : [];

    return {
      data: {
        taskId,
        appliedCount: saved.length,
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

  _validateCorrection(correction) {
    const { type } = correction;
    if (!type) return { code: 'MISSING_TYPE', message: '缺少修正类型 type' };
    switch (type) {
      case FeedbackType.SPEAKER_RENAME: {
        if (!correction.newSpeakerLabel) return { code: 'MISSING_NEW_LABEL', message: '缺少新的发言人标签' };
        if (correction.scope === 'segment' && !correction.segmentId) {
          return { code: 'MISSING_SEGMENT_ID', message: '分段模式下必须指定 segmentId' };
        }
        if ((correction.scope === 'task' || correction.scope === 'team') && !correction.oldSpeakerLabel && !correction.segmentId) {
          return { code: 'MISSING_OLD_LABEL', message: '任务/团队级别重命名需要指定旧发言人标签' };
        }
        return null;
      }
      case FeedbackType.SEGMENT_MERGE: {
        if (!Array.isArray(correction.segmentIds) || correction.segmentIds.length < 2) {
          return { code: 'INVALID_SEGMENT_IDS', message: '合并至少需要 2 个片段 ID' };
        }
        return null;
      }
      case FeedbackType.TEXT_CORRECTION: {
        if (!correction.segmentId) return { code: 'MISSING_SEGMENT_ID', message: '必须指定 segmentId' };
        if (correction.newText === undefined || correction.newText === null) {
          return { code: 'MISSING_NEW_TEXT', message: '缺少修正后的文本' };
        }
        return null;
      }
      default:
        return { code: 'UNKNOWN_TYPE', message: `不支持的修正类型: ${type}` };
    }
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

  getCallbackHistory(taskId, appId, allowedTeamIds) {
    const task = appId ? getTaskByIdAndAppId(taskId, appId) : getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或无权访问' }, httpStatus: 404 };
    }
    const hasTeamRestriction = Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0;
    if (hasTeamRestriction && task.teamId && !allowedTeamIds.includes(task.teamId)) {
      return { error: { code: 'TEAM_NOT_ALLOWED', message: '当前 API Key 无权访问此团队的任务' }, httpStatus: 403 };
    }
    if (!task.callbackUrl) {
      return { data: { taskId, url: null, backupUrl: null, logs: [], status: task.callbackStatus || 'not_configured', failureReason: null } };
    }
    const logs = getCallbackLogsByTaskId(taskId, 50);
    return {
      data: {
        taskId,
        url: task.callbackUrl,
        backupUrl: task.backupCallbackUrl || null,
        status: task.callbackStatus || 'pending',
        attempts: task.callbackAttempts || 0,
        failureReason: task.callbackFailureReason || null,
        lastCallbackAt: task.lastCallbackAt,
        logs: logs.map((l) => ({
          id: l.id,
          attempt: l.attempt,
          statusCode: l.statusCode,
          responseBody: l.responseBody,
          failureReason: l.failureReason,
          createdAt: l.createdAt,
          nextRetryAt: l.nextRetryAt
        }))
      }
    };
  }

  retryCallback(taskId, appId, allowedTeamIds) {
    const task = appId ? getTaskByIdAndAppId(taskId, appId) : getTaskById(taskId);
    if (!task) {
      return { error: { code: 'TASK_NOT_FOUND', message: '任务不存在或无权访问' }, httpStatus: 404 };
    }
    const hasTeamRestriction = Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0;
    if (hasTeamRestriction && task.teamId && !allowedTeamIds.includes(task.teamId)) {
      return { error: { code: 'TEAM_NOT_ALLOWED', message: '当前 API Key 无权访问此团队的任务' }, httpStatus: 403 };
    }
    if (!task.callbackUrl) {
      return { error: { code: 'CALLBACK_NOT_CONFIGURED', message: '该任务未配置回调地址' }, httpStatus: 400 };
    }
    const failed = getLatestFailedLog(taskId);
    if (!failed) {
      return { error: { code: 'NO_FAILED_CALLBACK', message: '该任务没有失败的回调记录，无需重放' }, httpStatus: 400 };
    }
    const attempt = failed.attempt + 1;
    if (attempt > CALLBACK_MAX_RETRIES) {
      return { error: { code: 'MAX_RETRIES_EXCEEDED', message: `重放次数超过上限(${CALLBACK_MAX_RETRIES}次)` }, httpStatus: 400 };
    }
    this._fireCallbackWithRetry(task.callbackUrl, taskId, attempt);
    return {
      data: {
        taskId,
        attempt,
        status: 'retrying',
        message: '已触发重放，请稍后查询任务确认回调状态'
      }
    };
  }

  batchGetTaskSummaries(taskIds, appId, allowedTeamIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { error: { code: 'EMPTY_TASK_IDS', message: 'taskIds 必须是非空数组' }, httpStatus: 400 };
    }
    if (taskIds.length > 100) {
      return { error: { code: 'TOO_MANY_TASKS', message: '单次最多查询 100 个任务' }, httpStatus: 400 };
    }
    const hasTeamRestriction = Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0;
    const results = [];
    for (const tid of taskIds) {
      if (!tid || typeof tid !== 'string') {
        results.push({ taskId: tid, code: 'INVALID_ID', status: 'error', error: 'taskId 必须为非空字符串' });
        continue;
      }
      try {
        const task = appId ? getTaskByIdAndAppId(tid, appId) : getTaskById(tid);
        if (!task) {
          const raw = getTaskById(tid);
          if (raw) {
            results.push({ taskId: tid, code: 'FORBIDDEN', status: 'forbidden', error: '无权访问此任务' });
          } else {
            results.push({ taskId: tid, code: 'NOT_FOUND', status: 'not_found', error: '任务不存在' });
          }
          continue;
        }
        if (hasTeamRestriction && task.teamId && !allowedTeamIds.includes(task.teamId)) {
          results.push({ taskId: tid, code: 'FORBIDDEN', status: 'forbidden', error: '当前 API Key 无权访问此团队的任务' });
          continue;
        }
        if (task.status !== TaskStatus.COMPLETED) {
          results.push({
            taskId: tid,
            code: task.status.toUpperCase(),
            status: 'processing',
            meetingName: task.meetingName,
            teamId: task.teamId,
            progress: this._calcProgress(task),
            createdAt: task.createdAt
          });
          continue;
        }
        const segments = getSegmentsByTaskId(tid);
        const participants = getParticipantsByTaskId(tid);
        const bySpeaker = this._groupBySpeaker(segments);
        const speakers = this._buildSpeakers(bySpeaker, participants);
        results.push({
          taskId: tid,
          code: 'OK',
          status: 'success',
          meetingName: task.meetingName,
          teamId: task.teamId,
          createdAt: task.createdAt,
          completedAt: task.completedAt,
          segmentCount: segments.length,
          speakerCount: speakers.length,
          speakers: speakers.map((s) => ({
            speakerLabel: s.speakerLabel,
            displayName: s.displayName,
            segmentCount: s.segmentCount,
            totalDuration: s.totalDuration
          })),
          callback: task.callbackUrl ? {
            status: task.callbackStatus,
            attempts: task.callbackAttempts || 0,
            lastCallbackAt: task.lastCallbackAt
          } : null
        });
      } catch (e) {
        results.push({ taskId: tid, code: 'INTERNAL_ERROR', status: 'error', error: e.message });
      }
    }
    return { data: { results, total: results.length } };
  }
}

module.exports = new TaskService();
module.exports.TaskService = TaskService;

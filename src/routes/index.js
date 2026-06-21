const express = require('express');
const taskService = require('../services/taskService');
const { authMiddleware, requirePermission, checkTeamAllowed, isTeamAllowed } = require('../middleware/auth');
const {
  validateSubmitTask,
  validateFeedback,
  validateCreateApiKey,
  validateBatchGetTasks
} = require('../middleware/validators');
const {
  generateApiKey,
  getKeyById,
  getKeysByAppId,
  revokeKey,
  updateKey,
  rotateKey
} = require('../repositories/apiKeyRepository');
const { queryAuditLogs } = require('../repositories/auditLogRepository');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-transcription-service',
    version: '1.2.0',
    timestamp: Date.now()
  });
});

// ============ API Key 管理（admin only） ============

router.post('/api-keys', authMiddleware, requirePermission('admin'), validateCreateApiKey, (req, res) => {
  const { appName, teamId, permissions, allowedTeamIds, gracePeriodMinutes } = req.body;
  const created = generateApiKey(appName, teamId || null, {
    permissions,
    allowedTeamIds,
    appId: req.appId,
    gracePeriodMinutes: gracePeriodMinutes || undefined
  });
  req.audit('api_key.create', null, `创建密钥 ${created.keyPrefix}...`);
  res.status(201).json({
    code: 'SUCCESS',
    message: 'API Key 创建成功，请妥善保管，仅本次可见',
    data: {
      id: created.id,
      appId: created.appId,
      appName: created.appName,
      apiKey: created.apiKey,
      keyPrefix: created.keyPrefix,
      teamId: created.teamId,
      permissions: created.permissions,
      allowedTeamIds: created.allowedTeamIds,
      gracePeriodUntil: created.gracePeriodUntil,
      status: 'effective',
      createdAt: created.createdAt
    }
  });
});

router.get('/api-keys', authMiddleware, requirePermission('admin'), (req, res) => {
  const keys = getKeysByAppId(req.appId);
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: {
      keys: keys.map((k) => ({
        id: k.id,
        appId: k.appId,
        appName: k.appName,
        keyPrefix: k.keyPrefix,
        teamId: k.teamId,
        permissions: k.permissions,
        allowedTeamIds: k.allowedTeamIds,
        isActive: k.isActive,
        status: k.status,
        gracePeriodUntil: k.gracePeriodUntil,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt
      })),
      total: keys.length
    }
  });
});

router.get('/api-keys/:id', authMiddleware, requirePermission('admin'), (req, res) => {
  const key = getKeyById(req.params.id);
  if (!key || key.appId !== req.appId) {
    return res.status(404).json({ code: 'KEY_NOT_FOUND', message: 'API Key 不存在或无权访问' });
  }
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: {
      id: key.id,
      appId: key.appId,
      appName: key.appName,
      keyPrefix: key.keyPrefix,
      teamId: key.teamId,
      permissions: key.permissions,
      allowedTeamIds: key.allowedTeamIds,
      isActive: key.isActive,
      status: key.status,
      gracePeriodUntil: key.gracePeriodUntil,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt
    }
  });
});

router.put('/api-keys/:id', authMiddleware, requirePermission('admin'), (req, res) => {
  const existing = getKeyById(req.params.id);
  if (!existing || existing.appId !== req.appId) {
    return res.status(404).json({ code: 'KEY_NOT_FOUND', message: 'API Key 不存在或无权访问' });
  }
  const { appName, permissions, allowedTeamIds } = req.body || {};
  const updated = updateKey(req.params.id, { appName, permissions, allowedTeamIds });
  req.audit('api_key.update', null, `更新密钥 ${updated.keyPrefix}...`);
  res.json({
    code: 'SUCCESS',
    message: '更新成功',
    data: {
      id: updated.id,
      appName: updated.appName,
      permissions: updated.permissions,
      allowedTeamIds: updated.allowedTeamIds
    }
  });
});

router.delete('/api-keys/:id', authMiddleware, requirePermission('admin'), (req, res) => {
  const existing = getKeyById(req.params.id);
  if (!existing || existing.appId !== req.appId) {
    return res.status(404).json({ code: 'KEY_NOT_FOUND', message: 'API Key 不存在或无权访问' });
  }
  revokeKey(req.params.id);
  req.audit('api_key.revoke', null, `吊销密钥 ${existing.keyPrefix}...`);
  res.json({ code: 'SUCCESS', message: '已吊销', data: { id: req.params.id, isActive: false, status: 'revoked' } });
});

router.post('/api-keys/:id/rotate', authMiddleware, requirePermission('admin'), (req, res) => {
  const existing = getKeyById(req.params.id);
  if (!existing || existing.appId !== req.appId) {
    return res.status(404).json({ code: 'KEY_NOT_FOUND', message: 'API Key 不存在或无权访问' });
  }
  const { gracePeriodMinutes = 60 } = req.body || {};
  const result = rotateKey(req.params.id, gracePeriodMinutes);
  if (!result) {
    return res.status(400).json({ code: 'ROTATE_FAILED', message: '密钥轮换失败' });
  }
  req.audit('api_key.rotate', null, `轮换密钥 ${result.oldKey.keyPrefix}... → ${result.newKey.keyPrefix}...`);
  res.json({
    code: 'SUCCESS',
    message: '密钥已轮换，旧密钥进入宽限期',
    data: {
      oldKey: {
        id: result.oldKey.id,
        keyPrefix: result.oldKey.keyPrefix,
        status: result.oldKey.status,
        gracePeriodUntil: result.oldKey.gracePeriodUntil
      },
      newKey: {
        id: result.newKey.id,
        appId: result.newKey.appId,
        appName: result.newKey.appName,
        apiKey: result.newKey.apiKey,
        keyPrefix: result.newKey.keyPrefix,
        permissions: result.newKey.permissions,
        allowedTeamIds: result.newKey.allowedTeamIds,
        status: 'effective',
        createdAt: result.newKey.createdAt
      }
    }
  });
});

// ============ 审计日志（admin only） ============

router.get('/audit/logs', authMiddleware, requirePermission('admin'), (req, res) => {
  const { taskId, action, startTime, endTime, limit, offset } = req.query;
  const result = queryAuditLogs({
    appId: req.appId,
    taskId: taskId || null,
    action: action || null,
    startTime: startTime ? Number(startTime) : null,
    endTime: endTime ? Number(endTime) : null,
    limit: limit ? Math.min(Number(limit), 200) : 50,
    offset: offset ? Number(offset) : 0
  });
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: {
      logs: result.logs.map((l) => ({
        id: l.id,
        keyId: l.keyId,
        keyPrefix: l.keyPrefix,
        appName: l.appName,
        action: l.action,
        taskId: l.taskId,
        detail: l.detail,
        createdAt: l.createdAt
      })),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.logs.length < result.total
      }
    }
  });
});

// ============ 任务相关 ============

router.post('/tasks/batch', authMiddleware, requirePermission('tasks:read'), validateBatchGetTasks, (req, res) => {
  const result = taskService.batchGetTaskSummaries(req.body.taskIds, req.appId, req.allowedTeamIds);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  req.audit('task.batch_query', null, `批量查询 ${req.body.taskIds.length} 个任务`);
  res.json({ code: 'SUCCESS', message: '批量查询完成', data: result.data });
});

router.post('/tasks', authMiddleware, requirePermission('tasks:write'), validateSubmitTask, (req, res) => {
  const teamErr = checkTeamAllowed(req, req.body.teamId);
  if (teamErr) {
    return res.status(teamErr.httpStatus).json({ code: teamErr.code, message: teamErr.message });
  }
  const result = taskService.submitTask(req.body, req.appId);
  req.audit('task.submit', result.taskId, `提交任务 ${result.taskId}`);
  res.status(201).json({
    code: 'SUCCESS',
    message: '转写任务已提交',
    data: {
      taskId: result.taskId,
      status: result.status,
      createdAt: result.createdAt,
      _links: {
        query: { method: 'GET', href: `/api/tasks/${result.taskId}` },
        feedback: { method: 'POST', href: `/api/tasks/${result.taskId}/feedback` }
      }
    }
  });
});

router.get('/tasks', authMiddleware, requirePermission('tasks:read'), (req, res) => {
  const { teamId, status, startTime, endTime, limit, offset } = req.query;
  const allowed = req.allowedTeamIds;
  let finalTeamId = teamId || null;
  if (allowed && allowed.length > 0) {
    if (teamId && !allowed.includes(teamId)) {
      return res.status(403).json({ code: 'TEAM_NOT_ALLOWED', message: `当前 API Key 无权访问团队 '${teamId}'` });
    }
    if (!teamId) finalTeamId = teamId;
  }
  const result = taskService.listTasks(req.appId, {
    teamId: finalTeamId,
    allowedTeamIds: allowed || null,
    status: status || null,
    startTime: startTime ? Number(startTime) : null,
    endTime: endTime ? Number(endTime) : null,
    limit: limit ? Math.min(Number(limit), 100) : 20,
    offset: offset ? Number(offset) : 0
  });
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: {
      tasks: result.tasks.map((t) => ({
        taskId: t.id,
        meetingName: t.meetingName,
        teamId: t.teamId,
        status: t.status,
        progress: calcProgress(t.status),
        segmentCount: t.segmentCount,
        createdAt: t.createdAt,
        completedAt: t.completedAt
      })),
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.tasks.length < result.total
      }
    }
  });
});

router.get('/tasks/:taskId', authMiddleware, requirePermission('tasks:read'), (req, res) => {
  const { taskId } = req.params;
  const result = taskService.getTaskResult(taskId, req.appId, req.allowedTeamIds);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  req.audit('task.query', taskId);
  res.json({ code: 'SUCCESS', message: '查询成功', data: result.data });
});

router.get('/tasks/:taskId/callbacks', authMiddleware, requirePermission('tasks:read'), (req, res) => {
  const result = taskService.getCallbackHistory(req.params.taskId, req.appId, req.allowedTeamIds);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  res.json({ code: 'SUCCESS', message: '查询成功', data: result.data });
});

router.post('/tasks/:taskId/callbacks/retry', authMiddleware, requirePermission('tasks:write'), (req, res) => {
  const result = taskService.retryCallback(req.params.taskId, req.appId, req.allowedTeamIds);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  req.audit('callback.retry', req.params.taskId, `手动重放第 ${result.data.attempt} 次`);
  res.status(202).json({ code: 'SUCCESS', message: '已触发回调重放', data: result.data });
});

router.post('/tasks/:taskId/feedback', authMiddleware, requirePermission('feedback:write'), validateFeedback, (req, res) => {
  const teamErr = checkTeamAllowed(req, req.body.teamId);
  if (teamErr) {
    return res.status(teamErr.httpStatus).json({ code: teamErr.code, message: teamErr.message });
  }
  const { taskId } = req.params;
  const result = taskService.submitFeedback(taskId, req.body, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message, details: result.error.details || null });
  }
  req.audit('feedback.submit', taskId, `提交 ${result.data.appliedCount} 条修正`);
  res.json({ code: 'SUCCESS', message: '反馈已接收', data: result.data });
});

router.get('/teams/:teamId/learning', authMiddleware, requirePermission('tasks:read'), (req, res) => {
  const teamErr = checkTeamAllowed(req, req.params.teamId);
  if (teamErr) {
    return res.status(teamErr.httpStatus).json({ code: teamErr.code, message: teamErr.message });
  }
  const { teamId } = req.params;
  const overview = taskService.getTeamLearning(teamId, req.appId);
  if (!overview) {
    return res.status(404).json({ code: 'TEAM_NOT_FOUND', message: '团队学习数据不存在' });
  }
  res.json({ code: 'SUCCESS', message: '查询成功', data: overview });
});

const calcProgress = (status) => {
  switch (status) {
    case 'pending': return 0;
    case 'processing': return 50;
    case 'completed': return 100;
    case 'failed': return 100;
    default: return 0;
  }
};

module.exports = router;

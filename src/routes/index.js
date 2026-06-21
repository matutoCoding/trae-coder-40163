const express = require('express');
const taskService = require('../services/taskService');
const { authMiddleware, requirePermission } = require('../middleware/auth');
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
  updateKey
} = require('../repositories/apiKeyRepository');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-transcription-service',
    version: '1.1.0',
    timestamp: Date.now()
  });
});

function checkTeamAllowed(req, teamId) {
  const allowed = req.allowedTeamIds;
  if (!allowed || allowed.length === 0) return null;
  if (!teamId) return null;
  if (allowed.includes(teamId)) return null;
  return {
    httpStatus: 403,
    code: 'TEAM_NOT_ALLOWED',
    message: `当前 API Key 无权访问团队 '${teamId}'`
  };
}

function filterListByAllowedTeams(req, filters) {
  const allowed = req.allowedTeamIds;
  if (!allowed || allowed.length === 0) return filters;
  if (!filters.teamId) {
    if (!allowed.includes(filters.teamId)) {
      filters.teamId = allowed[0];
    }
    return filters;
  }
  filters.allowedTeamIds = allowed;
  return filters;
}

// ============ API Key 管理（admin only） ============

router.post('/api-keys', authMiddleware, requirePermission('admin'), validateCreateApiKey, (req, res) => {
  const { appName, teamId, permissions, allowedTeamIds } = req.body;
  const created = generateApiKey(appName, teamId || null, {
    permissions,
    allowedTeamIds,
    appId: req.appId
  });
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
      createdAt: created.createdAt
    }
  });
});

router.get('/api-keys', authMiddleware, requirePermission('admin'), (_req, res) => {
  const keys = getKeysByAppId(_req.appId);
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
  res.json({ code: 'SUCCESS', message: '已吊销', data: { id: req.params.id, isActive: false } });
});

// ============ 任务相关 ============

router.post('/tasks/batch', authMiddleware, requirePermission('tasks:read'), validateBatchGetTasks, (req, res) => {
  const result = taskService.batchGetTaskSummaries(req.body.taskIds, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  res.json({ code: 'SUCCESS', message: '批量查询完成', data: result.data });
});

router.post('/tasks', authMiddleware, requirePermission('tasks:write'), validateSubmitTask, (req, res) => {
  const teamErr = checkTeamAllowed(req, req.body.teamId);
  if (teamErr) {
    return res.status(teamErr.httpStatus).json({ code: teamErr.code, message: teamErr.message });
  }
  const result = taskService.submitTask(req.body, req.appId);
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
  const result = taskService.getTaskResult(taskId, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  res.json({ code: 'SUCCESS', message: '查询成功', data: result.data });
});

router.get('/tasks/:taskId/callbacks', authMiddleware, requirePermission('tasks:read'), (req, res) => {
  const result = taskService.getCallbackHistory(req.params.taskId, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
  res.json({ code: 'SUCCESS', message: '查询成功', data: result.data });
});

router.post('/tasks/:taskId/callbacks/retry', authMiddleware, requirePermission('tasks:write'), (req, res) => {
  const result = taskService.retryCallback(req.params.taskId, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({ code: result.error.code, message: result.error.message });
  }
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

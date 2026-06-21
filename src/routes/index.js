const express = require('express');
const taskService = require('../services/taskService');
const authMiddleware = require('../middleware/auth');
const { validateSubmitTask, validateFeedback } = require('../middleware/validators');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-transcription-service',
    version: '1.0.0',
    timestamp: Date.now()
  });
});

router.post('/tasks', authMiddleware, validateSubmitTask, (req, res) => {
  const result = taskService.submitTask(req.body, req.appId);
  res.status(201).json({
    code: 'SUCCESS',
    message: '转写任务已提交',
    data: {
      taskId: result.taskId,
      status: result.status,
      createdAt: result.createdAt,
      _links: {
        query: {
          method: 'GET',
          href: `/api/tasks/${result.taskId}`
        },
        feedback: {
          method: 'POST',
          href: `/api/tasks/${result.taskId}/feedback`
        }
      }
    }
  });
});

router.get('/tasks', authMiddleware, (req, res) => {
  const { teamId, status, startTime, endTime, limit, offset } = req.query;
  const result = taskService.listTasks(req.appId, {
    teamId: teamId || null,
    status: status || null,
    startTime: startTime ? Number(startTime) : null,
    endTime: endTime ? Number(endTime) : null,
    limit: limit ? Math.min(Number(limit), 100) : 20,
    offset: offset ? Number(offset) : 0
  });
  if (result.error) {
    return res.status(result.httpStatus || 400).json({
      code: result.error.code,
      message: result.error.message
    });
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

router.get('/tasks/:taskId', authMiddleware, (req, res) => {
  const { taskId } = req.params;
  const result = taskService.getTaskResult(taskId, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({
      code: result.error.code,
      message: result.error.message
    });
  }
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: result.data
  });
});

router.post('/tasks/:taskId/feedback', authMiddleware, validateFeedback, (req, res) => {
  const { taskId } = req.params;
  const result = taskService.submitFeedback(taskId, req.body, req.appId);
  if (result.error) {
    return res.status(result.httpStatus || 400).json({
      code: result.error.code,
      message: result.error.message
    });
  }
  res.json({
    code: 'SUCCESS',
    message: '反馈已接收',
    data: result.data
  });
});

router.get('/teams/:teamId/learning', authMiddleware, (req, res) => {
  const { teamId } = req.params;
  const overview = taskService.getTeamLearning(teamId, req.appId);
  if (!overview) {
    return res.status(404).json({
      code: 'TEAM_NOT_FOUND',
      message: '团队学习数据不存在'
    });
  }
  res.json({
    code: 'SUCCESS',
    message: '查询成功',
    data: overview
  });
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

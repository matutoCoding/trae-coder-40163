const express = require('express');
const taskService = require('../services/taskService');
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

router.post('/tasks', validateSubmitTask, (req, res) => {
  const result = taskService.submitTask(req.body);
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

router.get('/tasks/:taskId', (req, res) => {
  const { taskId } = req.params;
  const result = taskService.getTaskResult(taskId);
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

router.post('/tasks/:taskId/feedback', validateFeedback, (req, res) => {
  const { taskId } = req.params;
  const result = taskService.submitFeedback(taskId, req.body);
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

module.exports = router;

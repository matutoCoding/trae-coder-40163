const express = require('express');
const initDatabase = require('./db/schema');
const routes = require('./routes');
const { requestLogger } = require('./middleware/validators');

const createApp = () => {
  initDatabase();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(requestLogger);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Voice Transcription Service',
      description: '面向语音转写产品开发者的会议声纹分离后端服务',
      endpoints: {
        health: 'GET /api/health',
        submitTask: 'POST /api/tasks',
        listTasks: 'GET /api/tasks',
        queryResult: 'GET /api/tasks/:taskId',
        submitFeedback: 'POST /api/tasks/:taskId/feedback',
        teamLearning: 'GET /api/teams/:teamId/learning'
      },
      version: '1.0.0'
    });
  });

  app.use('/api', routes);

  app.use((req, res) => {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: `找不到资源: ${req.method} ${req.path}`
    });
  });

  app.use((err, req, res, _next) => {
    console.error('[Unhandled Error]', req.method, req.path, err.stack || err.message);
    const status = err.statusCode || err.status || 500;
    res.status(status).json({
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 ? '服务器内部错误' : err.message || '请求失败'
    });
  });

  return app;
};

if (require.main === module) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[Server] 语音转写服务已启动: http://localhost:${port}`);
    console.log(`[Server] 健康检查:   GET  http://localhost:${port}/api/health`);
    console.log(`[Server] 提交任务:   POST http://localhost:${port}/api/tasks`);
    console.log(`[Server] 查询结果:   GET  http://localhost:${port}/api/tasks/{taskId}`);
    console.log(`[Server] 提交反馈:   POST http://localhost:${port}/api/tasks/{taskId}/feedback`);
  });
}

module.exports = createApp;

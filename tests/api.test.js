process.env.NODE_ENV = 'test';

const request = require('supertest');
const { resetTestDb, sleep } = require('./helpers');
const { generateApiKey, validateKey, TEST_APP_ID, TEST_API_KEY } = require('../src/repositories/apiKeyRepository');

beforeEach(() => resetTestDb());
afterAll(() => resetTestDb());

const createTestApp = () => {
  const createApp = require('../src/app');
  return createApp();
};

describe('健康检查接口', () => {
  test('GET /api/health 返回健康状态', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('voice-transcription-service');
  });
});

describe('API Key 认证', () => {
  test('无 API Key 调用业务接口返回 401（生产模式）', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = require('../src/app')();
    const res = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('MISSING_API_KEY');
    process.env.NODE_ENV = origEnv;
  });

  test('无效 API Key 返回 401', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const app = require('../src/app')();
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer invalid_key_12345')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
    process.env.NODE_ENV = origEnv;
  });

  test('generateApiKey 生成有效凭证并可通过 validateKey 验证', () => {
    resetTestDb();
    require('../src/db');
    require('../src/db/schema')();
    const result = generateApiKey('My App', 'team-x');
    expect(result.apiKey).toMatch(/^vts_/);
    expect(result.appId).toMatch(/^app_/);
    const info = validateKey(result.apiKey);
    expect(info).toBeTruthy();
    expect(info.appId).toBe(result.appId);
    expect(info.appName).toBe('My App');
  });

  test('不同 appId 的任务互相隔离', async () => {
    const app = createTestApp();
    const res1 = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'App1 Task', teamId: 'team-a' });
    const taskId1 = res1.body.data.taskId;

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
    require('../src/db');
    require('../src/db/schema')();
    ensureTestKey();
    const otherKey = generateApiKey('Other App');
    const appProd = require('../src/app')();

    const res2 = await request(appProd)
      .get(`/api/tasks/${taskId1}`)
      .set('Authorization', `Bearer ${otherKey.apiKey}`);
    expect(res2.statusCode).toBe(404);
    expect(res2.body.code).toBe('TASK_NOT_FOUND');
    process.env.NODE_ENV = origEnv;
  });
});

describe('接口一：提交转写任务 POST /api/tasks', () => {
  test('必填参数校验失败返回 400', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ meetingName: '缺音频地址' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.some((e) => e.field === 'audioUrl')).toBe(true);
  });

  test('成功提交任务返回 taskId 和 201', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/meeting-001.mp3',
        meetingName: 'Q3 产品规划会',
        teamId: 'team-001',
        participants: [
          { speakerLabel: '发言人1', displayName: '张三' },
          { speakerLabel: '发言人2', displayName: '李四' }
        ]
      });
    expect(res.statusCode).toBe(201);
    expect(res.body.code).toBe('SUCCESS');
    expect(res.body.data.taskId).toBeTruthy();
    expect(res.body.data.status).toBe('pending');
  });

  test('提交超长会议名被校验拒绝', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://example.com/a.mp3', meetingName: 'A'.repeat(300) });
    expect(res.statusCode).toBe(400);
  });

  test('participants 数组含空值返回参数校验错误', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/a.mp3',
        meetingName: '空参会人测试',
        participants: [null, { speakerLabel: '发言人1', displayName: '张三' }, undefined]
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.some((e) => e.field === 'participants[0]')).toBe(true);
    expect(res.body.errors.some((e) => e.field === 'participants[2]')).toBe(true);
  });

  test('participants 含非法 speakerLabel 类型返回校验错误', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/a.mp3',
        meetingName: '类型测试',
        participants: [{ speakerLabel: 123, displayName: '数字标签' }]
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.errors.some((e) => e.field === 'participants[0].speakerLabel')).toBe(true);
  });
});

describe('接口二：查询分离结果 GET /api/tasks/:taskId', () => {
  test('查询不存在的任务返回 404', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  test('提交后立即查询状态为 pending 或 processing', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/meeting-a.mp3',
        meetingName: '例会',
        teamId: 'team-alpha',
        participants: [
          { speakerLabel: '发言人1', displayName: '张三' },
          { speakerLabel: '发言人2', displayName: '李四' }
        ]
      });
    const taskId = submit.body.data.taskId;
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(['pending', 'processing', 'completed']).toContain(res.body.data.status);
    expect(res.body.data.meetingName).toBe('例会');
    expect(res.body.data.participants.length).toBe(2);
  });

  test('等待处理完成后可查询到按发言人分组的结果', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/wait-test.mp3',
        meetingName: '等待完成测试',
        teamId: 'team-beta'
      });
    const taskId = submit.body.data.taskId;

    await sleep(800);

    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.progress).toBe(100);
    expect(res.body.data.segments.length).toBeGreaterThan(0);
    expect(res.body.data.speakers.length).toBeGreaterThan(0);

    const firstSeg = res.body.data.segments[0];
    expect(firstSeg.id).toBeTruthy();
    expect(typeof firstSeg.speakerLabel).toBe('string');
    expect(firstSeg.endTime).toBeGreaterThan(firstSeg.startTime);
  });

  test('带回调 URL 的任务完成后查询可看到回调状态', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://x.com/cb-test.mp3',
        meetingName: '回调测试',
        callbackUrl: 'https://example.com/callback'
      });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.callback).toBeTruthy();
    expect(res.body.data.callback.url).toBe('https://example.com/callback');
    expect(res.body.data.callback.status).toBe('delivered');
    expect(res.body.data.callback.attempts).toBeGreaterThanOrEqual(1);
    expect(res.body.data.callback.recentLogs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('接口三：任务列表 GET /api/tasks', () => {
  test('可按 teamId 筛选任务列表', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'Team A 1', teamId: 'team-a' });
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/b.mp3', meetingName: 'Team B 1', teamId: 'team-b' });
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/c.mp3', meetingName: 'Team A 2', teamId: 'team-a' });

    await sleep(800);

    const res = await request(app).get('/api/tasks?teamId=team-a');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.length).toBe(2);
    expect(res.body.data.tasks.every((t) => t.teamId === 'team-a')).toBe(true);
    expect(res.body.data.pagination.total).toBe(2);
  });

  test('列表包含进度、会议名、片段数和分页信息', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/list.mp3', meetingName: '列表测试', teamId: 'team-l' });

    await sleep(800);

    const res = await request(app).get('/api/tasks?teamId=team-l');
    expect(res.statusCode).toBe(200);
    const task = res.body.data.tasks[0];
    expect(task.meetingName).toBe('列表测试');
    expect(typeof task.progress).toBe('number');
    expect(typeof task.segmentCount).toBe('number');
    expect(typeof task.createdAt).toBe('number');
    expect(res.body.data.pagination).toBeTruthy();
    expect(typeof res.body.data.pagination.total).toBe('number');
  });

  test('按状态筛选', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/status.mp3', meetingName: '状态筛选' });

    await sleep(800);

    const res = await request(app).get('/api/tasks?status=completed');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.every((t) => t.status === 'completed')).toBe(true);
  });

  test('分页参数生效', async () => {
    const app = createTestApp();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/tasks')
        .send({ audioUrl: `https://x.com/p${i}.mp3`, meetingName: `分页${i}` });
    }

    const res = await request(app).get('/api/tasks?limit=2&offset=0');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.length).toBeLessThanOrEqual(2);
    expect(res.body.data.pagination.limit).toBe(2);
  });
});

describe('接口四：反馈修正样本 POST /api/tasks/:taskId/feedback', () => {
  test('给不存在的任务提交反馈返回 404', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks/not-exist/feedback')
      .send({ corrections: [{ type: 'text_correction', segmentId: 1, newText: 'x' }] });
    expect(res.statusCode).toBe(404);
  });

  test('空 corrections 被校验拒绝', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
    const res = await request(app)
      .post(`/api/tasks/${submit.body.data.taskId}/feedback`)
      .send({ corrections: [] });
    expect(res.statusCode).toBe(400);
  });

  test('反馈中引用不属于当前任务的 segmentId 返回 400', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/owner.mp3', meetingName: '归属测试', teamId: 'team-o' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-o',
        corrections: [
          { type: 'text_correction', segmentId: 99999, newText: '别的任务的片段' }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.skippedCount).toBe(1);
    expect(fb.body.data.errors[0].code).toBe('SEGMENT_NOT_BELONG');
  });

  test('segment_merge 引用不属于当前任务的片段返回 SEGMENT_NOT_BELONG', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/mo.mp3', meetingName: '归属合并', teamId: 'team-mo' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-mo',
        corrections: [
          { type: 'segment_merge', segmentIds: [99997, 99998] }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.skippedCount).toBe(1);
    expect(fb.body.data.errors[0].code).toBe('SEGMENT_NOT_BELONG');
  });

  test('成功执行 speaker_rename 作用域=segment', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/rename-seg.mp3', meetingName: '重命名测试', teamId: 'team-t' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const targetSeg = before.body.data.segments[0];
    const originalLabel = targetSeg.speakerLabel;

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-t',
        corrections: [
          { type: 'speaker_rename', segmentId: targetSeg.id, newSpeakerLabel: '张三', scope: 'segment' }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);
    expect(fb.body.data.feedbacks[0].newValue).toBe('张三');

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const updatedSeg = after.body.data.segments.find((s) => s.id === targetSeg.id);
    expect(updatedSeg.speakerLabel).toBe('张三');
    expect(updatedSeg.originalSpeakerLabel).toBe(originalLabel);
  });

  test('成功执行 speaker_rename 作用域=task 全任务替换', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/rename-task.mp3', meetingName: 'T', teamId: 'team-x' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const labelSet = new Set(before.body.data.segments.map((s) => s.speakerLabel));
    const targetLabel = [...labelSet][0];

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-x',
        corrections: [
          { type: 'speaker_rename', oldSpeakerLabel: targetLabel, newSpeakerLabel: '王五', scope: 'task' }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const renamedCount = after.body.data.segments.filter((s) => s.speakerLabel === '王五').length;
    expect(renamedCount).toBeGreaterThanOrEqual(1);
  });

  test('成功执行 segment_merge 合并相邻片段', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/merge.mp3', meetingName: '合并测试', teamId: 'team-m' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const mergeCandidates = before.body.data.segments.slice(0, 2).map((s) => s.id);

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-m',
        corrections: [{ type: 'segment_merge', segmentIds: mergeCandidates }]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const mergedId = fb.body.data.feedbacks[0].segmentId;
    const mergedSeg = after.body.data.segments.find((s) => s.id === mergedId);
    expect(mergedSeg).toBeTruthy();
    expect(mergedSeg.mergedFrom.length).toBe(2);
    expect(mergedSeg.mergedFrom).toEqual(expect.arrayContaining(mergeCandidates));
  });

  test('成功执行 text_correction 文本修正', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/text.mp3', meetingName: '文本测试', teamId: 'team-x' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const targetSeg = before.body.data.segments[0];
    const newText = '这是经过用户手动修正后的准确文本内容。';

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-x',
        corrections: [{ type: 'text_correction', segmentId: targetSeg.id, newText }]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const updatedSeg = after.body.data.segments.find((s) => s.id === targetSeg.id);
    expect(updatedSeg.textContent).toBe(newText);
  });

  test('同 team 的 speaker_rename 反馈会优化后续任务的识别', async () => {
    const app = createTestApp();

    const firstSubmit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/learn-1.mp3', meetingName: '学习会议1', teamId: 'team-learn' });
    const task1Id = firstSubmit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${task1Id}`);
    const labelSet = new Set(before.body.data.segments.map((s) => s.speakerLabel));
    const targetLabel = [...labelSet][0];

    await request(app)
      .post(`/api/tasks/${task1Id}/feedback`)
      .send({
        teamId: 'team-learn',
        corrections: [
          { type: 'speaker_rename', oldSpeakerLabel: targetLabel, newSpeakerLabel: '赵经理', scope: 'team' }
        ]
      });

    await sleep(100);

    const secondSubmit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/learn-2.mp3', meetingName: '学习会议2', teamId: 'team-learn' });
    const task2Id = secondSubmit.body.data.taskId;
    await sleep(800);

    const after = await request(app).get(`/api/tasks/${task2Id}`);
    const hasZhao = after.body.data.segments.some((s) => s.speakerLabel === '赵经理');
    expect(hasZhao).toBe(true);
  });
});

describe('接口五：团队学习概览 GET /api/teams/:teamId/learning', () => {
  test('未提交过反馈的团队返回零值概览', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/teams/team-empty/learning');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.totalFeedback).toBe(0);
    expect(res.body.data.speakerMappings.length).toBe(0);
  });

  test('提交反馈后可查看团队学习概览', async () => {
    const app = createTestApp();

    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/lo.mp3', meetingName: '学习概览', teamId: 'team-lo' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const seg = before.body.data.segments[0];
    const label = seg.speakerLabel;

    await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-lo',
        corrections: [
          { type: 'speaker_rename', segmentId: seg.id, newSpeakerLabel: '钱总', scope: 'segment' },
          { type: 'text_correction', segmentId: seg.id, newText: '修正后文本' }
        ]
      });

    const res = await request(app).get('/api/teams/team-lo/learning');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.teamId).toBe('team-lo');
    expect(res.body.data.totalFeedback).toBeGreaterThanOrEqual(2);
    expect(res.body.data.totalRenameCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.totalTextCorrectionCount).toBeGreaterThanOrEqual(1);
    expect(res.body.data.speakerMappings.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.speakerMappings[0].from).toBe(label);
    expect(res.body.data.speakerMappings[0].to).toBe('钱总');
    expect(res.body.data.recentFeedback.length).toBeGreaterThan(0);
    expect(res.body.data.tasksWithFeedback).toBeGreaterThanOrEqual(1);
  });
});

describe('错误路由和全局异常', () => {
  test('访问不存在的路由返回 404', async () => {
    const app = createTestApp();
    const res = await request(app).get('/no/such/path');
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('非法 JSON 请求体返回 400', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{this is not json}');
    expect(res.statusCode).toBe(400);
  });
});

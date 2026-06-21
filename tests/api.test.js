process.env.NODE_ENV = 'test';

const request = require('supertest');
const { resetTestDb, sleep } = require('./helpers');

beforeEach(() => resetTestDb());
afterAll(() => resetTestDb());

describe('健康检查接口', () => {
  test('GET /api/health 返回健康状态', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('voice-transcription-service');
  });
});

describe('接口一：提交转写任务 POST /api/tasks', () => {
  test('必填参数校验失败返回 400', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({ meetingName: '缺音频地址' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.some((e) => e.field === 'audioUrl')).toBe(true);
  });

  test('成功提交任务返回 taskId 和 201', async () => {
    const createApp = require('../src/app');
    const app = createApp();
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
    expect(res.body.data._links.query.href).toMatch(/\/api\/tasks\/.+/);
  });

  test('提交超长会议名被校验拒绝', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/a.mp3',
        meetingName: 'A'.repeat(300)
      });
    expect(res.statusCode).toBe(400);
  });
});

describe('接口二：查询分离结果 GET /api/tasks/:taskId', () => {
  test('查询不存在的任务返回 404', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  test('提交后立即查询状态为 pending 或 processing', async () => {
    const createApp = require('../src/app');
    const app = createApp();
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
    expect(res.body.code).toBe('SUCCESS');
    expect(['pending', 'processing', 'completed']).toContain(res.body.data.status);
    expect(res.body.data.meetingName).toBe('例会');
    expect(res.body.data.teamId).toBe('team-alpha');
    expect(res.body.data.participants.length).toBe(2);
  });

  test('等待处理完成后可查询到按发言人分组的结果', async () => {
    const createApp = require('../src/app');
    const app = createApp();
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
    expect(res.body.code).toBe('SUCCESS');
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.progress).toBe(100);
    expect(Array.isArray(res.body.data.segments)).toBe(true);
    expect(res.body.data.segments.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data.speakers)).toBe(true);
    expect(res.body.data.speakers.length).toBeGreaterThan(0);

    const firstSeg = res.body.data.segments[0];
    expect(firstSeg.id).toBeTruthy();
    expect(typeof firstSeg.speakerLabel).toBe('string');
    expect(typeof firstSeg.startTime).toBe('number');
    expect(typeof firstSeg.endTime).toBe('number');
    expect(typeof firstSeg.textContent).toBe('string');
    expect(firstSeg.endTime).toBeGreaterThan(firstSeg.startTime);

    const firstSpeaker = res.body.data.speakers[0];
    expect(firstSpeaker.speakerLabel).toBeTruthy();
    expect(typeof firstSpeaker.totalDuration).toBe('number');
    expect(firstSpeaker.segmentCount).toBeGreaterThan(0);
  });
});

describe('接口三：反馈修正样本 POST /api/tasks/:taskId/feedback', () => {
  test('给不存在的任务提交反馈返回 404', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks/not-exist/feedback')
      .send({ corrections: [{ type: 'text_correction', segmentId: 1, newText: 'x' }] });
    expect(res.statusCode).toBe(404);
  });

  test('空 corrections 被校验拒绝', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
    const res = await request(app)
      .post(`/api/tasks/${submit.body.data.taskId}/feedback`)
      .send({ corrections: [] });
    expect(res.statusCode).toBe(400);
  });

  test('成功执行 speaker_rename 作用域=segment', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://x.com/rename-seg.mp3',
        meetingName: '重命名测试',
        teamId: 'team-t'
      });
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
          {
            type: 'speaker_rename',
            segmentId: targetSeg.id,
            newSpeakerLabel: '张三',
            scope: 'segment'
          }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.code).toBe('SUCCESS');
    expect(fb.body.data.appliedCount).toBe(1);
    expect(fb.body.data.feedbacks.length).toBe(1);
    expect(fb.body.data.feedbacks[0].newValue).toBe('张三');

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const updatedSeg = after.body.data.segments.find((s) => s.id === targetSeg.id);
    expect(updatedSeg.speakerLabel).toBe('张三');
    expect(updatedSeg.originalSpeakerLabel).toBe(originalLabel);
    expect(updatedSeg.correctedAt).toBeTruthy();
  });

  test('成功执行 speaker_rename 作用域=task 全任务替换', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/rename-task.mp3', meetingName: 'T', teamId: 'team-x' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const labelSet = new Set(before.body.data.segments.map((s) => s.speakerLabel));
    const targetLabel = [...labelSet][0];
    const beforeCount = before.body.data.segments.filter((s) => s.speakerLabel === targetLabel).length;

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-x',
        corrections: [
          {
            type: 'speaker_rename',
            oldSpeakerLabel: targetLabel,
            newSpeakerLabel: '王五',
            scope: 'task'
          }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const renamedCount = after.body.data.segments.filter((s) => s.speakerLabel === '王五').length;
    expect(renamedCount).toBeGreaterThanOrEqual(beforeCount);
  });

  test('成功执行 segment_merge 合并相邻片段', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/merge.mp3', meetingName: '合并测试', teamId: 'team-m' });
    const taskId = submit.body.data.taskId;
    await sleep(800);

    const before = await request(app).get(`/api/tasks/${taskId}`);
    const mergeCandidates = before.body.data.segments.slice(0, 2).map((s) => s.id);
    const segA = before.body.data.segments[0];
    const segB = before.body.data.segments[1];
    const expectedStart = Math.min(segA.startTime, segB.startTime);
    const expectedEnd = Math.max(segA.endTime, segB.endTime);

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({
        teamId: 'team-m',
        corrections: [
          {
            type: 'segment_merge',
            segmentIds: mergeCandidates
          }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const mergedId = fb.body.data.feedbacks[0].segmentId;
    const mergedSeg = after.body.data.segments.find((s) => s.id === mergedId);
    expect(mergedSeg).toBeTruthy();
    expect(mergedSeg.startTime).toBeCloseTo(expectedStart, 1);
    expect(mergedSeg.endTime).toBeCloseTo(expectedEnd, 1);
    expect(mergedSeg.mergedFrom.length).toBe(2);
    expect(mergedSeg.mergedFrom).toEqual(expect.arrayContaining(mergeCandidates));
  });

  test('成功执行 text_correction 文本修正', async () => {
    const createApp = require('../src/app');
    const app = createApp();
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
        corrections: [
          {
            type: 'text_correction',
            segmentId: targetSeg.id,
            oldText: targetSeg.textContent,
            newText
          }
        ]
      });
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(1);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const updatedSeg = after.body.data.segments.find((s) => s.id === targetSeg.id);
    expect(updatedSeg.textContent).toBe(newText);
    expect(updatedSeg.correctedAt).toBeTruthy();
  });

  test('同 team 的 speaker_rename 反馈会优化后续任务的识别', async () => {
    const createApp = require('../src/app');
    const app = createApp();

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
          {
            type: 'speaker_rename',
            oldSpeakerLabel: targetLabel,
            newSpeakerLabel: '赵经理',
            scope: 'team'
          }
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

describe('错误路由和全局异常', () => {
  test('访问不存在的路由返回 404', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app).get('/no/such/path');
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('非法 JSON 请求体返回 400', async () => {
    const createApp = require('../src/app');
    const app = createApp();
    const res = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{this is not json}');
    expect(res.statusCode).toBe(400);
  });
});

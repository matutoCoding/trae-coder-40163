process.env.NODE_ENV = 'test';

const request = require('supertest');
const { resetTestDb, sleep } = require('./helpers');
const { generateApiKey, validateKey, rotateKey, TEST_APP_ID } = require('../src/repositories/apiKeyRepository');

beforeEach(() => resetTestDb());
afterAll(() => resetTestDb());

const createTestApp = () => {
  const createApp = require('../src/app');
  return createApp();
};

const submitAndWait = async (app, payload) => {
  const submit = await request(app).post('/api/tasks').send(payload);
  const taskId = submit.body.data.taskId;
  await sleep(800);
  return taskId;
};

describe('健康检查接口', () => {
  test('GET /api/health 返回健康状态', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('API Key 认证', () => {
  test('无 API Key 调用业务接口返回 401（生产模式）', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = require('../src/app')();
      const res = await request(app)
        .post('/api/tasks')
        .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('MISSING_API_KEY');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('无效 API Key 返回 401', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = require('../src/app')();
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', 'Bearer invalid_key_12345')
        .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'M' });
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('INVALID_API_KEY');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('generateApiKey 生成有效凭证并可通过 validateKey 验证，返回权限和团队范围', () => {
    resetTestDb();
    require('../src/db');
    require('../src/db/schema')();
    const result = generateApiKey('My App', 'team-x', {
      permissions: ['tasks:read', 'feedback:write'],
      allowedTeamIds: ['team-x', 'team-y']
    });
    expect(result.apiKey).toMatch(/^vts_/);
    expect(result.permissions).toEqual(['tasks:read', 'feedback:write']);
    expect(result.allowedTeamIds).toEqual(['team-x', 'team-y']);
    const info = validateKey(result.apiKey);
    expect(info).toBeTruthy();
    expect(info.appId).toBe(result.appId);
    expect(info.permissions).toEqual(['tasks:read', 'feedback:write']);
    expect(info.allowedTeamIds).toEqual(['team-x', 'team-y']);
  });

  test('不同 appId 的任务互相隔离', async () => {
    const app = createTestApp();
    const res1 = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/a.mp3', meetingName: 'App1 Task', teamId: 'team-a' });
    const taskId1 = res1.body.data.taskId;

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
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
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});

describe('API Key 管理接口', () => {
  test('POST /api/api-keys 创建密钥，响应仅本次展示完整 apiKey', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/api-keys')
      .send({
        appName: 'CRM 集成应用',
        permissions: ['tasks:write', 'tasks:read'],
        allowedTeamIds: ['team-crm-a', 'team-crm-b']
      });
    expect(res.statusCode).toBe(201);
    expect(res.body.data.apiKey).toMatch(/^vts_/);
    expect(res.body.data.appName).toBe('CRM 集成应用');
    expect(res.body.data.permissions).toEqual(['tasks:write', 'tasks:read']);
    expect(res.body.data.allowedTeamIds).toEqual(['team-crm-a', 'team-crm-b']);
    expect(res.body.data.keyPrefix).toBeTruthy();
  });

  test('GET /api/api-keys 列表不包含完整 apiKey（仅 keyPrefix），含 status 字段', async () => {
    const app = createTestApp();
    await request(app).post('/api/api-keys').send({ appName: 'A', permissions: ['tasks:read'] });
    await request(app).post('/api/api-keys').send({ appName: 'B', permissions: ['tasks:write'] });
    const res = await request(app).get('/api/api-keys');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.total).toBeGreaterThanOrEqual(3);
    for (const k of res.body.data.keys) {
      expect(k.apiKey).toBeUndefined();
      expect(k.keyPrefix).toBeTruthy();
      expect(k.isActive).toBe(true);
      expect(k.status).toBe('effective');
      expect(k.gracePeriodUntil).toBeNull();
    }
  });

  test('GET /api/api-keys/:id 查看详情含 status', async () => {
    const app = createTestApp();
    const create = await request(app)
      .post('/api/api-keys')
      .send({ appName: '详情测试', permissions: ['tasks:read'] });
    const id = create.body.data.id;
    const res = await request(app).get(`/api/api-keys/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.appName).toBe('详情测试');
    expect(res.body.data.apiKey).toBeUndefined();
    expect(res.body.data.keyPrefix).toBeTruthy();
    expect(res.body.data.status).toBe('effective');
  });

  test('PUT /api/api-keys/:id 更新权限和团队范围', async () => {
    const app = createTestApp();
    const create = await request(app)
      .post('/api/api-keys')
      .send({ appName: '更新测试', permissions: ['tasks:read'] });
    const id = create.body.data.id;
    const res = await request(app)
      .put(`/api/api-keys/${id}`)
      .send({ appName: '更新后的名字', permissions: ['tasks:read', 'feedback:write'], allowedTeamIds: ['team-new'] });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.appName).toBe('更新后的名字');
    expect(res.body.data.permissions).toEqual(['tasks:read', 'feedback:write']);
    expect(res.body.data.allowedTeamIds).toEqual(['team-new']);
  });

  test('DELETE /api/api-keys/:id 吊销密钥，随后调用返回 401', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();

      const newKey = generateApiKey('待吊销', null, { appId: TEST_APP_ID });
      const appProd = require('../src/app')();
      const testKey = require('../src/repositories/apiKeyRepository').TEST_API_KEY;

      const del = await request(appProd)
        .delete(`/api/api-keys/${newKey.id}`)
        .set('Authorization', `Bearer ${testKey}`);
      expect(del.statusCode).toBe(200);
      expect(del.body.data.isActive).toBe(false);
      expect(del.body.data.status).toBe('revoked');

      const res = await request(appProd)
        .get('/api/tasks')
        .set('Authorization', `Bearer ${newKey.apiKey}`);
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('INVALID_API_KEY');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});

describe('API Key 轮换', () => {
  test('POST /api/api-keys/:id/rotate 生成新密钥，旧密钥进入宽限期', async () => {
    const app = createTestApp();
    const create = await request(app)
      .post('/api/api-keys')
      .send({ appName: '轮换测试', permissions: ['tasks:read', 'tasks:write'] });
    const id = create.body.data.id;

    const res = await request(app)
      .post(`/api/api-keys/${id}/rotate`)
      .send({ gracePeriodMinutes: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.oldKey.status).toBe('grace');
    expect(res.body.data.oldKey.gracePeriodUntil).toBeGreaterThan(Date.now());
    expect(res.body.data.newKey.apiKey).toMatch(/^vts_/);
    expect(res.body.data.newKey.status).toBe('effective');
  });

  test('轮换后旧密钥宽限期内仍可验证', () => {
    resetTestDb();
    require('../src/db');
    require('../src/db/schema')();
    const old = generateApiKey('宽限测试', null, { appId: TEST_APP_ID, permissions: ['tasks:read'] });
    const result = rotateKey(old.id, 60);
    expect(result.oldKey.status).toBe('grace');
    const info = validateKey(old.apiKey);
    expect(info).toBeTruthy();
    expect(info.keyPrefix).toBe(old.keyPrefix);
  });

  test('轮换后列表中旧密钥状态为 grace，新密钥为 effective', async () => {
    const app = createTestApp();
    const create = await request(app)
      .post('/api/api-keys')
      .send({ appName: '列表轮换', permissions: ['tasks:read'] });
    const id = create.body.data.id;
    await request(app).post(`/api/api-keys/${id}/rotate`).send({ gracePeriodMinutes: 30 });

    const res = await request(app).get('/api/api-keys');
    const keys = res.body.data.keys;
    const oldKey = keys.find((k) => k.id === id);
    expect(oldKey).toBeTruthy();
    expect(oldKey.status).toBe('grace');
    expect(oldKey.gracePeriodUntil).toBeGreaterThan(Date.now());
  });
});

describe('权限 & 团队范围 拦截', () => {
  test('仅 tasks:read 权限的 key 无法提交任务返回 403', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const readKey = generateApiKey('只读App', null, { appId: TEST_APP_ID, permissions: ['tasks:read'] });
      const appProd = require('../src/app')();

      const res = await request(appProd)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${readKey.apiKey}`)
        .send({ audioUrl: 'https://x.com/a.mp3', meetingName: '无权限' });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('allowedTeamIds 限制，非允许 team 的任务提交返回 403', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const limitedKey = generateApiKey('有限范围', null, {
        appId: TEST_APP_ID,
        permissions: ['tasks:write', 'tasks:read'],
        allowedTeamIds: ['team-a', 'team-b']
      });
      const appProd = require('../src/app')();

      const res = await request(appProd)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${limitedKey.apiKey}`)
        .send({ audioUrl: 'https://x.com/a.mp3', meetingName: '非允许团队', teamId: 'team-z' });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('TEAM_NOT_ALLOWED');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('受限 key 查询其他团队的单任务返回 403', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, { audioUrl: 'https://x.com/ta.mp3', meetingName: '团队A', teamId: 'team-a' });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const limitedKey = generateApiKey('受限', null, {
        appId: TEST_APP_ID,
        permissions: ['tasks:read'],
        allowedTeamIds: ['team-b']
      });
      const appProd = require('../src/app')();
      const res = await request(appProd)
        .get(`/api/tasks/${taskId}`)
        .set('Authorization', `Bearer ${limitedKey.apiKey}`);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('TEAM_NOT_ALLOWED');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('受限 key 批量查询中其他团队任务标为 FORBIDDEN', async () => {
    const app = createTestApp();
    const tid1 = await submitAndWait(app, { audioUrl: 'https://x.com/b1.mp3', meetingName: '批量A', teamId: 'team-a' });
    const tid2 = await submitAndWait(app, { audioUrl: 'https://x.com/b2.mp3', meetingName: '批量B', teamId: 'team-b' });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const limitedKey = generateApiKey('受限批量', null, {
        appId: TEST_APP_ID,
        permissions: ['tasks:read'],
        allowedTeamIds: ['team-a']
      });
      const appProd = require('../src/app')();
      const res = await request(appProd)
        .post('/api/tasks/batch')
        .set('Authorization', `Bearer ${limitedKey.apiKey}`)
        .send({ taskIds: [tid1, tid2] });
      expect(res.statusCode).toBe(200);
      const byId = {};
      for (const r of res.body.data.results) byId[r.taskId] = r;
      expect(byId[tid1].code).toBe('OK');
      expect(byId[tid2].code).toBe('FORBIDDEN');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  test('受限 key 查询其他团队任务的回调历史返回 403', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/cbh.mp3', meetingName: '回调团队', teamId: 'team-c',
      callbackUrl: 'https://cb.example.com/x'
    });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const limitedKey = generateApiKey('受限回调', null, {
        appId: TEST_APP_ID,
        permissions: ['tasks:read'],
        allowedTeamIds: ['team-d']
      });
      const appProd = require('../src/app')();
      const res = await request(appProd)
        .get(`/api/tasks/${taskId}/callbacks`)
        .set('Authorization', `Bearer ${limitedKey.apiKey}`);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('TEAM_NOT_ALLOWED');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
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
  });

  test('participants 数组含空值返回参数校验错误', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://example.com/a.mp3',
        meetingName: '空参会人测试',
        participants: [null, { speakerLabel: '发言人1' }, undefined]
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('提交任务时可传入 backupCallbackUrl', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/tasks')
      .send({
        audioUrl: 'https://x.com/backup.mp3',
        meetingName: '备用回调',
        callbackUrl: 'https://cb.example.com/primary',
        backupCallbackUrl: 'https://cb.example.com/backup'
      });
    expect(res.statusCode).toBe(201);
  });
});

describe('接口二：查询分离结果 GET /api/tasks/:taskId', () => {
  test('查询不存在的任务返回 404', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.statusCode).toBe(404);
  });

  test('等待处理完成后可查询到 completed 状态', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/done.mp3', meetingName: '完成测试', teamId: 'team-d'
    });
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.segments.length).toBeGreaterThan(0);
  });

  test('带回调 URL 的任务完成后查询可看到回调状态和 failureReason', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/cb.mp3', meetingName: '回调', callbackUrl: 'https://cb.example.com/hook',
      backupCallbackUrl: 'https://cb.example.com/backup'
    });
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.callback.url).toBe('https://cb.example.com/hook');
    expect(res.body.data.callback.backupUrl).toBe('https://cb.example.com/backup');
    expect(res.body.data.callback.status).toBe('delivered');
    expect(res.body.data.callback.attempts).toBeGreaterThanOrEqual(1);
    expect(res.body.data.callback.failureReason).toBeNull();
  });
});

describe('接口三：任务列表 GET /api/tasks', () => {
  test('可按 teamId 筛选，含进度和片段数量', async () => {
    const app = createTestApp();
    await submitAndWait(app, { audioUrl: 'https://x.com/a1.mp3', meetingName: 'T1', teamId: 'team-li' });
    await submitAndWait(app, { audioUrl: 'https://x.com/a2.mp3', meetingName: 'T2', teamId: 'team-li' });
    const res = await request(app).get('/api/tasks?teamId=team-li');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.tasks.length).toBe(2);
    expect(typeof res.body.data.tasks[0].segmentCount).toBe('number');
    expect(typeof res.body.data.tasks[0].progress).toBe('number');
  });
});

describe('接口四：反馈修正样本 POST /api/tasks/:taskId/feedback', () => {
  test('引用不属于当前任务的 segmentId 返回 400', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, { audioUrl: 'https://x.com/fo.mp3', meetingName: 'F', teamId: 'team-fo' });
    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({ teamId: 'team-fo', corrections: [
        { type: 'text_correction', segmentId: 99999, newText: '错的片段' }
      ]});
    expect(fb.statusCode).toBe(400);
    expect(fb.body.code).toBe('SEGMENT_NOT_BELONG');
  });

  test('segment_merge 引用不属于当前任务的片段返回 400', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, { audioUrl: 'https://x.com/fm.mp3', meetingName: 'M', teamId: 'team-fm' });
    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({ teamId: 'team-fm', corrections: [
        { type: 'segment_merge', segmentIds: [88888, 99999] }
      ]});
    expect(fb.statusCode).toBe(400);
    expect(fb.body.code).toBe('SEGMENT_NOT_BELONG');
  });

  test('成功 speaker_rename (segment) + text_correction', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, { audioUrl: 'https://x.com/ok.mp3', meetingName: 'OK', teamId: 'team-ok' });
    const before = await request(app).get(`/api/tasks/${taskId}`);
    const seg = before.body.data.segments[0];
    const label = seg.speakerLabel;

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({ teamId: 'team-ok', corrections: [
        { type: 'speaker_rename', segmentId: seg.id, newSpeakerLabel: '孙七', scope: 'segment' },
        { type: 'text_correction', segmentId: seg.id, newText: '准确内容' }
      ]});
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(2);

    const after = await request(app).get(`/api/tasks/${taskId}`);
    const s = after.body.data.segments.find((x) => x.id === seg.id);
    expect(s.speakerLabel).toBe('孙七');
    expect(s.originalSpeakerLabel).toBe(label);
    expect(s.textContent).toBe('准确内容');
  });

  test('segment_merge + team 级别 speaker_rename', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, { audioUrl: 'https://x.com/m2.mp3', meetingName: '合并', teamId: 'team-mg' });
    const before = await request(app).get(`/api/tasks/${taskId}`);
    const [a, b] = before.body.data.segments;
    const oldLabel = a.speakerLabel;

    const fb = await request(app)
      .post(`/api/tasks/${taskId}/feedback`)
      .send({ teamId: 'team-mg', corrections: [
        { type: 'segment_merge', segmentIds: [a.id, b.id] },
        { type: 'speaker_rename', oldSpeakerLabel: oldLabel, newSpeakerLabel: '周总', scope: 'team' }
      ]});
    expect(fb.statusCode).toBe(200);
    expect(fb.body.data.appliedCount).toBe(2);
  });
});

describe('接口五：回调历史 + 重放 + 失败原因', () => {
  test('GET /api/tasks/:taskId/callbacks 返回回调日志列表含 failureReason', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/ch.mp3', meetingName: '回调历史', callbackUrl: 'https://cb.example.com/a'
    });
    const res = await request(app).get(`/api/tasks/${taskId}/callbacks`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.url).toBe('https://cb.example.com/a');
    expect(res.body.data.status).toBe('delivered');
    expect(res.body.data.logs.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.logs[0].statusCode).toBe(200);
    expect(res.body.data.logs[0].attempt).toBe(1);
    expect(res.body.data.failureReason).toBeNull();
  });

  test('回调历史含 backupUrl 字段', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/bk.mp3', meetingName: '备用回调',
      callbackUrl: 'https://cb.example.com/p', backupCallbackUrl: 'https://cb.example.com/b'
    });
    const res = await request(app).get(`/api/tasks/${taskId}/callbacks`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.backupUrl).toBe('https://cb.example.com/b');
  });

  test('已成功回调的任务重放返回 400 NO_FAILED_CALLBACK', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/nofail.mp3', meetingName: '未失败', callbackUrl: 'https://cb.example.com/nf'
    });
    const res = await request(app).post(`/api/tasks/${taskId}/callbacks/retry`);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('NO_FAILED_CALLBACK');
  });

  test('未配置回调的任务重放返回 400', async () => {
    const app = createTestApp();
    const taskId = await submitAndWait(app, {
      audioUrl: 'https://x.com/nocb.mp3', meetingName: '无回调'
    });
    const res = await request(app).post(`/api/tasks/${taskId}/callbacks/retry`);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('CALLBACK_NOT_CONFIGURED');
  });
});

describe('接口六：批量查询 POST /api/tasks/batch', () => {
  test('批量查询返回单条独立状态（success/processing/not_found/forbidden）', async () => {
    const app = createTestApp();
    const tid1 = await submitAndWait(app, { audioUrl: 'https://x.com/b1.mp3', meetingName: '批量1', teamId: 'team-bt' });

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const otherKey = generateApiKey('Other');
      require('../src/repositories/taskRepository').createTask({
        id: 'task-other-app-001',
        appId: otherKey.appId,
        audioUrl: 'https://x.com/other.mp3',
        meetingName: '其他App的任务',
        teamId: 'team-bt',
        callbackUrl: null,
        backupCallbackUrl: null,
        createdAt: Date.now()
      });
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    const tid2 = 'task-other-app-001';

    const res = await request(app)
      .post('/api/tasks/batch')
      .send({ taskIds: [tid1, tid2, 'not-exist-1234', null] });

    expect(res.statusCode).toBe(200);
    const { results } = res.body.data;
    expect(results.length).toBe(4);

    const byId = {};
    for (const r of results) byId[r.taskId] = r;

    expect(byId[tid1].status).toBe('success');
    expect(byId[tid1].code).toBe('OK');
    expect(byId[tid1].segmentCount).toBeGreaterThan(0);
    expect(byId[tid1].speakerCount).toBeGreaterThan(0);

    expect(byId[tid2].status).toBe('forbidden');
    expect(byId[tid2].code).toBe('FORBIDDEN');

    expect(byId['not-exist-1234'].status).toBe('not_found');
    expect(byId['not-exist-1234'].code).toBe('NOT_FOUND');

    expect(byId[null].code).toBe('INVALID_ID');
  });

  test('空 taskIds 返回 400', async () => {
    const app = createTestApp();
    const res = await request(app).post('/api/tasks/batch').send({ taskIds: [] });
    expect(res.statusCode).toBe(400);
  });
});

describe('接口七：团队学习概览 + 应用隔离', () => {
  test('未提交反馈返回零值概览', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/teams/team-nothing/learning');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.totalFeedback).toBe(0);
  });

  test('提交反馈后可查概览，跨 app 的同名 team 数据不串', async () => {
    const app = createTestApp();
    const tid1 = await submitAndWait(app, { audioUrl: 'https://x.com/lo1.mp3', meetingName: 'L1', teamId: 'team-shared' });
    const s1 = (await request(app).get(`/api/tasks/${tid1}`)).body.data.segments[0];
    await request(app)
      .post(`/api/tasks/${tid1}/feedback`)
      .send({ teamId: 'team-shared', corrections: [
        { type: 'speaker_rename', segmentId: s1.id, newSpeakerLabel: '吴董', scope: 'segment' }
      ]});

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { ensureTestKey } = require('../src/repositories/apiKeyRepository');
      require('../src/db');
      require('../src/db/schema')();
      ensureTestKey();
      const other = generateApiKey('OtherApp');
      const tidOther = 'task-other-0001';
      require('../src/repositories/taskRepository').createTask({
        id: tidOther, appId: other.appId,
        audioUrl: 'https://x.com/other.mp3', meetingName: 'O', teamId: 'team-shared',
        callbackUrl: null, backupCallbackUrl: null, createdAt: Date.now()
      });
      require('../src/repositories/feedbackRepository').createFeedback(tidOther, [{
        segmentId: null,
        feedbackType: 'speaker_rename',
        oldValue: '发言人1',
        newValue: '郑总',
        teamId: 'team-shared',
        createdAt: Date.now()
      }]);
    } finally {
      process.env.NODE_ENV = origEnv;
    }

    const res = await request(app).get('/api/teams/team-shared/learning');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.teamId).toBe('team-shared');
    expect(res.body.data.totalRenameCount).toBe(1);
    const values = res.body.data.speakerMappings.map((m) => m.to);
    expect(values).toContain('吴董');
    expect(values).not.toContain('郑总');
    expect(res.body.data.totalFeedback).toBe(1);
  });
});

describe('审计日志 GET /api/audit/logs', () => {
  test('操作后可查询到审计记录', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/audit.mp3', meetingName: '审计测试', teamId: 'team-aud' });

    const res = await request(app).get('/api/audit/logs');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs.length).toBeGreaterThanOrEqual(1);

    const submitLog = res.body.data.logs.find((l) => l.action === 'task.submit');
    expect(submitLog).toBeTruthy();
    expect(submitLog.keyPrefix).toBeTruthy();
    expect(submitLog.appName).toBeTruthy();
    expect(submitLog.taskId).toBeTruthy();
  });

  test('按 taskId 筛选审计日志', async () => {
    const app = createTestApp();
    const submit = await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/aud2.mp3', meetingName: '审计2' });
    const taskId = submit.body.data.taskId;

    const res = await request(app).get(`/api/audit/logs?taskId=${taskId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs.length).toBeGreaterThanOrEqual(1);
    for (const l of res.body.data.logs) {
      expect(l.taskId).toBe(taskId);
    }
  });

  test('按 action 筛选审计日志', async () => {
    const app = createTestApp();
    await request(app).post('/api/api-keys').send({ appName: '审计Key', permissions: ['tasks:read'] });

    const res = await request(app).get('/api/audit/logs?action=api_key.create');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs.length).toBeGreaterThanOrEqual(1);
    for (const l of res.body.data.logs) {
      expect(l.action).toBe('api_key.create');
    }
  });

  test('审计日志只返回 keyPrefix 和 appName，不泄露完整密钥', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/tasks')
      .send({ audioUrl: 'https://x.com/sec.mp3', meetingName: '安全审计' });

    const res = await request(app).get('/api/audit/logs');
    for (const l of res.body.data.logs) {
      expect(l.keyId).toBeTruthy();
      expect(l.keyPrefix).toBeTruthy();
      expect(l.appName).toBeTruthy();
    }
  });

  test('吊销/轮换密钥也记录审计日志', async () => {
    const app = createTestApp();
    const create = await request(app)
      .post('/api/api-keys')
      .send({ appName: '待审计', permissions: ['tasks:read'] });
    const id = create.body.data.id;

    await request(app).delete(`/api/api-keys/${id}`);

    const res = await request(app).get('/api/audit/logs?action=api_key.revoke');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.logs.length).toBeGreaterThanOrEqual(1);
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

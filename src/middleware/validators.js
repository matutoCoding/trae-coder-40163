const validateSubmitTask = (req, res, next) => {
  const { audioUrl, meetingName } = req.body || {};
  const errors = [];

  if (!audioUrl || typeof audioUrl !== 'string' || audioUrl.trim().length === 0) {
    errors.push({ field: 'audioUrl', message: '音频地址必填' });
  } else if (audioUrl.length > 2048) {
    errors.push({ field: 'audioUrl', message: '音频地址长度不能超过 2048' });
  }

  if (!meetingName || typeof meetingName !== 'string' || meetingName.trim().length === 0) {
    errors.push({ field: 'meetingName', message: '会议名称必填' });
  } else if (meetingName.length > 200) {
    errors.push({ field: 'meetingName', message: '会议名称长度不能超过 200' });
  }

  if (req.body.participants !== undefined) {
    if (!Array.isArray(req.body.participants)) {
      errors.push({ field: 'participants', message: '参会人必须为数组' });
    } else if (req.body.participants.length > 100) {
      errors.push({ field: 'participants', message: '参会人数量不能超过 100' });
    } else {
      req.body.participants.forEach((p, i) => {
        if (p && p.displayName && p.displayName.length > 100) {
          errors.push({ field: `participants[${i}].displayName`, message: '姓名长度不能超过 100' });
        }
      });
    }
  }

  if (req.body.callbackUrl !== undefined && req.body.callbackUrl !== null) {
    if (typeof req.body.callbackUrl !== 'string' || req.body.callbackUrl.length > 2048) {
      errors.push({ field: 'callbackUrl', message: '回调地址不合法' });
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      errors
    });
  }

  next();
};

const validateFeedback = (req, res, next) => {
  const { corrections, teamId } = req.body || {};
  const errors = [];

  if (!Array.isArray(corrections) || corrections.length === 0) {
    errors.push({ field: 'corrections', message: '修正列表不能为空数组' });
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      errors
    });
  }

  if (corrections.length > 500) {
    errors.push({ field: 'corrections', message: '单次提交修正不能超过 500 条' });
  }

  const validTypes = new Set(['speaker_rename', 'segment_merge', 'text_correction', 'segment_split']);

  corrections.forEach((c, i) => {
    const prefix = `corrections[${i}]`;
    if (!c.type) {
      errors.push({ field: `${prefix}.type`, message: '修正类型必填' });
    } else if (!validTypes.has(c.type)) {
      errors.push({ field: `${prefix}.type`, message: `不支持的修正类型: ${c.type}` });
    }
    if (c.type === 'speaker_rename') {
      if (!c.newSpeakerLabel || typeof c.newSpeakerLabel !== 'string' || c.newSpeakerLabel.length > 100) {
        errors.push({ field: `${prefix}.newSpeakerLabel`, message: '新的发言人名称不合法' });
      }
    }
    if (c.type === 'segment_merge') {
      if (!Array.isArray(c.segmentIds) || c.segmentIds.length < 2) {
        errors.push({ field: `${prefix}.segmentIds`, message: '合并至少需要 2 个片段 ID' });
      }
    }
    if (c.type === 'text_correction') {
      if (c.segmentId === undefined || c.segmentId === null) {
        errors.push({ field: `${prefix}.segmentId`, message: '必须指定片段 ID' });
      }
      if (c.newText === undefined || c.newText === null) {
        errors.push({ field: `${prefix}.newText`, message: '必须指定修正后的文本' });
      }
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: '请求参数校验失败',
      errors
    });
  }

  next();
};

const requestLogger = (req, _res, next) => {
  if (process.env.NODE_ENV === 'test') return next();
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);
  next();
};

module.exports = {
  validateSubmitTask,
  validateFeedback,
  requestLogger
};

const MOCK_SPEAKERS = ['发言人1', '发言人2', '发言人3', '发言人4'];
const MOCK_SENTENCES = [
  '大家好，今天我们来讨论一下下个季度的产品路线图。',
  '我先汇报一下上个版本的用户留存数据，整体表现不错。',
  '移动端的日活用户比上个月增长了百分之十五。',
  '关于新功能的优先级，我建议先做语音转写模块。',
  '好的，我同意，这个功能对远程会议场景很有价值。',
  '那我们需要先确定技术方案，是自研还是接入第三方服务。',
  '我倾向于接入第三方，因为自研的声纹识别成本太高了。',
  '嗯，那可以先做 POC 验证，对比几家主流服务商的效果。',
  '还有一个问题，用户的数据隐私和合规性怎么保障？',
  '这个很重要，需要和法务一起确认数据存储和处理的边界。',
  '对了，前端的交互设计稿什么时候能给到开发？',
  '明天下午之前我会把低保真原型发出来，大家先过一遍。',
  '好的，那今天的会就先到这里，后续进展我会在群里同步。',
  '谢谢大家，辛苦各位了，散会。'
];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomFloat = (min, max) => parseFloat((Math.random() * (max - min) + min).toFixed(2));
const pick = (arr) => arr[randomInt(0, arr.length - 1)];

const simulateDiarization = (audioUrl, meetingName, participantCountHint = 0) => {
  const segmentCount = randomInt(8, 18);
  const baseSpeakerCount = participantCountHint > 0
    ? Math.min(participantCountHint, MOCK_SPEAKERS.length)
    : randomInt(2, 4);
  const availableSpeakers = MOCK_SPEAKERS.slice(0, baseSpeakerCount);

  let currentTime = randomFloat(0.0, 2.0);
  const segments = [];
  let lastSpeaker = null;

  for (let i = 0; i < segmentCount; i++) {
    let speaker = pick(availableSpeakers);
    if (lastSpeaker && speaker === lastSpeaker && Math.random() < 0.35) {
      const others = availableSpeakers.filter((s) => s !== lastSpeaker);
      speaker = others.length > 0 ? pick(others) : speaker;
    }
    lastSpeaker = speaker;

    const duration = randomFloat(2.5, 12.0);
    const startTime = currentTime;
    const endTime = parseFloat((startTime + duration).toFixed(2));

    segments.push({
      speakerLabel: speaker,
      startTime,
      endTime,
      textContent: pick(MOCK_SENTENCES),
      confidence: randomFloat(0.72, 0.98)
    });

    currentTime = endTime + randomFloat(0.1, 1.2);
  }

  const meetingHash = hashMeeting(audioUrl || meetingName || '');
  if (meetingHash % 3 === 0) {
    insertMismerge(segments, availableSpeakers);
  }
  if (meetingHash % 4 === 0) {
    insertMislabel(segments, availableSpeakers);
  }

  return segments.sort((a, b) => a.startTime - b.startTime);
};

const insertMismerge = (segments, speakers) => {
  if (segments.length < 4) return;
  const idx = randomInt(1, segments.length - 2);
  const a = segments[idx - 1];
  const b = segments[idx];
  if (a.speakerLabel !== b.speakerLabel) {
    const mergedText = `${a.textContent} ${b.textContent}`;
    segments.splice(idx - 1, 2, {
      speakerLabel: a.speakerLabel,
      startTime: a.startTime,
      endTime: b.endTime,
      textContent: mergedText,
      confidence: Math.min(a.confidence, b.confidence) - 0.05
    });
  }
};

const insertMislabel = (segments, speakers) => {
  if (segments.length < 5 || speakers.length < 2) return;
  const idx = randomInt(2, segments.length - 2);
  const current = segments[idx].speakerLabel;
  const others = speakers.filter((s) => s !== current);
  if (others.length > 0) {
    segments[idx].speakerLabel = pick(others);
  }
};

const hashMeeting = (str) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};

module.exports = {
  simulateDiarization
};

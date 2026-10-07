import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";
import { PlatformError, PressQuoteBoundary } from "../src/platform.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const T0 = Date.parse("2026-09-24T01:00:00.000Z"); // 2026-09-24 09:00 Asia/Shanghai

function makeWorld() {
  let now = T0;
  const platform = new PressQuoteBoundary({ now: () => now });
  platform.registerSession({
    session_id: "S1",
    title: "中美关系新闻茶座",
    timezone: "Asia/Shanghai",
    default_quote_level: "on_record",
  });
  platform.registerParticipant({ participant_id: "org-1", role: "organizer", name: "主办方值班室" });
  platform.registerParticipant({ participant_id: "ed-1", role: "editor", name: "编辑甲" });
  platform.registerParticipant({ participant_id: "ed-2", role: "editor", name: "编辑乙" });
  platform.registerParticipant({ participant_id: "tr-1", role: "translator", name: "译者甲" });
  platform.registerParticipant({ participant_id: "tr-2", role: "translator", name: "译者乙" });
  platform.registerParticipant({ participant_id: "exp-1", role: "expert", name: "张明", title: "研究员" });
  platform.registerParticipant({ participant_id: "j-1", role: "journalist", name: "记者甲", outlet: "通讯社A" });
  platform.registerParticipant({ participant_id: "j-2", role: "journalist", name: "记者乙", outlet: "媒体B" });
  platform.accreditJournalist({
    session_id: "S1",
    journalist_id: "j-1",
    credential_id: "CD-001",
    access_levels: ["on_record", "background"],
  });
  platform.accreditJournalist({
    session_id: "S1",
    journalist_id: "j-2",
    credential_id: "CD-002",
    access_levels: ["background"],
  });
  return { platform, setNow: (ms) => { now = ms; } };
}

function captureOnRecord(platform, overrides = {}) {
  return platform.captureQuote({
    session_id: "S1",
    speaker_id: "exp-1",
    source_language: "zh",
    text: "中方愿同美方一道推动两国关系稳定发展。",
    ...overrides,
  });
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PlatformError, `应为 PlatformError，实际为 ${error}`);
    return error.code;
  }
  return null;
}

// ---- 场次与资质 ----

test("场次时区必须有效且场次不可重复登记", () => {
  const { platform } = makeWorld();
  assert.equal(
    codeOf(() => platform.registerSession({ session_id: "S2", timezone: "Mars/Olympus" })),
    "invalid_timezone",
  );
  assert.equal(
    codeOf(() => platform.registerSession({ session_id: "S1", timezone: "UTC" })),
    "duplicate_session",
  );
});

test("记者资质按场次记录，未获资质记者不得提问", () => {
  const { platform } = makeWorld();
  const ok = platform.ingest({
    external_id: "ext-q-1",
    kind: "question",
    session_id: "S1",
    journalist_id: "j-1",
    language: "zh",
    text: "如何看待下一阶段中美经贸磋商？",
    occurred_at: "2026-09-24T09:05:00",
  });
  assert.equal(ok.status, "accepted");
  assert.equal(
    codeOf(() =>
      platform.ingest({
        external_id: "ext-q-2",
        kind: "question",
        session_id: "S1",
        journalist_id: "j-3",
        language: "zh",
        text: "未登记记者的提问",
        occurred_at: "2026-09-24T09:06:00",
      }),
    ),
    "unknown_participant",
  );
});

// ---- 接入：幂等、冲突隔离、乱序 ----

test("相同外部标识且内容一致时复用原回执", () => {
  const { platform } = makeWorld();
  const entry = {
    external_id: "wire-0001",
    kind: "question",
    session_id: "S1",
    journalist_id: "j-1",
    language: "zh",
    text: "实时流与批量速记重复送达的同一提问",
    occurred_at: "2026-09-24T09:05:00",
  };
  const first = platform.ingest(entry);
  const second = platform.ingest({ ...entry });
  assert.equal(first.status, "accepted");
  assert.equal(second.reused, true);
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(platform.state.questions.size, 1);
});

test("相同外部标识内容冲突时先隔离，原数据不被覆盖", () => {
  const { platform } = makeWorld();
  const base = {
    external_id: "wire-0002",
    kind: "question",
    session_id: "S1",
    journalist_id: "j-1",
    language: "zh",
    text: "原始速记内容",
    occurred_at: "2026-09-24T09:05:00",
  };
  platform.ingest(base);
  const conflict = platform.ingest({ ...base, text: "冲突的另一版内容" });
  assert.equal(conflict.status, "quarantined");
  const quarantine = platform.listQuarantine();
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].status, "isolated");
  assert.equal(quarantine[0].conflicting_entry.text, "冲突的另一版内容");
  assert.equal(platform.state.questions.size, 1);
  assert.equal([...platform.state.questions.values()][0].text, "原始速记内容");
});

test("乱序到达的速记按发生时间还原场次时间线", () => {
  const { platform } = makeWorld();
  platform.ingest({
    external_id: "rt-2",
    kind: "quote",
    session_id: "S1",
    speaker_id: "exp-1",
    source_language: "zh",
    text: "后发生但先到达的回答",
    occurred_at: "2026-09-24T09:20:00",
  });
  platform.ingest({
    external_id: "rt-1",
    kind: "quote",
    session_id: "S1",
    speaker_id: "exp-1",
    source_language: "zh",
    text: "先发生但后到达的回答",
    occurred_at: "2026-09-24T09:10:00",
  });
  const timeline = platform.sessionTimeline({ session_id: "S1" });
  assert.deepEqual(
    timeline.map((item) => item.occurred_at),
    ["2026-09-24T01:10:00.000Z", "2026-09-24T01:20:00.000Z"],
  );
});

// ---- 翻译：提交与审批分离 ----

test("翻译者不能批准自己的译文，审批须由编辑或主办方作出", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const translation = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "China is ready to work with the US.",
    translator_id: "tr-1",
  });
  assert.equal(
    codeOf(() =>
      platform.approveTranslation({
        fragment_id: fragment.fragment_id,
        translation_id: translation.translation_id,
        approver_id: "tr-1",
      }),
    ),
    "self_approval_forbidden",
  );
  assert.equal(
    codeOf(() =>
      platform.approveTranslation({
        fragment_id: fragment.fragment_id,
        translation_id: translation.translation_id,
        approver_id: "tr-2",
      }),
    ),
    "not_authorized",
  );
  const approved = platform.approveTranslation({
    fragment_id: fragment.fragment_id,
    translation_id: translation.translation_id,
    approver_id: "ed-1",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_by, "ed-1");
});

test("同一语言的新译文获批后旧译文转为被取代", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const v1 = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "first version",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: v1.translation_id, approver_id: "ed-1" });
  const v2 = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "revised version",
    translator_id: "tr-2",
  });
  assert.equal(v2.version, 2);
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: v2.translation_id, approver_id: "ed-2" });
  const stored = platform.state.fragments.get(fragment.fragment_id).translations;
  assert.equal(stored.find((item) => item.translation_id === v1.translation_id).status, "superseded");
  assert.equal(stored.find((item) => item.translation_id === v2.translation_id).status, "approved");
});

// ---- 确认与发布门槛 ----

test("等待确认的片段不得发布，确认后方可发布", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform, { quote_level: "pending_confirmation" });
  assert.equal(
    codeOf(() => platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", expected_version: 0 })),
    "not_confirmed",
  );
  platform.confirmFragment({ fragment_id: fragment.fragment_id, confirmer_id: "exp-1", final_level: "on_record" });
  const release = platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", expected_version: 0 });
  assert.equal(release.release_version, 1);
});

test("发布只能固定已审批的译文", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const draft = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "draft translation",
    translator_id: "tr-1",
  });
  assert.equal(
    codeOf(() =>
      platform.releaseQuote({
        fragment_id: fragment.fragment_id,
        editor_id: "ed-1",
        translation_id: draft.translation_id,
        expected_version: 0,
      }),
    ),
    "translation_not_approved",
  );
});

// ---- 禁发时点：场次时区、重启恢复 ----

test("禁发时点按场次指定时区解释，届满后释放", () => {
  const { platform, setNow } = makeWorld();
  const fragment = captureOnRecord(platform, { embargo_until: "2026-09-24T18:00:00" });
  assert.equal(fragment.embargo_until, "2026-09-24T10:00:00.000Z");
  assert.equal(
    codeOf(() => platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", expected_version: 0 })),
    "embargo_active",
  );
  setNow(Date.parse("2026-09-24T09:59:59.000Z"));
  assert.deepEqual(platform.tick().released, []);
  setNow(Date.parse("2026-09-24T10:00:00.000Z"));
  assert.deepEqual(platform.tick().released, [fragment.fragment_id]);
  const release = platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", expected_version: 0 });
  assert.equal(release.release_version, 1);
});

test("服务重启后仍按原时点释放禁发并升级待确认材料", () => {
  const { platform } = makeWorld();
  const pending = captureOnRecord(platform, {
    quote_level: "pending_confirmation",
    pending_upgrade_at: "2026-09-24T12:30:00",
    pending_target_level: "on_record",
  });
  const embargoed = captureOnRecord(platform, { embargo_until: "2026-09-24T18:00:00" });
  assert.equal(platform.nextDueAt(), "2026-09-24T04:30:00.000Z");
  const snapshot = platform.snapshot();

  const restored = PressQuoteBoundary.restore(snapshot, {
    now: () => Date.parse("2026-09-24T11:00:00.000Z"),
  });
  const result = restored.tick();
  assert.deepEqual(result.upgraded, [pending.fragment_id]);
  assert.deepEqual(result.released, [embargoed.fragment_id]);
  assert.equal(restored.nextDueAt(), null);
  const stored = restored.state.fragments.get(pending.fragment_id);
  assert.equal(stored.quote_level, "on_record");
  assert.equal(stored.confirmations.at(-1).via, "scheduled");
  const release = restored.releaseQuote({ fragment_id: pending.fragment_id, editor_id: "ed-1", expected_version: 0 });
  assert.equal(release.release_version, 1);
});

// ---- 发布：固定原文与翻译、并发只保留一个当前版本 ----

test("对外片段固定其采用的原文和翻译，后续译文版本不回溯改写", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const v1 = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "first approved wording",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: v1.translation_id, approver_id: "ed-1" });
  const release = platform.releaseQuote({
    fragment_id: fragment.fragment_id,
    editor_id: "ed-1",
    translation_id: v1.translation_id,
    channels: ["wire_en"],
    expected_version: 0,
  });
  const v2 = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "revised wording afterwards",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: v2.translation_id, approver_id: "ed-2" });
  const stored = platform.state.fragments.get(fragment.fragment_id).releases[0];
  assert.equal(stored.pinned.translation.text, "first approved wording");
  assert.equal(stored.pinned.translation.version, 1);
  assert.equal(release.pinned.source_text, fragment.source_text);
});

test("两个编辑并发发布同一片段只能形成一个当前版本", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const first = platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", expected_version: 0 });
  assert.equal(first.release_version, 1);
  assert.equal(
    codeOf(() => platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-2", expected_version: 0 })),
    "version_conflict",
  );
  const stored = platform.state.fragments.get(fragment.fragment_id);
  assert.equal(stored.releases.length, 1);
  assert.equal(stored.current_release_version, 1);
});

// ---- 更正：不覆盖已发措辞，与旧引用相连，跟踪送达 ----

test("专家更正不覆盖已发措辞，生成与旧引用相连的更正并跟踪送达", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  const release = platform.releaseQuote({
    fragment_id: fragment.fragment_id,
    editor_id: "ed-1",
    channels: ["wire_zh", "wire_en"],
    expected_version: 0,
  });
  const correction = platform.issueCorrection({
    fragment_id: fragment.fragment_id,
    expert_id: "exp-1",
    corrected_text: "中方愿同美方一道推动两国关系健康稳定发展。",
    reason: "专家会后修正措辞",
  });
  const stored = platform.state.fragments.get(fragment.fragment_id).releases[0];
  assert.equal(stored.pinned.source_text, release.pinned.source_text);
  assert.equal(correction.supersedes_release, 1);
  assert.deepEqual(correction.recipient_scope, ["wire_zh", "wire_en"]);
  assert.deepEqual(
    correction.deliveries.map((item) => item.status),
    ["pending", "pending"],
  );
  platform.recordCorrectionDelivery({ correction_id: correction.correction_id, channel: "wire_zh" });
  const trace = platform.traceCitation({ requester_id: "org-1", fragment_id: fragment.fragment_id });
  assert.deepEqual(
    trace.corrections[0].deliveries.map((item) => [item.channel, item.status]),
    [["wire_zh", "delivered"], ["wire_en", "pending"]],
  );
});

test("未发布片段无需更正，可直接修正", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  assert.equal(
    codeOf(() =>
      platform.issueCorrection({ fragment_id: fragment.fragment_id, expert_id: "exp-1", corrected_text: "x" }),
    ),
    "nothing_to_correct",
  );
});

// ---- 会后范围变更 ----

test("会后改变范围只影响尚未发布的内容，并列出已发布渠道的处理责任", () => {
  const { platform } = makeWorld();
  const published = captureOnRecord(platform);
  platform.releaseQuote({
    fragment_id: published.fragment_id,
    editor_id: "ed-1",
    channels: ["wire_zh"],
    expected_version: 0,
  });
  const unpublished = captureOnRecord(platform);
  const result = platform.changeScope({
    session_id: "S1",
    new_level: "off_record",
    changed_by: "org-1",
    reason: "会后主办方调整讨论范围",
  });
  assert.deepEqual(result.unpublished_updated, [unpublished.fragment_id]);
  assert.deepEqual(result.published_untouched, [published.fragment_id]);
  assert.equal(result.obligations.length, 1);
  assert.equal(result.obligations[0].channel, "wire_zh");
  assert.match(result.obligations[0].required_action, /撤回/);

  const storedUnpublished = platform.state.fragments.get(unpublished.fragment_id);
  assert.equal(storedUnpublished.quote_level, "off_record");
  assert.equal(
    codeOf(() => platform.releaseQuote({ fragment_id: unpublished.fragment_id, editor_id: "ed-1", expected_version: 0 })),
    "not_releasable",
  );

  const handled = platform.resolveObligation({
    obligation_id: result.obligations[0].obligation_id,
    handled_by: "ed-1",
    note: "已通知渠道撤稿",
  });
  assert.equal(handled.status, "handled");

  const view = platform.journalistView({ journalist_id: "j-1", fragment_id: published.fragment_id });
  assert.equal(view.scope_notice.new_level, "off_record");
});

// ---- 记者 API：权限边界、可引文字段与署名要求 ----

test("记者只能查看自己有权获得的材料，非公开内容不泄露存在性", () => {
  const { platform } = makeWorld();
  const onRecord = captureOnRecord(platform);
  platform.releaseQuote({ fragment_id: onRecord.fragment_id, editor_id: "ed-1", expected_version: 0 });
  const unreleased = captureOnRecord(platform);

  assert.equal(
    codeOf(() => platform.journalistView({ journalist_id: "j-2", fragment_id: onRecord.fragment_id })),
    "not_available",
  );
  assert.equal(
    codeOf(() => platform.journalistView({ journalist_id: "j-1", fragment_id: unreleased.fragment_id })),
    "not_available",
  );
  assert.equal(
    codeOf(() => platform.journalistView({ journalist_id: "j-1", fragment_id: "F-9999" })),
    "not_available",
  );
  assert.equal(
    codeOf(() => platform.journalistView({ journalist_id: "ed-1", fragment_id: onRecord.fragment_id })),
    "not_authorized",
  );
});

test("记者 API 返回可引文字段与署名要求", () => {
  const { platform } = makeWorld();
  const onRecord = captureOnRecord(platform);
  const translation = platform.submitTranslation({
    fragment_id: onRecord.fragment_id,
    language: "en",
    text: "approved english wording",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: onRecord.fragment_id, translation_id: translation.translation_id, approver_id: "ed-1" });
  platform.attachFact({ fragment_id: onRecord.fragment_id, title: "中美经贸数据附件", content: "……", added_by: "ed-1" });
  platform.releaseQuote({
    fragment_id: onRecord.fragment_id,
    editor_id: "ed-1",
    translation_id: translation.translation_id,
    channels: ["wire_en"],
    expected_version: 0,
  });

  const view = platform.journalistView({ journalist_id: "j-1", fragment_id: onRecord.fragment_id, language: "en" });
  assert.equal(view.quotable, true);
  assert.equal(view.quotable_text, "approved english wording");
  assert.equal(view.text_language, "en");
  assert.equal(view.attribution.mode, "named");
  assert.match(view.attribution.requirement, /张明（研究员）/);
  assert.equal(view.fact_attachments.length, 1);

  const background = captureOnRecord(platform, { quote_level: "background" });
  platform.releaseQuote({ fragment_id: background.fragment_id, editor_id: "ed-1", expected_version: 0 });
  const backgroundView = platform.journalistView({ journalist_id: "j-2", fragment_id: background.fragment_id });
  assert.equal(backgroundView.quotable, false);
  assert.equal(backgroundView.attribution.mode, "anonymous");
  assert.match(backgroundView.attribution.requirement, /不得署名/);
  assert.match(backgroundView.usage, /仅供背景理解/);
});

test("记者看到的片段附带未送达更正提示", () => {
  const { platform } = makeWorld();
  const fragment = captureOnRecord(platform);
  platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", channels: ["wire_zh"], expected_version: 0 });
  platform.issueCorrection({
    fragment_id: fragment.fragment_id,
    expert_id: "exp-1",
    corrected_text: "更正后的措辞",
    reason: "专家会后修正",
  });
  const view = platform.journalistView({ journalist_id: "j-1", fragment_id: fragment.fragment_id });
  assert.equal(view.corrections.length, 1);
  assert.equal(view.corrections[0].corrected_text, "更正后的措辞");
});

test("记者场次订阅源只包含其有权获得的材料", () => {
  const { platform } = makeWorld();
  const onRecord = captureOnRecord(platform);
  platform.releaseQuote({ fragment_id: onRecord.fragment_id, editor_id: "ed-1", expected_version: 0 });
  const background = captureOnRecord(platform, { quote_level: "background" });
  platform.releaseQuote({ fragment_id: background.fragment_id, editor_id: "ed-1", expected_version: 0 });
  captureOnRecord(platform); // 未发布

  const feedFull = platform.journalistFeed({ journalist_id: "j-1", session_id: "S1" });
  assert.equal(feedFull.length, 2);
  const feedBackgroundOnly = platform.journalistFeed({ journalist_id: "j-2", session_id: "S1" });
  assert.deepEqual(
    feedBackgroundOnly.map((item) => item.fragment_id),
    [background.fragment_id],
  );
});

// ---- 主办方追溯 ----

test("主办方可从报道引用追到提问、原话、翻译、确认及更正送达情况", () => {
  const { platform } = makeWorld();
  const question = platform.acceptQuestion({
    session_id: "S1",
    journalist_id: "j-1",
    language: "zh",
    text: "如何评价本轮会谈成果？",
    occurred_at: "2026-09-24T09:05:00",
  });
  const fragment = captureOnRecord(platform, {
    quote_level: "pending_confirmation",
    question_id: question.question_id,
  });
  const translation = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "approved wording",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: translation.translation_id, approver_id: "ed-1" });
  platform.confirmFragment({ fragment_id: fragment.fragment_id, confirmer_id: "exp-1", final_level: "on_record" });
  platform.releaseQuote({
    fragment_id: fragment.fragment_id,
    editor_id: "ed-1",
    translation_id: translation.translation_id,
    channels: ["wire_en"],
    expected_version: 0,
  });
  const correction = platform.issueCorrection({
    fragment_id: fragment.fragment_id,
    expert_id: "exp-1",
    corrected_text: "revised wording",
    reason: "措辞修正",
  });
  platform.recordCorrectionDelivery({ correction_id: correction.correction_id, channel: "wire_en" });

  const trace = platform.traceCitation({ requester_id: "org-1", fragment_id: fragment.fragment_id });
  assert.equal(trace.question.text, "如何评价本轮会谈成果？");
  assert.equal(trace.source.speaker_name, "张明");
  assert.equal(trace.translation.approved_by, "ed-1");
  assert.equal(trace.translation.translator_id, "tr-1");
  assert.equal(trace.confirmations.length, 1);
  assert.equal(trace.corrections[0].deliveries[0].status, "delivered");
  assert.equal(trace.citation.quotable_text, "approved wording");
  assert.ok(trace.events.length >= 4);

  assert.equal(
    codeOf(() => platform.traceCitation({ requester_id: "j-1", fragment_id: fragment.fragment_id })),
    "not_authorized",
  );
});

// ---- 契约事件 ----

test("关键动作发出的领域事件均通过契约校验且版本递增", () => {
  const { platform } = makeWorld();
  const question = platform.acceptQuestion({
    session_id: "S1",
    journalist_id: "j-1",
    language: "zh",
    text: "提问",
    occurred_at: "2026-09-24T09:05:00",
  });
  const fragment = captureOnRecord(platform, { question_id: question.question_id });
  const translation = platform.submitTranslation({
    fragment_id: fragment.fragment_id,
    language: "en",
    text: "wording",
    translator_id: "tr-1",
  });
  platform.approveTranslation({ fragment_id: fragment.fragment_id, translation_id: translation.translation_id, approver_id: "ed-1" });
  platform.releaseQuote({ fragment_id: fragment.fragment_id, editor_id: "ed-1", channels: ["wire_en"], expected_version: 0 });
  const correction = platform.issueCorrection({
    fragment_id: fragment.fragment_id,
    expert_id: "exp-1",
    corrected_text: "revised",
  });

  const audit = platform.auditLog();
  for (const event of audit) {
    assert.deepEqual(validateEvent(event, schema), [], `事件应通过契约校验: ${event.event_type}`);
  }
  const fragmentEvents = audit.filter((event) => event.aggregate_id === fragment.fragment_id);
  assert.deepEqual(
    fragmentEvents.map((event) => event.event_type),
    ["QUOTE_CAPTURED", "TRANSLATION_APPROVED", "QUOTE_RELEASED"],
  );
  assert.deepEqual(
    fragmentEvents.map((event) => event.version),
    [1, 2, 3],
  );
  const correctionEvent = audit.find((event) => event.aggregate_id === correction.correction_id);
  assert.equal(correctionEvent.aggregate_type, "correction_notice");
  assert.equal(correctionEvent.payload.supersedes, 1);
  assert.deepEqual(correctionEvent.payload.recipient_scope, ["wire_en"]);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { QuoteBoundaryService, DomainError } from "../src/service.js";
import { reporterFeed, organizerTrace, quarantineList } from "../src/views.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const T = {
  t0: "2026-10-07T10:00:00Z",
  t1: "2026-10-07T10:05:00Z",
  t2: "2026-10-07T10:10:00Z",
  t3: "2026-10-07T11:00:00Z",
  t4: "2026-10-07T11:30:00Z",
};

function expectError(code, fn) {
  return assert.rejects(fn, (error) => {
    assert.ok(error instanceof DomainError, `期望 DomainError，实际 ${error.constructor.name}: ${error.message}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function bootstrap(filePath = null) {
  const store = new EventStore(filePath);
  const service = new QuoteBoundaryService(store, schema, () => T.t0);
  await service.registerSession({
    session_id: "s1", timezone: "Asia/Shanghai", name: "中美关系新闻茶座", at: T.t0,
  });
  await service.verifyReporter({
    reporter_id: "r1", outlet: "环球电讯", languages: ["zh", "en"], at: T.t0,
  });
  await service.verifyReporter({
    reporter_id: "r2", outlet: "Global Wire", languages: ["en"], at: T.t0,
  });
  const g1 = await service.issueGrant({
    grant_id: "g1", reporter_id: "r1", session_id: "s1",
    scopes: ["pool:on-the-record"], api_token: "token-r1", at: T.t0,
  });
  await service.issueGrant({
    grant_id: "g2", reporter_id: "r2", session_id: "s1",
    scopes: ["pool:off-camera"], api_token: "token-r2", at: T.t0,
  });
  return { store, service, tokenR1: g1.api_token };
}

async function seedQuestion(service) {
  return service.acceptQuestion({
    question_id: "q1", session_id: "s1", reporter_id: "r1",
    text: "请问双方在人文交流上有何新安排？", language: "zh", at: T.t0,
  });
}

// ---------- 资质与授权 ----------

test("未获场次授权的记者提问被拒绝", async () => {
  const { service } = await bootstrap();
  await service.verifyReporter({ reporter_id: "r3", outlet: "X", languages: ["en"], at: T.t0 });
  await expectError("NO_GRANT", () => service.acceptQuestion({
    question_id: "qx", session_id: "s1", reporter_id: "r3",
    text: "?", language: "en", at: T.t0,
  }));
});

test("未知时区的场次不允许登记", async () => {
  const store = new EventStore(null);
  const service = new QuoteBoundaryService(store, schema);
  await expectError("UNKNOWN_TIMEZONE", () => service.registerSession({
    session_id: "sx", timezone: "Mars/Olympus",
  }));
});

// ---------- 幂等、乱序、冲突隔离 ----------

test("同一外部标识内容一致时复用原回执（实时/批量乱序重复）", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  const input = {
    session_id: "s1", question_id: "q1", external_id: "ext-1",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "我们将恢复留学生交流项目。", at: T.t1,
  };
  const first = await service.captureQuote(input);
  assert.equal(first.reused, false);
  // 批量速记晚到，同一标识、同一内容（不同接入渠道）。
  const duplicate = await service.captureQuote({ ...input, source_kind: "batch_steno", at: T.t2 });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.receipt.receipt_id, first.receipt.receipt_id);
  assert.equal(duplicate.receipt.quote_id, first.receipt.quote_id);
  assert.equal(service.snapshot().quotes.size, 1);
});

test("同一外部标识内容冲突时先隔离，不覆盖既有片段", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-2",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "我们将恢复留学生交流项目。", at: T.t1,
  });
  const conflict = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-2",
    source_kind: "batch_steno", speaker_id: "spk-chen", source_language: "zh",
    text: "我们将暂停留学生交流项目。", at: T.t2,
  });
  assert.equal(conflict.quarantined, true);
  assert.equal(conflict.existing_receipt.receipt_id, "rcpt-ext-2");
  const quarantines = quarantineList(service.snapshot());
  assert.equal(quarantines.length, 1);
  assert.equal(quarantines[0].reason, "content_conflict");
  // 隔离内容不产生新片段，原文不变。
  const quote = service.snapshot().quotes.get(conflict.existing_receipt.quote_id);
  assert.equal(quote.text, "我们将恢复留学生交流项目。");
});

// ---------- 翻译审批分离 ----------

test("翻译者不能批准自己的译文，换人审批才成功", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-3",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "双方同意扩大直航航点。", at: T.t1,
  });
  await service.submitTranslation({
    quote_id: cap.receipt.quote_id, translation_id: "tr-1",
    translator_id: "u-translator", language: "en",
    text: "The two sides agreed to expand direct-flight destinations.", at: T.t1,
  });
  await expectError("SELF_APPROVAL_FORBIDDEN", () => service.approveTranslation({
    quote_id: cap.receipt.quote_id, translation_id: "tr-1", approver_id: "u-translator", at: T.t1,
  }));
  await service.approveTranslation({
    quote_id: cap.receipt.quote_id, translation_id: "tr-1", approver_id: "u-editor", at: T.t2,
  });
  const tr = service.snapshot().quotes.get(cap.receipt.quote_id).translations.get("tr-1");
  assert.equal(tr.status, "approved");
  assert.equal(tr.approved_by, "u-editor");
});

// ---------- 发布：固定快照 + 并发单当前版本 ----------

test("并发发布同一片段：一个成功、一个版本冲突，当前版本唯一", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-4",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "年内举行新一轮领事磋商。", at: T.t1,
  });
  const quoteId = cap.receipt.quote_id;
  // 两个编辑同时基于“尚不存在版本”的视图发布。
  const results = await Promise.allSettled([
    service.publishQuote({
      quote_id: quoteId, quote_level: "DIRECT", attribution: "主办方官员（具名）",
      eligible_grant_scopes: ["pool:on-the-record"], published_at: T.t2, at: T.t2,
    }),
    service.publishQuote({
      quote_id: quoteId, quote_level: "DIRECT", attribution: "主办方官员（具名）",
      eligible_grant_scopes: ["pool:on-the-record"], published_at: T.t2, at: T.t2,
    }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.release_version, 1);
  assert.equal(rejected[0].reason.code, "VERSION_CONFLICT");
  assert.equal(service.snapshot().quotes.get(quoteId).publish.release_version, 1);
});

test("禁发期内可基于最新版本改发，旧版本进历史；已释放后只能走更正", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-4b",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "年内举行新一轮领事磋商。", at: T.t1,
  });
  const quoteId = cap.receipt.quote_id;
  await service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT", attribution: "主办方官员（具名）",
    eligible_grant_scopes: ["pool:on-the-record"],
    embargo_until: "2026-10-07 20:00", published_at: T.t2, at: T.t2,
  });
  await expectError("VERSION_CONFLICT", () => service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT", attribution: "主办方官员（具名）",
    eligible_grant_scopes: ["pool:on-the-record"],
    expected_release_version: null, embargo_until: "2026-10-07 20:00",
    published_at: T.t2, at: T.t2,
  }));
  // 基于最新版本重试成功，旧版本进历史，当前版本唯一。
  const republish = await service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT", attribution: "主办方新闻发言人（具名）",
    eligible_grant_scopes: ["pool:on-the-record"],
    expected_release_version: 1, embargo_until: "2026-10-07 20:00",
    published_at: T.t3, at: T.t3,
  });
  assert.equal(republish.release_version, 2);
  const quote = service.snapshot().quotes.get(quoteId);
  assert.equal(quote.publish.release_version, 2);
  assert.equal(quote.publications.length, 1);
  assert.equal(quote.publications[0].current, false);

  // 到期释放之后不得再改发。
  await service.scanDueReleases({ at: "2026-10-07T12:00:00Z" });
  await expectError("QUOTE_ALREADY_RELEASED", () => service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT", attribution: "x",
    eligible_grant_scopes: ["pool:on-the-record"],
    expected_release_version: 2, published_at: T.t4, at: T.t4,
  }));
});

// ---------- 禁发时点：场次时区、重启恢复 ----------

test("禁发按场次时区墙钟时间到期释放，重启后仍然生效", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pqb-"));
  const file = path.join(dir, "events.jsonl");
  try {
    let store = new EventStore(file);
    let service = new QuoteBoundaryService(store, schema);
    await service.registerSession({ session_id: "s9", timezone: "Asia/Shanghai", at: T.t0 });
    await service.verifyReporter({ reporter_id: "rr", outlet: "O", languages: ["zh"], at: T.t0 });
    const g = await service.issueGrant({
      grant_id: "gg", reporter_id: "rr", session_id: "s9",
      scopes: ["pool:on-the-record"], api_token: "tok", at: T.t0,
    });
    await service.acceptQuestion({
      question_id: "qq", session_id: "s9", reporter_id: "rr",
      text: "q", language: "zh", at: T.t0,
    });
    const cap = await service.captureQuote({
      session_id: "s9", question_id: "qq", external_id: "ext-9",
      source_kind: "realtime", speaker_id: "spk", source_language: "zh",
      text: "今晚八点宣布。", at: T.t1,
    });
    // 场次时区 2026-10-07 20:00（UTC+8）= 12:00Z。
    const pub = await service.publishQuote({
      quote_id: cap.receipt.quote_id, quote_level: "DIRECT",
      attribution: "主办方官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
      embargo_until: "2026-10-07 20:00", published_at: T.t2, at: T.t2,
    });
    assert.equal(pub.embargo_until, "2026-10-07T20:00:00+08:00");

    // 到期前记者看不到。
    let feed = reporterFeed(service.snapshot(), g.api_token, { at: "2026-10-07T11:59:00Z" });
    assert.equal(feed.entries.length, 0);

    // 重启：新 store/service 重放同一日志，不依赖任何内存定时器。
    store = new EventStore(file);
    service = new QuoteBoundaryService(store, schema);
    const released = await service.scanDueReleases({ at: "2026-10-07T12:00:00Z" });
    assert.equal(released.length, 1);
    assert.equal(released[0].event_type, "QUOTE_RELEASED");

    feed = reporterFeed(service.snapshot(), g.api_token, { at: "2026-10-07T12:00:00Z" });
    assert.equal(feed.entries.length, 1);
    assert.equal(feed.entries[0].quotable, true);
    assert.equal(feed.entries[0].attribution, "主办方官员（具名）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PENDING_CONFIRMATION 到期不释放而是挂起，专家确认后才可引", async () => {
  const { service, tokenR1 } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-10",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "相关数字还在核对。", at: T.t1,
  });
  const quoteId = cap.receipt.quote_id;
  await service.publishQuote({
    quote_id: quoteId, quote_level: "PENDING_CONFIRMATION",
    attribution: "待确认：暂不对外", eligible_grant_scopes: ["pool:on-the-record"],
    embargo_until: "2026-10-07 20:00", published_at: T.t2, at: T.t2,
  });
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: T.t3 }).entries.length, 0);

  const due = await service.scanDueReleases({ at: "2026-10-07T12:00:00Z" });
  assert.equal(due[0].event_type, "QUOTE_HELD_FOR_CONFIRMATION");
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: "2026-10-07T12:00:00Z" }).entries.length, 0);

  await service.escalatePending({ quote_id: quoteId, escalated_by: "u-desk", at: T.t3 });
  await expectError("NEW_LEVEL_REQUIRED", () => service.resolveConfirmation({
    quote_id: quoteId, resolution: "confirmed", resolved_by: "u-expert", at: T.t4,
  }));
  // t4 = 11:30Z，场次当地 19:30，禁发（20:00）尚未到：专家确认后仍不释放。
  await service.resolveConfirmation({
    quote_id: quoteId, resolution: "confirmed", new_level: "DIRECT",
    resolved_by: "u-expert", at: T.t4,
  });
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: T.t4 }).entries.length, 0);

  // 到达原禁发时点后由扫描释放，级别已由专家结论改为 DIRECT。
  await service.scanDueReleases({ at: "2026-10-07T12:00:00Z" });
  const feed = reporterFeed(service.snapshot(), tokenR1, { at: "2026-10-07T12:00:00Z" });
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].quote_level, "DIRECT");
});

// ---------- 记者视图权限 ----------

test("记者只见授权范围内的 DIRECT/BACKGROUND，BACKGROUND 标记不可引用", async () => {
  const { service, tokenR1 } = await bootstrap();
  await seedQuestion(service);
  const c1 = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-11",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "可以具名的一句。", at: T.t1,
  });
  const c2 = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-12",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "仅供背景的一句。", at: T.t1,
  });
  await service.publishQuote({
    quote_id: c1.receipt.quote_id, quote_level: "DIRECT",
    attribution: "主办方官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    published_at: T.t2, at: T.t2,
  });
  await service.publishQuote({
    quote_id: c2.receipt.quote_id, quote_level: "BACKGROUND",
    attribution: "主办方资深官员（匿名）", eligible_grant_scopes: ["pool:on-the-record"],
    published_at: T.t2, at: T.t2,
  });
  const feed = reporterFeed(service.snapshot(), tokenR1, { at: T.t3 });
  const direct = feed.entries.find((e) => e.quote_level === "DIRECT");
  const background = feed.entries.find((e) => e.quote_level === "BACKGROUND");
  assert.equal(direct.quotable, true);
  assert.equal(background.quotable, false);
  assert.equal(direct.source.text, "可以具名的一句。");
  assert.equal(direct.attribution_required, true);
  assert.equal(direct.approved_translations.length, 0);

  // r2 的授权范围不相交，什么都看不到。
  assert.equal(reporterFeed(service.snapshot(), "token-r2", { at: T.t3 }).entries.length, 0);
  // 无效令牌。
  assert.equal(reporterFeed(service.snapshot(), "nope", { at: T.t3 }).status, "unauthenticated");
});

test("授权撤销后材料立即不可见", async () => {
  const { service, tokenR1 } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-13",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "撤销测试句。", at: T.t1,
  });
  await service.publishQuote({
    quote_id: cap.receipt.quote_id, quote_level: "DIRECT",
    attribution: "官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    published_at: T.t2, at: T.t2,
  });
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: T.t3 }).entries.length, 1);
  await service.revokeGrant({ grant_id: "g1", revoked_at: T.t3, at: T.t3 });
  const feed = reporterFeed(service.snapshot(), tokenR1, { at: T.t4 });
  assert.equal(feed.status, "grant_revoked");
  assert.equal(feed.entries.length, 0);
});

// ---------- 会后范围变更 ----------

test("未发布片段改范围即时生效，无需渠道责任", async () => {
  const { service, tokenR1 } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-14",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "缩窄范围句。", at: T.t1,
  });
  await service.publishQuote({
    quote_id: cap.receipt.quote_id, quote_level: "DIRECT",
    attribution: "官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    embargo_until: "2026-10-07 20:00", published_at: T.t2, at: T.t2,
  });
  await service.changeScope({
    quote_id: cap.receipt.quote_id, new_scopes: ["pool:inner"],
    changed_at: T.t3, published_channels: [], at: T.t3,
  });
  // 禁发到期后，原授权记者因范围不再相交而看不到。
  await service.scanDueReleases({ at: "2026-10-07T12:00:00Z" });
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: "2026-10-07T12:00:00Z" }).entries.length, 0);
});

test("已合法发布的内容改范围不动既发措辞，但必须列出渠道处理责任", async () => {
  const { service, tokenR1 } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-15",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "已经发出的句子。", at: T.t1,
  });
  const quoteId = cap.receipt.quote_id;
  await service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT",
    attribution: "官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    published_at: T.t2, at: T.t2,
  });
  await expectError("CHANNELS_RESPONSIBILITY_REQUIRED", () => service.changeScope({
    quote_id: quoteId, new_scopes: ["pool:inner"], changed_at: T.t3, at: T.t3,
  }));
  await service.changeScope({
    quote_id: quoteId, new_scopes: ["pool:inner"], changed_at: T.t3, at: T.t3,
    published_channels: [
      { channel_id: "wire-flash-0001", handling_owner: "编辑部值班主编", action: "issue_correction" },
    ],
  });
  // 既发版本仍在、原文不变；范围变更不回溯改写。
  const quote = service.snapshot().quotes.get(quoteId);
  assert.equal(quote.publish.source_text, "已经发出的句子。");
  assert.equal(quote.publish.released_at, T.t2);
  assert.deepEqual(quote.scope_change.published_channels.map((c) => c.handling_owner), ["编辑部值班主编"]);
  // 已发布内容在原授权记者侧仍可追溯（既成事实），收窄由更正/撤回流程处理。
  assert.equal(reporterFeed(service.snapshot(), tokenR1, { at: T.t4 }).entries.length, 1);
});

// ---------- 专家更正链 ----------

test("专家修正不覆盖旧措辞，生成与旧引用相连的更正并跟踪送达", async () => {
  const { service } = await bootstrap();
  await seedQuestion(service);
  const cap = await service.captureQuote({
    session_id: "s1", question_id: "q1", external_id: "ext-16",
    source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
    text: "今年双边贸易额达到两万亿美元。", at: T.t1,
  });
  const quoteId = cap.receipt.quote_id;
  await service.submitTranslation({
    quote_id: quoteId, translation_id: "tr-16", translator_id: "u-translator",
    language: "en", text: "Trade reached two trillion dollars this year.", at: T.t1,
  });
  await service.approveTranslation({
    quote_id: quoteId, translation_id: "tr-16", approver_id: "u-editor", at: T.t1,
  });
  await service.attachFact({
    quote_id: quoteId, attachment_id: "fact-1",
    title: "海关总署月度快讯", reference: "http://example.invalid/customs-sep", at: T.t1,
  });
  await service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT",
    attribution: "主办方官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    published_at: T.t2, at: T.t2,
  });

  // 已发布片段不能再改译文，也不能重新发布覆盖。
  await expectError("QUOTE_ALREADY_RELEASED", () => service.approveTranslation({
    quote_id: quoteId, translation_id: "tr-16", approver_id: "u-editor2", at: T.t3,
  }));

  await expectError("NOT_YET_RELEASED", async () => {
    const other = await service.captureQuote({
      session_id: "s1", question_id: "q1", external_id: "ext-17",
      source_kind: "realtime", speaker_id: "spk-chen", source_language: "zh",
      text: "未发布句。", at: T.t1,
    });
    return service.sendCorrection({
      correction_id: "cx", quote_id: other.receipt.quote_id, corrected_text: "x",
      correction_kind: "factual", issued_by: "u-expert",
      recipient_scope: { channels: ["wire"] }, at: T.t3,
    });
  });

  await service.sendCorrection({
    correction_id: "corr-1", quote_id: quoteId,
    corrected_text: "今年双边贸易额接近两万亿美元。",
    corrected_translations: [{ language: "en", text: "Trade approached two trillion dollars this year." }],
    correction_kind: "factual", issued_by: "u-expert",
    recipient_scope: { channels: ["wire-flash", "pool-email"] }, sent_at: T.t3, at: T.t3,
  });

  // 旧版本措辞原样保留。
  const trace = organizerTrace(service.snapshot(), quoteId);
  assert.equal(trace.chain.publications[0].source_text, "今年双边贸易额达到两万亿美元。");
  const corr = trace.chain.corrections[0];
  assert.equal(corr.supersedes_version, 1);
  assert.equal(corr.old_text, "今年双边贸易额达到两万亿美元。");
  assert.equal(corr.corrected_text, "今年双边贸易额接近两万亿美元。");
  assert.deepEqual(corr.deliveries.map((d) => [d.channel, d.status]), [
    ["wire-flash", "sent"],
    ["pool-email", "sent"],
  ]);
  // 追溯链同时包含提问、原话、译文、事实附件。
  assert.equal(trace.chain.question.question_id, "q1");
  assert.equal(trace.chain.capture.original_text, "今年双边贸易额达到两万亿美元。");
  assert.equal(trace.chain.translations[0].approved_by, "u-editor");
  assert.equal(trace.chain.fact_attachments[0].attachment_id, "fact-1");

  // 一条渠道确认送达；重复确认被拒绝。
  await service.ackCorrectionDelivery({
    correction_id: "corr-1", channel: "wire-flash", acked_by: "desk-a", acked_at: T.t4, at: T.t4,
  });
  await expectError("DELIVERY_ALREADY_ACKED", () => service.ackCorrectionDelivery({
    correction_id: "corr-1", channel: "wire-flash", acked_by: "desk-a", at: T.t4,
  }));
  const after = organizerTrace(service.snapshot(), quoteId);
  assert.equal(after.chain.corrections[0].deliveries[0].status, "acked");
  assert.equal(after.chain.corrections[0].deliveries[1].status, "sent");
});

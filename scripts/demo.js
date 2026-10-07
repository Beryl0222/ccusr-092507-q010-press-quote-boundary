/**
 * 端到端演示：
 *   场次登记（指定时区）→ 记者资质/授权 → 提问 → 实时与批量速记
 *   （重复复用回执 / 冲突隔离）→ 翻译与审批分离 → 三种引用级别发布
 *   → 记者 HTTP 视图 → 禁发到期自动释放 → 专家更正链 → 主办方追溯。
 *
 * 运行：npm run demo
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EventStore } from "../src/store.js";
import { QuoteBoundaryService } from "../src/service.js";
import { createAppServer } from "../src/server.js";
import { zonedIso } from "../src/time.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pqb-demo-"));
  const file = path.join(dir, "events.jsonl");

  const store = new EventStore(file);
  const service = new QuoteBoundaryService(store, schema);
  const app = createAppServer(store, schema, {
    organizerToken: "org-demo-token",
    scanIntervalMs: 300,
  });

  // 1. 场次（禁发一律使用此时区）、记者资质、授权
  await service.registerSession({ session_id: "s-1007", timezone: "Asia/Shanghai", name: "中美关系新闻茶座" });
  await service.verifyReporter({ reporter_id: "r-li", outlet: "境内通讯社", languages: ["zh"] });
  await service.verifyReporter({ reporter_id: "r-smith", outlet: "Overseas Wire", languages: ["en"] });
  const li = await service.issueGrant({
    grant_id: "g-li", reporter_id: "r-li", session_id: "s-1007", scopes: ["pool:on-the-record"],
  });
  const smith = await service.issueGrant({
    grant_id: "g-smith", reporter_id: "r-smith", session_id: "s-1007", scopes: ["pool:on-the-record"],
  });

  // 2. 提问
  await service.acceptQuestion({
    question_id: "q-1", session_id: "s-1007", reporter_id: "r-li",
    text: "年内人文交流有哪些恢复安排？", language: "zh",
  });

  // 3. 实时接入先到；批量速记重复到达 -> 复用回执；冲突版本 -> 隔离
  const cap1 = await service.captureQuote({
    session_id: "s-1007", question_id: "q-1", external_id: "steno-0001",
    source_kind: "realtime", speaker_id: "spk-host", source_language: "zh",
    text: "我们将在年内恢复留学生与青年交流项目。",
  });
  const cap1Dup = await service.captureQuote({
    session_id: "s-1007", question_id: "q-1", external_id: "steno-0001",
    source_kind: "batch_steno", speaker_id: "spk-host", source_language: "zh",
    text: "我们将在年内恢复留学生与青年交流项目。",
  });
  const cap1Bad = await service.captureQuote({
    session_id: "s-1007", question_id: "q-1", external_id: "steno-0001",
    source_kind: "batch_steno", speaker_id: "spk-host", source_language: "zh",
    text: "我们将暂停留学生与青年交流项目。",
  });
  console.log("采集回执（重复）:", cap1Dup.reused, "| 冲突隔离:", cap1Bad.quarantined, cap1Bad.quarantine_id);

  const quoteId = cap1.receipt.quote_id;

  // 4. 翻译：自批被拒，编辑批准
  await service.submitTranslation({
    quote_id: quoteId, translation_id: "tr-en-1", translator_id: "u-translator",
    language: "en", text: "We will resume student and youth exchange programs within the year.",
  });
  try {
    await service.approveTranslation({ quote_id: quoteId, translation_id: "tr-en-1", approver_id: "u-translator" });
  } catch (error) {
    console.log("翻译自批被拒:", error.code);
  }
  await service.approveTranslation({ quote_id: quoteId, translation_id: "tr-en-1", approver_id: "u-editor-li" });
  await service.attachFact({
    quote_id: quoteId, attachment_id: "fact-1",
    title: "教育部交流项目清单", reference: "edu/exchanges/2026-10",
  });

  // 5. 发布：DIRECT 带 2 秒后的场次时区禁发；另发 BACKGROUND 与 PENDING 各一句
  const embargo = zonedIso(new Date(Date.now() + 2000), "Asia/Shanghai");
  await service.publishQuote({
    quote_id: quoteId, quote_level: "DIRECT",
    attribution: "主办方新闻官员（具名）", eligible_grant_scopes: ["pool:on-the-record"],
    embargo_until: embargo,
  });
  const cap2 = await service.captureQuote({
    session_id: "s-1007", question_id: "q-1", external_id: "steno-0002",
    source_kind: "realtime", speaker_id: "spk-host", source_language: "zh",
    text: "磋商的具体层级还在沟通，这只是背景。",
  });
  await service.publishQuote({
    quote_id: cap2.receipt.quote_id, quote_level: "BACKGROUND",
    attribution: "主办方资深官员（匿名，不得直接引用）",
    eligible_grant_scopes: ["pool:on-the-record"],
  });
  const cap3 = await service.captureQuote({
    session_id: "s-1007", question_id: "q-1", external_id: "steno-0003",
    source_kind: "realtime", speaker_id: "spk-host", source_language: "zh",
    text: "具体数字稍后公布。",
  });
  await service.publishQuote({
    quote_id: cap3.receipt.quote_id, quote_level: "PENDING_CONFIRMATION",
    attribution: "待确认：禁发", eligible_grant_scopes: ["pool:on-the-record"],
  });

  // 6. HTTP 视图
  await app.start();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const get = async (pathname, token, header = "x-api-token") => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { [header]: token } });
    return { status: res.status, body: await res.json() };
  };

  let feed = (await get("/v1/me/quotes", smith.api_token)).body;
  console.log("禁发期内记者可见条目数:", feed.entries.length, "（BACKGROUND 可见但不可引）");

  console.log("等待禁发到期（场次时区", embargo, "）...");
  await sleep(2400);
  feed = (await get("/v1/me/quotes", smith.api_token)).body;
  const direct = feed.entries.find((e) => e.quotable);
  console.log("到期后可引用条目:", direct?.source.text, "→", direct?.approved_translations[0]?.text);
  console.log("署名要求:", direct?.attribution);

  // 7. 专家更正：不覆盖旧措辞，链向旧引用并按渠道送达
  const correctionId = "corr-0001";
  await service.sendCorrection({
    correction_id: correctionId, quote_id: quoteId,
    corrected_text: "我们将在年内恢复青年交流项目，留学生项目另行安排。",
    corrected_translations: [{ language: "en", text: "We will resume youth exchange programs within the year; student programs will be arranged separately." }],
    correction_kind: "wording", issued_by: "u-expert-wang",
    recipient_scope: { channels: ["wire-flash", "pool-email"] },
  });
  await service.ackCorrectionDelivery({ correction_id: correctionId, channel: "wire-flash", acked_by: "desk-a" });

  const trace = (await get(`/v1/organizer/quotes/${quoteId}/trace`, "org-demo-token", "x-organizer-token")).body;
  console.log("主办方追溯链: 提问 →", trace.chain.question.text);
  console.log("  固定原文:", trace.chain.publications.at(-1).source_text);
  console.log("  更正:", trace.chain.corrections[0].corrected_text);
  console.log("  送达:", trace.chain.corrections[0].deliveries.map((d) => `${d.channel}:${d.status}`).join(", "));

  // 无管理令牌不得访问追溯
  const denied = await get(`/v1/organizer/quarantines`, "wrong", "x-organizer-token");
  console.log("越权访问隔离区状态码:", denied.status);

  app.server.close();
  rmSync(dir, { recursive: true, force: true });
  console.log("演示完成。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

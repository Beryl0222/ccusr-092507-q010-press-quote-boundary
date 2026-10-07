import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { createAppServer } from "../src/server.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

async function setup() {
  const store = new EventStore(null);
  const app = createAppServer(store, schema, {
    organizerToken: "org-secret",
    scanIntervalMs: 3_600_000,
  });
  await app.start();
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  return {
    app,
    service: app.service,
    async get(pathname, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
      return { status: res.status, body: await res.json() };
    },
  };
}

test("记者 API 返回可引文字段与署名要求，越权与未发布不可见", async () => {
  const { app, service, get } = await setup();
  try {
    await service.registerSession({ session_id: "s1", timezone: "Asia/Shanghai" });
    await service.verifyReporter({ reporter_id: "r1", outlet: "O", languages: ["zh", "en"] });
    const grant = await service.issueGrant({
      grant_id: "g1", reporter_id: "r1", session_id: "s1", scopes: ["pool:otr"], api_token: "tok-1",
    });
    await service.acceptQuestion({
      question_id: "q1", session_id: "s1", reporter_id: "r1", text: "q", language: "zh",
    });
    const cap = await service.captureQuote({
      session_id: "s1", question_id: "q1", external_id: "e1",
      source_kind: "realtime", speaker_id: "spk", source_language: "zh",
      text: "可以引用的话。",
    });
    await service.submitTranslation({
      quote_id: cap.receipt.quote_id, translation_id: "t1",
      translator_id: "tr", language: "en", text: "A quotable line.",
    });
    await service.approveTranslation({
      quote_id: cap.receipt.quote_id, translation_id: "t1", approver_id: "ed",
    });
    await service.publishQuote({
      quote_id: cap.receipt.quote_id, quote_level: "DIRECT",
      attribution: "官员（具名）", eligible_grant_scopes: ["pool:otr"],
    });

    const noToken = await get("/v1/me/quotes");
    assert.equal(noToken.status, 401);

    const res = await get("/v1/me/quotes", { "x-api-token": grant.api_token });
    assert.equal(res.status, 200);
    const entry = res.body.entries[0];
    assert.equal(entry.quotable, true);
    assert.equal(entry.attribution_required, true);
    assert.equal(entry.attribution, "官员（具名）");
    assert.equal(entry.source.text, "可以引用的话。");
    assert.equal(entry.approved_translations[0].text, "A quotable line.");

    const single = await get(`/v1/me/quotes/${cap.receipt.quote_id}`, { "x-api-token": grant.api_token });
    assert.equal(single.status, 200);
    assert.equal(single.body.entry.quotable, true);

    const missing = await get("/v1/me/quotes/quote-nope", { "x-api-token": grant.api_token });
    assert.equal(missing.status, 404);

    // 非公开讨论（隔离区）与主办方追溯对记者关闭。
    const traceAsReporter = await get(`/v1/organizer/quotes/${cap.receipt.quote_id}/trace`, {
      "x-organizer-token": "tok-1",
    });
    assert.equal(traceAsReporter.status, 401);

    const trace = await get(`/v1/organizer/quotes/${cap.receipt.quote_id}/trace`, {
      "x-organizer-token": "org-secret",
    });
    assert.equal(trace.status, 200);
    assert.equal(trace.body.chain.question.question_id, "q1");
    assert.equal(trace.body.chain.capture.original_text, "可以引用的话。");
  } finally {
    app.server.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { isValidTimeZone, resolveInstant, zonedLocalToInstant } from "../src/time.js";

test("场次本地墙钟时间按场次时区换算为瞬间", () => {
  assert.equal(
    zonedLocalToInstant("2026-09-24T18:00:00", "Asia/Shanghai"),
    Date.parse("2026-09-24T10:00:00.000Z"),
  );
});

test("夏令时切换前后使用当时偏移", () => {
  assert.equal(
    zonedLocalToInstant("2026-01-15T12:00:00", "America/New_York"),
    Date.parse("2026-01-15T17:00:00.000Z"),
  );
  assert.equal(
    zonedLocalToInstant("2026-07-15T12:00:00", "America/New_York"),
    Date.parse("2026-07-15T16:00:00.000Z"),
  );
});

test("带显式偏移的时间直接解析，不再按场次时区解释", () => {
  assert.equal(
    resolveInstant("2026-09-24T18:00:00+08:00", "America/New_York"),
    Date.parse("2026-09-24T10:00:00.000Z"),
  );
  assert.equal(
    resolveInstant("2026-09-24T10:00:00Z", "Asia/Shanghai"),
    Date.parse("2026-09-24T10:00:00.000Z"),
  );
});

test("固定偏移时区与非法输入", () => {
  assert.equal(
    resolveInstant("2026-01-01T00:00:00", "+05:30"),
    Date.parse("2025-12-31T18:30:00.000Z"),
  );
  assert.ok(Number.isNaN(resolveInstant("不是时间", "Asia/Shanghai")));
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("+08:00"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});

/**
 * 场次禁发时点工具。
 *
 * 规则：禁发期一律使用场次登记的 IANA 时区表达。
 * - 组织方提交的禁发时点可以是场次时区的墙钟时间（无时区后缀），
 *   按场次时区解析为绝对时刻；
 * - 落库与比较一律用带偏移的 ISO-8601 字符串（绝对时刻），
 *   因此服务重启、夏令时切换都不影响到期判定。
 */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_RE = /Z$|[+-]\d{2}:\d{2}$/;

function zonedParts(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const entries = dtf
    .formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]);
  const parts = Object.fromEntries(entries);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "00" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function utcMillis(wall) {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
}

/** 墙钟分量 -> 该时区下的绝对毫秒（两遍法消除夏令时缝隙）。 */
function wallToInstant(wall, timeZone) {
  let guess = utcMillis(wall);
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const drift = utcMillis(actual) - utcMillis(wall);
    if (drift === 0) break;
    guess -= drift;
  }
  return guess;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** 绝对时刻在指定时区的带偏移 ISO-8601 字符串。 */
export function zonedIso(instant, timeZone) {
  const wall = zonedParts(instant, timeZone);
  // 偏移 = 当地墙钟（按 UTC 读数）- UTC 时刻（如 UTC+8 为 +480 分钟）。
  const offsetMinutes = Math.round((utcMillis(wall) - instant.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 把组织方输入解析为带偏移的 ISO-8601 字符串。
 * - 已带时区后缀：按绝对时刻保留，并以场次时区重新呈现偏移；
 * - 裸墙钟：按场次时区解释。
 */
export function resolveZoned(input, timeZone) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("禁发时点必须是非空字符串");
  }
  const value = input.trim();
  const wall = WALL_RE.exec(value);
  if (wall) {
    const [, y, mo, d, h, mi, s] = wall;
    return zonedIso(
      new Date(wallToInstant(
        { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) },
        timeZone,
      )),
      timeZone,
    );
  }
  if (ZONED_RE.test(value) && !Number.isNaN(Date.parse(value))) {
    return zonedIso(new Date(value), timeZone);
  }
  throw new Error(`无法解析禁发时点: ${value}（场次时区 ${timeZone}）`);
}

/** 禁发是否已在参考时刻（默认当前）到期。 */
export function embargoElapsed(embargoUntil, reference = new Date()) {
  return Date.parse(embargoUntil) <= reference.getTime();
}

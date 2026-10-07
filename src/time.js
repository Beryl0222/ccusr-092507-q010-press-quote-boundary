const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/;

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  if (timeZone === "UTC" || FIXED_OFFSET.test(timeZone)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutesAt(timeZone, date) {
  if (timeZone === "UTC") return 0;
  const fixed = FIXED_OFFSET.exec(timeZone);
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3]);
    return fixed[1] === "-" ? -minutes : minutes;
  }
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
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

export function zonedLocalToInstant(localIso, timeZone) {
  const guess = Date.parse(`${localIso}Z`);
  if (Number.isNaN(guess)) return Number.NaN;
  const first = offsetMinutesAt(timeZone, new Date(guess));
  let instant = guess - first * 60000;
  const second = offsetMinutesAt(timeZone, new Date(instant));
  if (second !== first) instant = guess - second * 60000;
  return instant;
}

export function resolveInstant(value, timeZone) {
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  if (/Z$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) return Date.parse(value);
  return zonedLocalToInstant(value, timeZone);
}

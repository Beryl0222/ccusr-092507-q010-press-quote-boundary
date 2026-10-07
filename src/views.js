import { embargoElapsed } from "./time.js";

/**
 * 读模型：所有对外输出都经过这里的权限裁剪，
 * 非公开讨论（待确认、已驳回、被隔离内容）不会出现在记者视图里。
 */

export function authenticate(state, apiToken) {
  const grant = [...state.grants.values()].find((g) => g.api_token === apiToken);
  if (!grant) return null;
  if (grant.status !== "active") {
    return { grant, reporter: state.reporters.get(grant.reporter_id), active: false };
  }
  return { grant, reporter: state.reporters.get(grant.reporter_id), active: true };
}

function scopeIntersects(granted, required) {
  return required.some((scope) => granted.includes(scope));
}

/**
 * 把已发布版本投影成记者可见的条目。
 * 只有已合法释放（过禁发时点，或无禁发）且授权范围相交的版本可见。
 */
function visibleEntry(quote, publish, grant, at) {
  if (!publish.released_at) return null;
  if (!scopeIntersects(grant.scopes, publish.eligible_grant_scopes)) return null;
  if (Date.parse(publish.released_at) > Date.parse(at)) return null;
  if (publish.embargo_until && !embargoElapsed(publish.embargo_until, new Date(at))) return null;

  const level = publish.quote_level;
  const base = {
    quote_id: quote.id,
    question_id: quote.question_id,
    release_version: publish.release_version,
    speaker_id: publish.speaker_id,
    quote_level: level,
    attribution_required: true,
    attribution: publish.attribution,
    released_at: publish.released_at,
  };

  if (level === "DIRECT") {
    return {
      ...base,
      quotable: true,
      usage: "可直接引用，必须逐字使用固定原文或已批准译文，并按署名要求署名",
      source: {
        language: publish.source_language,
        text: publish.source_text,
        text_ref: publish.source_text_ref,
      },
      approved_translations: publish.approved_translations.map((t) => ({
        language: t.language,
        text: t.text,
        // 记者侧不暴露译者身份给对外署名，固定译文只给语言与文本。
      })),
    };
  }
  if (level === "BACKGROUND") {
    return {
      ...base,
      quotable: false,
      usage: "仅供背景理解，不得直接引用、不得逐字转述，署名要求仍然适用",
      source: {
        language: publish.source_language,
        text: publish.source_text,
      },
      approved_translations: publish.approved_translations.map((t) => ({
        language: t.language,
        text: t.text,
      })),
    };
  }
  // PENDING_CONFIRMATION 永不进入记者视图。
  return null;
}

export function reporterFeed(state, apiToken, { at = new Date().toISOString() } = {}) {
  const auth = authenticate(state, apiToken);
  if (!auth) return { status: "unauthenticated", entries: [] };
  if (!auth.active) return { status: "grant_revoked", entries: [] };

  const { grant } = auth;
  const entries = [];
  for (const quote of state.quotes.values()) {
    if (quote.session_id !== grant.session_id) continue;
    const entry = visibleEntry(quote, quote.publish, grant, at);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => Date.parse(a.released_at) - Date.parse(b.released_at) || a.quote_id.localeCompare(b.quote_id));
  return {
    status: "ok",
    reporter_id: grant.reporter_id,
    session_id: grant.session_id,
    scopes: grant.scopes,
    entries,
  };
}

export function reporterQuote(state, apiToken, quoteId, options = {}) {
  const auth = authenticate(state, apiToken);
  if (!auth) return { status: "unauthenticated", entry: null };
  if (!auth.active) return { status: "grant_revoked", entry: null };
  const quote = state.quotes.get(quoteId);
  if (!quote || quote.session_id !== auth.grant.session_id) {
    return { status: "not_found", entry: null };
  }
  const entry = visibleEntry(quote, quote.publish, auth.grant, options.at ?? new Date().toISOString());
  return entry ? { status: "ok", entry } : { status: "not_found", entry: null };
}

/**
 * 主办方追溯链：从一条报道引用反向追到提问、原话、译文、
 * 确认结论以及各渠道更正送达情况。记者侧不可访问。
 */
export function organizerTrace(state, quoteId) {
  const quote = state.quotes.get(quoteId);
  if (!quote) return null;
  const question = state.questions.get(quote.question_id) ?? null;
  const reporter = question ? state.reporters.get(question.reporter_id) ?? null : null;
  const receipt = [...state.receiptsByExternal.values()].find((r) => r.quote_id === quoteId) ?? null;

  const publications = [];
  for (const record of [...quote.publications, quote.publish].filter(Boolean)) {
    publications.push({
      release_version: record.release_version,
      quote_level: record.quote_level,
      source_text_ref: record.source_text_ref,
      source_text: record.source_text,
      source_language: record.source_language,
      approved_translations: record.approved_translations,
      attribution: record.attribution,
      eligible_grant_scopes: record.eligible_grant_scopes,
      embargo_until: record.embargo_until,
      session_timezone: record.session_timezone,
      published_at: record.published_at,
      released_at: record.released_at,
      is_current: record === quote.publish,
    });
  }

  return {
    quote_id: quote.id,
    session_id: quote.session_id,
    session: state.sessions.get(quote.session_id) ?? null,
    chain: {
      question: question && {
        question_id: question.id,
        reporter_id: question.reporter_id,
        reporter_outlet: reporter?.outlet ?? null,
        text: question.text,
        language: question.language,
      },
      capture: {
        external_id: quote.external_id,
        source_kind: quote.source_kind,
        speaker_id: quote.speaker_id,
        source_language: quote.source_language,
        original_text: quote.text,
        captured_at: quote.captured_at,
        receipt: receipt && {
          receipt_id: receipt.receipt_id,
          content_hash: receipt.content_hash,
        },
      },
      translations: [...quote.translations.values()].map((t) => ({
        translation_id: t.id,
        language: t.language,
        text: t.text,
        translator_id: t.translator_id,
        status: t.status,
        approved_by: t.approved_by,
        approved_at: t.approved_at,
      })),
      fact_attachments: quote.facts,
      publications,
      current_status: quote.status,
      held: quote.status === "held" || quote.status === "awaiting_confirmation" ? {
        held_at: quote.held_at ?? null,
        escalated_at: quote.escalated_at ?? null,
        escalated_by: quote.escalated_by ?? null,
      } : null,
      confirmation: quote.confirmation ?? null,
      scope_change: quote.scope_change ?? null,
      corrections: quote.correction_ids.map((id) => {
        const c = state.corrections.get(id);
        return {
          correction_id: c.id,
          supersedes_version: c.supersedes_version,
          old_text: c.old_text,
          corrected_text: c.corrected_text,
          corrected_translations: c.corrected_translations,
          correction_kind: c.correction_kind,
          issued_by: c.issued_by,
          recipient_scope: c.recipient_scope,
          sent_at: c.sent_at,
          deliveries: c.deliveries,
        };
      }),
    },
  };
}

/** 隔离区清单（主办方用）。 */
export function quarantineList(state) {
  return state.quarantines.map((q) => ({ ...q }));
}

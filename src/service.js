import { createHash, randomUUID } from "node:crypto";

import { validateEvent } from "./contracts.js";
import { replay } from "./model.js";
import { resolveZoned, zonedIso, embargoElapsed } from "./time.js";

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    Object.assign(this, details);
  }
}

function canonicalHash({ text, speaker_id, source_language, question_id, session_id }) {
  const canonical = JSON.stringify({
    text: String(text).normalize("NFKC"),
    speaker_id,
    source_language,
    question_id,
    session_id,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 引语边界台命令服务。
 *
 * 所有命令在进程内串行提交：两个编辑并发发布同一片段时，
 * 后到者基于过期的 release_version 会被拒绝，因此始终只有一个当前版本。
 */
export class QuoteBoundaryService {
  constructor(store, schema, clock = nowIso) {
    this.store = store;
    this.schema = schema;
    this.clock = clock;
    this.chain = Promise.resolve();
  }

  #exclusive(work) {
    const run = this.chain.then(() => work());
    this.chain = run.catch(() => {});
    return run;
  }

  #state() {
    return replay(this.store.all());
  }

  /** 当前世界状态快照（供只读视图使用）。 */
  snapshot() {
    return this.#state();
  }

  #emit(state, type, aggregateType, aggregateId, payload, at = this.clock()) {
    const event = {
      event_id: `evt-${randomUUID()}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: at,
      version: this.store.nextVersion(aggregateType, aggregateId),
      payload,
    };
    const issues = validateEvent(event, this.schema);
    if (issues.length > 0) {
      throw new DomainError("CONTRACT_VIOLATION", "事件未通过契约校验", { issues });
    }
    this.store.append(event);
    return event;
  }

  // ---------- 场次与人员 ----------

  registerSession({ session_id, timezone, name = null, at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      if (state.sessions.has(session_id)) throw new DomainError("SESSION_EXISTS", "场次已登记");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        throw new DomainError("UNKNOWN_TIMEZONE", `未知时区: ${timezone}`);
      }
      return this.#emit(state, "SESSION_REGISTERED", "press_session", session_id, {
        session_id, timezone, name,
      }, at);
    });
  }

  verifyReporter({ reporter_id, outlet, languages, verified_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      if (state.reporters.has(reporter_id)) throw new DomainError("REPORTER_EXISTS", "记者已登记资质");
      if (!Array.isArray(languages) || languages.length === 0) {
        throw new DomainError("LANGUAGES_REQUIRED", "记者资质至少登记一种语言");
      }
      return this.#emit(state, "REPORTER_VERIFIED", "reporter", reporter_id, {
        reporter_id, outlet, languages: [...languages], verified_at,
      }, at);
    });
  }

  issueGrant({ grant_id, reporter_id, session_id, scopes, api_token, issued_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      if (state.grants.has(grant_id)) throw new DomainError("GRANT_EXISTS", "授权已存在");
      if (!state.reporters.has(reporter_id)) throw new DomainError("REPORTER_NOT_VERIFIED", "记者资质未登记");
      if (!state.sessions.has(session_id)) throw new DomainError("SESSION_NOT_FOUND", "场次不存在");
      if (!Array.isArray(scopes) || scopes.length === 0) throw new DomainError("SCOPES_REQUIRED", "授权范围不能为空");
      const token = api_token ?? `tok-${randomUUID()}`;
      if ([...state.grants.values()].some((g) => g.api_token === token)) {
        throw new DomainError("TOKEN_COLLISION", "授权令牌冲突，请重试");
      }
      const event = this.#emit(state, "GRANT_ISSUED", "grant", grant_id, {
        grant_id, reporter_id, session_id, scopes: [...scopes], api_token: token, issued_at,
      }, at);
      return { event, api_token: token };
    });
  }

  revokeGrant({ grant_id, revoked_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const grant = state.grants.get(grant_id);
      if (!grant) throw new DomainError("GRANT_NOT_FOUND", "授权不存在");
      if (grant.status !== "active") throw new DomainError("GRANT_NOT_ACTIVE", "授权已失效");
      return this.#emit(state, "GRANT_REVOKED", "grant", grant_id, { grant_id, revoked_at }, at);
    });
  }

  // ---------- 提问 ----------

  acceptQuestion({ question_id, session_id, reporter_id, text, language, at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      if (state.questions.has(question_id)) throw new DomainError("QUESTION_EXISTS", "提问已受理");
      if (!state.sessions.has(session_id)) throw new DomainError("SESSION_NOT_FOUND", "场次不存在");
      const reporter = state.reporters.get(reporter_id);
      if (!reporter) throw new DomainError("REPORTER_NOT_VERIFIED", "记者资质未登记");
      const hasGrant = [...state.grants.values()].some(
        (g) => g.reporter_id === reporter_id && g.session_id === session_id && g.status === "active",
      );
      if (!hasGrant) throw new DomainError("NO_GRANT", "该记者没有本场次的有效授权，提问不予受理");
      return this.#emit(state, "QUESTION_ACCEPTED", "question_turn", question_id, {
        session_id, reporter_id, text, language,
      }, at);
    });
  }

  // ---------- 采集：幂等回执 / 冲突隔离 / 乱序去重 ----------

  captureQuote(input) {
    return this.#exclusive(() => {
      const state = this.#state();
      const {
        session_id, question_id, external_id,
        source_kind, speaker_id, source_language, text,
        at = this.clock(),
      } = input;
      const session = state.sessions.get(session_id);
      if (!session) throw new DomainError("SESSION_NOT_FOUND", "场次不存在");
      const question = state.questions.get(question_id);
      if (!question || question.session_id !== session_id) {
        throw new DomainError("QUESTION_NOT_FOUND", "提问不存在或不属于该场次");
      }
      if (!["realtime", "batch_steno"].includes(source_kind)) {
        throw new DomainError("UNSUPPORTED_SOURCE_KIND", "source_kind 只能是 realtime 或 batch_steno");
      }
      if (typeof text !== "string" || text.trim() === "") {
        throw new DomainError("TEXT_REQUIRED", "回答片段文本不能为空");
      }
      const content_hash = canonicalHash({ text, speaker_id, source_language, question_id, session_id });
      const prior = state.receiptsByExternal.get(external_id);
      if (prior) {
        if (prior.content_hash === content_hash) {
          // 实时接入与批量速记重复或乱序到达：外部标识相同且内容一致，复用原回执。
          return { reused: true, receipt: prior, event: null };
        }
        // 内容冲突：先隔离，不覆盖既有片段。
        const quarantineId = `quarantine-${randomUUID()}`;
        const event = this.#emit(state, "QUOTE_QUARANTINED", "quote_fragment", quarantineId, {
          external_id,
          reason: "content_conflict",
          content_hash,
          expected_hash: prior.content_hash,
          text,
          source_kind,
        }, at);
        return {
          reused: false,
          quarantined: true,
          receipt: null,
          quarantine_id: quarantineId,
          existing_receipt: prior,
          event,
        };
      }
      const quoteId = input.quote_id ?? `quote-${randomUUID()}`;
      const receipt_id = `rcpt-${external_id}`;
      const event = this.#emit(state, "QUOTE_CAPTURED", "quote_fragment", quoteId, {
        session_id,
        question_id,
        external_id,
        receipt_id,
        content_hash,
        source_kind,
        speaker_id,
        source_language,
        text,
      }, at);
      return {
        reused: false,
        quarantined: false,
        receipt: { receipt_id, quote_id: quoteId, external_id, content_hash },
        event,
      };
    });
  }

  // ---------- 翻译与审批分离 ----------

  submitTranslation({ quote_id, translation_id, translator_id, language, text, submitted_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (quote.publish?.released_at) throw new DomainError("QUOTE_ALREADY_RELEASED", "片段已合法发布，措辞已固定，只能走更正链");
      if (quote.translations.has(translation_id)) throw new DomainError("TRANSLATION_EXISTS", "译稿标识已存在");
      if (typeof text !== "string" || text.trim() === "") throw new DomainError("TEXT_REQUIRED", "译文文本不能为空");
      return this.#emit(state, "TRANSLATION_SUBMITTED", "quote_fragment", quote_id, {
        translation_id, translator_id, language, text, submitted_at,
      }, at);
    });
  }

  approveTranslation({ quote_id, translation_id, approver_id, at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      const translation = quote.translations.get(translation_id);
      if (!translation) throw new DomainError("TRANSLATION_NOT_FOUND", "译稿不存在");
      if (quote.publish?.released_at) throw new DomainError("QUOTE_ALREADY_RELEASED", "片段已合法发布，译文已固定");
      if (translation.status === "approved") throw new DomainError("TRANSLATION_ALREADY_APPROVED", "译稿已经批准");
      // 翻译者不能批准自己的译文。
      if (translation.translator_id === approver_id) {
        throw new DomainError("SELF_APPROVAL_FORBIDDEN", "翻译者不能批准自己的译文", {
          translator_id: translation.translator_id,
          approver_id,
        });
      }
      return this.#emit(state, "TRANSLATION_APPROVED", "quote_fragment", quote_id, {
        translation_id, approver_id,
      }, at);
    });
  }

  attachFact({ quote_id, attachment_id, title, reference, attached_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (quote.facts.some((f) => f.attachment_id === attachment_id)) {
        throw new DomainError("FACT_EXISTS", "事实附件已存在");
      }
      return this.#emit(state, "FACT_ATTACHED", "quote_fragment", quote_id, {
        attachment_id, title, reference, attached_at,
      }, at);
    });
  }

  // ---------- 发布：固定原文与译文、禁发时点、乐观并发 ----------

  publishQuote(input) {
    return this.#exclusive(() => {
      const state = this.#state();
      const {
        quote_id, quote_level, attribution, eligible_grant_scopes,
        expected_release_version = null,
        embargo_until = null,
        published_at = this.clock(),
        at = this.clock(),
      } = input;
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!["DIRECT", "BACKGROUND", "PENDING_CONFIRMATION"].includes(quote_level)) {
        throw new DomainError("UNSUPPORTED_QUOTE_LEVEL", "引用级别未登记");
      }
      if (typeof attribution !== "string" || attribution.trim() === "") {
        throw new DomainError("ATTRIBUTION_REQUIRED", "对外片段必须写明署名要求");
      }
      if (!Array.isArray(eligible_grant_scopes) || eligible_grant_scopes.length === 0) {
        throw new DomainError("SCOPES_REQUIRED", "必须指定可见授权范围");
      }
      const current = quote.publish;
      const expected = current?.release_version ?? null;
      if (expected_release_version !== expected) {
        throw new DomainError("VERSION_CONFLICT", "发布基于的版本已过期，并发发布只有一个当前版本", {
          expected_release_version,
          current_release_version: expected,
        });
      }
      if (current?.released_at) {
        throw new DomainError("QUOTE_ALREADY_RELEASED", "片段已合法发布，不得覆盖既有措辞，请发起更正");
      }
      const session = state.sessions.get(quote.session_id);
      const resolvedEmbargo = embargo_until === null
        ? null
        : resolveZoned(embargo_until, session.timezone);
      if (resolvedEmbargo !== null && Date.parse(resolvedEmbargo) <= Date.parse(published_at)) {
        throw new DomainError("EMBARGO_IN_PAST", "禁发时点必须晚于发布时间");
      }
      const approvedTranslations = [...quote.translations.values()]
        .filter((t) => t.status === "approved")
        .map((t) => ({
          translation_id: t.id,
          language: t.language,
          text: t.text,
          translator_id: t.translator_id,
          approved_by: t.approved_by,
        }));
      const release_version = (current?.release_version ?? 0) + 1;
      const event = this.#emit(state, "QUOTE_PUBLISHED", "quote_fragment", quote_id, {
        session_id: quote.session_id,
        quote_level,
        release_version,
        source_text_ref: quote_id,
        source_text: quote.text,
        source_language: quote.source_language,
        speaker_id: quote.speaker_id,
        approved_translation_ids: approvedTranslations.map((t) => t.translation_id),
        approved_translations: approvedTranslations,
        embargo_until: resolvedEmbargo,
        session_timezone: session.timezone,
        attribution,
        eligible_grant_scopes: [...eligible_grant_scopes],
        published_at,
        // 无禁发的可对外级别即时合法发布；PENDING_CONFIRMATION 即使无禁发也不释放，须等专家确认。
        ...(resolvedEmbargo === null && quote_level !== "PENDING_CONFIRMATION"
          ? { released_at: published_at }
          : {}),
      }, at);
      return { event, release_version, embargo_until: resolvedEmbargo };
    });
  }

  /** 手动把片段挂起等待确认（禁发到期前也可操作）。 */
  holdForConfirmation({ quote_id, held_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!quote.publish) throw new DomainError("NOT_PUBLISHED", "片段尚未发布，无需挂起");
      if (quote.status === "held" || quote.status === "awaiting_confirmation") {
        throw new DomainError("ALREADY_HELD", "片段已处于待确认状态");
      }
      if (quote.publish.released_at) throw new DomainError("QUOTE_ALREADY_RELEASED", "片段已合法发布");
      return this.#emit(state, "QUOTE_HELD_FOR_CONFIRMATION", "quote_fragment", quote_id, { held_at }, at);
    });
  }

  /** 待确认材料升级给专家确认。 */
  escalatePending({ quote_id, escalated_by, escalated_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!["held", "published"].includes(quote.status)) {
        throw new DomainError("NOT_PENDING", "只有待确认或到期挂起的片段可以升级");
      }
      if (quote.publish?.released_at) throw new DomainError("QUOTE_ALREADY_RELEASED", "片段已合法发布");
      return this.#emit(state, "PENDING_ESCALATED", "quote_fragment", quote_id, {
        escalated_at, escalated_by,
      }, at);
    });
  }

  /**
   * 扫描到期的禁发片段（重启后调用同样有效：判定只依据落库的绝对时刻）。
   * - DIRECT/BACKGROUND：到期释放，产生 QUOTE_RELEASED；
   * - PENDING_CONFIRMATION：到期不能释放，自动升级为待确认挂起。
   */
  scanDueReleases({ at = this.clock() } = {}) {
    return this.#exclusive(() => {
      const state = this.#state();
      const emitted = [];
      for (const quote of state.quotes.values()) {
        const current = quote.publish;
        if (!current || current.released_at || !current.embargo_until) continue;
        if (!embargoElapsed(current.embargo_until, new Date(at))) continue;
        // 只有停留在 published 的片段由扫描处置；held/awaiting 等专家结论，rejected 永不释放。
        if (quote.status !== "published") continue;
        const session = state.sessions.get(quote.session_id);
        if (current.quote_level === "PENDING_CONFIRMATION") {
          emitted.push(this.#emit(state, "QUOTE_HELD_FOR_CONFIRMATION", "quote_fragment", quote.id, {
            held_at: zonedIso(new Date(at), session.timezone),
          }, at));
        } else {
          emitted.push(this.#emit(state, "QUOTE_RELEASED", "quote_fragment", quote.id, {
            quote_level: current.quote_level,
            release_version: current.release_version,
          }, at));
        }
      }
      return emitted;
    });
  }

  /**
   * 专家对待确认材料给出结论。
   * - confirmed：必须指定新的可对外级别（DIRECT/BACKGROUND），即时释放；
   * - rejected：材料维持不公开，记者视图不可见。
   */
  resolveConfirmation({ quote_id, resolution, new_level = null, resolved_by, resolved_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!["held", "awaiting_confirmation"].includes(quote.status)) {
        throw new DomainError("NOT_PENDING", "片段不处于待确认状态");
      }
      if (!["confirmed", "rejected"].includes(resolution)) {
        throw new DomainError("UNSUPPORTED_RESOLUTION", "结论只能是 confirmed 或 rejected");
      }
      if (resolution === "confirmed") {
        if (!["DIRECT", "BACKGROUND"].includes(new_level)) {
          throw new DomainError("NEW_LEVEL_REQUIRED", "确认放行必须指定 DIRECT 或 BACKGROUND 级别");
        }
      }
      const event = this.#emit(state, "CONFIRMATION_RESOLVED", "quote_fragment", quote_id, {
        resolved_at,
        resolved_by,
        resolution,
        new_level,
      }, at);
      const emitted = [event];
      if (resolution === "confirmed" && quote.publish?.embargo_until
        && embargoElapsed(quote.publish.embargo_until, new Date(at)) === false) {
        // 禁发尚未到期：保持已发布状态，由扫描在原时点释放。
      } else if (resolution === "confirmed") {
        emitted.push(this.#emit(state, "QUOTE_RELEASED", "quote_fragment", quote_id, {
          quote_level: new_level,
          release_version: quote.publish.release_version,
        }, at));
      }
      return emitted;
    });
  }

  // ---------- 会后范围变更 ----------

  changeScope(input) {
    return this.#exclusive(() => {
      const state = this.#state();
      const { quote_id, new_scopes, changed_at = this.clock(), published_channels = [], at = this.clock() } = input;
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!quote.publish) throw new DomainError("NOT_PUBLISHED", "片段尚未发布");
      if (!Array.isArray(new_scopes) || new_scopes.length === 0) {
        throw new DomainError("SCOPES_REQUIRED", "新范围不能为空");
      }
      const alreadyReleased = Boolean(quote.publish.released_at);
      if (alreadyReleased && published_channels.length === 0) {
        throw new DomainError("CHANNELS_RESPONSIBILITY_REQUIRED", "片段已合法发布，必须列出各已发布渠道及处理责任");
      }
      for (const channel of published_channels) {
        if (!channel || typeof channel.channel_id !== "string" || typeof channel.handling_owner !== "string") {
          throw new DomainError("CHANNEL_ENTRY_INVALID", "每个渠道必须给出 channel_id 与 handling_owner");
        }
      }
      return this.#emit(state, "SCOPE_CHANGED", "quote_fragment", quote_id, {
        new_scopes: [...new_scopes],
        changed_at,
        applied_to_unpublished: !alreadyReleased,
        published_channels: [...published_channels],
      }, at);
    });
  }

  // ---------- 专家更正：只追加、链向旧引用 ----------

  sendCorrection(input) {
    return this.#exclusive(() => {
      const state = this.#state();
      const {
        correction_id, quote_id, corrected_text, corrected_translations = [],
        correction_kind, issued_by, recipient_scope,
        sent_at = this.clock(), at = this.clock(),
      } = input;
      if (state.corrections.has(correction_id)) throw new DomainError("CORRECTION_EXISTS", "更正已存在");
      const quote = state.quotes.get(quote_id);
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "回答片段不存在");
      if (!quote.publish?.released_at) {
        throw new DomainError("NOT_YET_RELEASED", "尚未合法发布的措辞不需要更正，可直接发布新版本");
      }
      if (typeof corrected_text !== "string" || corrected_text.trim() === "") {
        throw new DomainError("TEXT_REQUIRED", "更正文本不能为空");
      }
      if (!["factual", "wording"].includes(correction_kind)) {
        throw new DomainError("UNSUPPORTED_CORRECTION_KIND", "更正类型只能是 factual 或 wording");
      }
      if (!recipient_scope || !Array.isArray(recipient_scope.channels) || recipient_scope.channels.length === 0) {
        throw new DomainError("RECIPIENT_CHANNELS_REQUIRED", "更正必须指明送达渠道");
      }
      const event = this.#emit(state, "CORRECTION_SENT", "correction_notice", correction_id, {
        supersedes: quote_id,
        supersedes_version: quote.publish.release_version,
        old_text: quote.publish.source_text,
        corrected_text,
        corrected_translations: [...corrected_translations],
        correction_kind,
        issued_by,
        recipient_scope,
        channels: [...recipient_scope.channels],
        sent_at,
      }, at);
      return event;
    });
  }

  ackCorrectionDelivery({ correction_id, channel, acked_by = null, acked_at = this.clock(), at = this.clock() }) {
    return this.#exclusive(() => {
      const state = this.#state();
      const correction = state.corrections.get(correction_id);
      if (!correction) throw new DomainError("CORRECTION_NOT_FOUND", "更正不存在");
      const delivery = correction.deliveries.find((d) => d.channel === channel);
      if (!delivery) throw new DomainError("CHANNEL_NOT_IN_SCOPE", "该渠道不在更正送达范围内");
      if (delivery.status === "acked") throw new DomainError("DELIVERY_ALREADY_ACKED", "送达已确认");
      return this.#emit(state, "CORRECTION_DELIVERY_ACKED", "correction_notice", correction_id, {
        correction_id, channel, acked_by, acked_at,
      }, at);
    });
  }
}

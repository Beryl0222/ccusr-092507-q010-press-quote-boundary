import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { validateEvent } from "./contracts.js";
import { isValidTimeZone, resolveInstant } from "./time.js";

const defaultSchema = JSON.parse(
  readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
);

export const QUOTE_LEVELS = ["on_record", "background", "pending_confirmation", "off_record"];
export const RELEASABLE_LEVELS = ["on_record", "background"];
export const ROLES = ["organizer", "editor", "translator", "expert", "journalist"];
export const JOURNALIST_ACCESS_LEVELS = ["on_record", "background"];

const DEFAULT_ATTRIBUTION_RULES = {
  on_record: { mode: "named" },
  background: { mode: "anonymous", label: "与会专家" },
};

const OBLIGATION_ACTIONS = {
  off_record: "撤回已发布内容并通知转载渠道",
  background: "删除直接引语，改为背景表述",
  pending_confirmation: "暂停引用，等待确认",
  on_record: "按可引口径重新核对已发内容",
};

export class PlatformError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlatformError(code, message);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function contentHash(entry) {
  return createHash("sha256").update(stableStringify(entry)).digest("hex");
}

function emptyState() {
  return {
    sessions: new Map(),
    participants: new Map(),
    accreditations: new Map(),
    questions: new Map(),
    fragments: new Map(),
    corrections: new Map(),
    obligations: new Map(),
    receipts: new Map(),
    quarantine: new Map(),
    audit: [],
    aggregateVersions: new Map(),
    counters: {
      question: 0,
      fragment: 0,
      translation: 0,
      release: 0,
      correction: 0,
      obligation: 0,
      quarantine: 0,
      receipt: 0,
      attachment: 0,
    },
  };
}

export class PressQuoteBoundary {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schema = options.schema ?? defaultSchema;
    this.state = emptyState();
  }

  static restore(snapshot, options = {}) {
    const raw = JSON.parse(snapshot);
    const state = {};
    for (const [key, value] of Object.entries(raw)) {
      state[key] = value && Array.isArray(value.__map) ? new Map(value.__map) : value;
    }
    const platform = new PressQuoteBoundary(options);
    platform.state = state;
    return platform;
  }

  snapshot() {
    const json = {};
    for (const [key, value] of Object.entries(this.state)) {
      json[key] = value instanceof Map ? { __map: [...value] } : value;
    }
    return JSON.stringify(json);
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  _nextId(counter, prefix) {
    const next = ++this.state.counters[counter];
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  _emit(eventType, aggregateType, aggregateId, payload) {
    const version = (this.state.aggregateVersions.get(aggregateId) ?? 0) + 1;
    this.state.aggregateVersions.set(aggregateId, version);
    const event = {
      event_id: randomUUID(),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this._nowIso(),
      version,
      payload,
    };
    const issues = validateEvent(event, this.schema);
    if (issues.length > 0) {
      fail(
        "contract_violation",
        `领域事件未通过契约校验: ${issues.map((issue) => `${issue.field}:${issue.code}`).join(", ")}`,
      );
    }
    this.state.audit.push(event);
    return event;
  }

  _session(sessionId) {
    const session = this.state.sessions.get(sessionId);
    if (!session) fail("unknown_session", `场次未登记: ${sessionId}`);
    return session;
  }

  _fragment(fragmentId) {
    const fragment = this.state.fragments.get(fragmentId);
    if (!fragment) fail("unknown_fragment", `片段不存在: ${fragmentId}`);
    return fragment;
  }

  _requireParticipant(participantId, roles, message = "该角色无权执行此操作") {
    const participant = this.state.participants.get(participantId);
    if (!participant) fail("unknown_participant", `参与者未登记: ${participantId}`);
    if (roles && !roles.includes(participant.role)) fail("not_authorized", message);
    return participant;
  }

  _resolveSessionTime(value, session, field) {
    if (value === null || value === undefined) return null;
    const ms = resolveInstant(value, session.timezone);
    if (Number.isNaN(ms)) fail("invalid_time", `字段 ${field} 不是可识别的时间`);
    return ms;
  }

  // ---- 场次与参与者 ----

  registerSession({
    session_id,
    title,
    timezone,
    default_quote_level = "pending_confirmation",
    attribution_rules = {},
    embargo_until = null,
    pending_upgrade_at = null,
    pending_target_level = "on_record",
  }) {
    if (typeof session_id !== "string" || session_id.trim() === "") fail("required", "场次标识必填");
    if (this.state.sessions.has(session_id)) fail("duplicate_session", `场次已存在: ${session_id}`);
    if (!isValidTimeZone(timezone)) fail("invalid_timezone", `场次时区无效: ${timezone}`);
    if (!QUOTE_LEVELS.includes(default_quote_level) || default_quote_level === "off_record") {
      fail("unsupported_value", "场次默认引用级别无效");
    }
    const session = {
      session_id,
      title: title ?? session_id,
      timezone,
      default_quote_level,
      attribution_rules: {
        on_record: { ...DEFAULT_ATTRIBUTION_RULES.on_record, ...attribution_rules.on_record },
        background: { ...DEFAULT_ATTRIBUTION_RULES.background, ...attribution_rules.background },
      },
      pending_target_level,
      default_embargo_ms: null,
      default_pending_upgrade_ms: null,
    };
    session.default_embargo_ms = this._resolveSessionTime(embargo_until, session, "embargo_until");
    session.default_pending_upgrade_ms = this._resolveSessionTime(
      pending_upgrade_at,
      session,
      "pending_upgrade_at",
    );
    this.state.sessions.set(session_id, session);
    return { ...session };
  }

  registerParticipant({ participant_id, role, name, title = null, outlet = null }) {
    if (typeof participant_id !== "string" || participant_id.trim() === "") {
      fail("required", "参与者标识必填");
    }
    if (!ROLES.includes(role)) fail("unsupported_value", `未登记的角色: ${role}`);
    if (this.state.participants.has(participant_id)) {
      fail("duplicate_participant", `参与者已存在: ${participant_id}`);
    }
    const participant = { participant_id, role, name: name ?? participant_id, title, outlet };
    this.state.participants.set(participant_id, participant);
    return { ...participant };
  }

  accreditJournalist({ session_id, journalist_id, outlet = null, credential_id, access_levels }) {
    const session = this._session(session_id);
    const journalist = this._requireParticipant(journalist_id, ["journalist"], "仅记者可获得场次资质");
    if (typeof credential_id !== "string" || credential_id.trim() === "") {
      fail("required", "记者资质证件号必填");
    }
    if (!Array.isArray(access_levels) || access_levels.length === 0) {
      fail("required", "必须指定可获得的引用级别");
    }
    for (const level of access_levels) {
      if (!JOURNALIST_ACCESS_LEVELS.includes(level)) {
        fail("unsupported_value", `记者不可获得的引用级别: ${level}`);
      }
    }
    const key = `${session_id}::${journalist_id}`;
    const accreditation = {
      session_id,
      journalist_id,
      outlet: outlet ?? journalist.outlet,
      credential_id,
      access_levels: [...new Set(access_levels)],
      granted_at: this._nowIso(),
    };
    this.state.accreditations.set(key, accreditation);
    return { ...accreditation, session_timezone: session.timezone };
  }

  // ---- 接入：幂等、冲突隔离、乱序 ----

  ingest(entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail("object_required", "接入条目必须是 JSON 对象");
    }
    const { external_id } = entry;
    if (typeof external_id !== "string" || external_id.trim() === "") {
      fail("required", "外部标识必填");
    }
    const hash = contentHash(entry);
    const existing = this.state.receipts.get(external_id);
    if (existing) {
      if (existing.content_hash === hash) {
        return { ...existing.receipt, reused: true };
      }
      const quarantine_id = this._nextId("quarantine", "QN");
      this.state.quarantine.set(quarantine_id, {
        quarantine_id,
        external_id,
        status: "isolated",
        received_at: this._nowIso(),
        original_receipt_id: existing.receipt.receipt_id,
        conflicting_entry: JSON.parse(JSON.stringify(entry)),
      });
      return {
        receipt_id: this._nextId("receipt", "RC"),
        external_id,
        status: "quarantined",
        quarantine_id,
        received_at: this._nowIso(),
        reused: false,
      };
    }
    let applied;
    if (entry.kind === "question") {
      applied = { kind: "question", question_id: this.acceptQuestion(entry).question_id };
    } else if (entry.kind === "quote") {
      applied = { kind: "quote", fragment_id: this.captureQuote(entry).fragment_id };
    } else {
      fail("unsupported_kind", `不支持的接入类型: ${entry.kind}`);
    }
    const receipt = {
      receipt_id: this._nextId("receipt", "RC"),
      external_id,
      status: "accepted",
      applied,
      received_at: this._nowIso(),
      reused: false,
    };
    this.state.receipts.set(external_id, { receipt, content_hash: hash });
    return { ...receipt };
  }

  listQuarantine() {
    return [...this.state.quarantine.values()].map((item) => ({ ...item }));
  }

  // ---- 提问与片段 ----

  acceptQuestion({ session_id, journalist_id, language, text, occurred_at }) {
    const session = this._session(session_id);
    this._requireParticipant(journalist_id, ["journalist"], "提问者必须是已登记记者");
    if (!this.state.accreditations.has(`${session_id}::${journalist_id}`)) {
      fail("not_accredited", `记者未获得该场次资质: ${journalist_id}`);
    }
    if (typeof text !== "string" || text.trim() === "") fail("required", "提问内容必填");
    const occurredMs = this._resolveSessionTime(occurred_at, session, "occurred_at");
    const question = {
      question_id: this._nextId("question", "Q"),
      session_id,
      journalist_id,
      language: language ?? "zh",
      text,
      occurred_ms: occurredMs ?? this.now(),
      occurred_at: new Date(occurredMs ?? this.now()).toISOString(),
      seq: this.state.counters.question,
    };
    this.state.questions.set(question.question_id, question);
    this._emit("QUESTION_ACCEPTED", "question_turn", question.question_id, {
      session_id,
      journalist_id,
      language: question.language,
      text,
    });
    return { ...question };
  }

  captureQuote({
    session_id,
    speaker_id,
    source_language,
    text,
    question_id = null,
    quote_level = null,
    embargo_until = null,
    pending_upgrade_at = null,
    pending_target_level = null,
    occurred_at = null,
  }) {
    const session = this._session(session_id);
    this._requireParticipant(speaker_id, null);
    if (typeof source_language !== "string" || source_language.trim() === "") {
      fail("required", "原始语言必填");
    }
    if (typeof text !== "string" || text.trim() === "") fail("required", "回答内容必填");
    if (question_id !== null && !this.state.questions.has(question_id)) {
      fail("unknown_question", `提问不存在: ${question_id}`);
    }
    const level = quote_level ?? session.default_quote_level;
    if (!QUOTE_LEVELS.includes(level) || level === "off_record") {
      fail("unsupported_value", `引用级别无效: ${level}`);
    }
    const embargoMs =
      this._resolveSessionTime(embargo_until, session, "embargo_until") ?? session.default_embargo_ms;
    const pendingUpgradeMs =
      this._resolveSessionTime(pending_upgrade_at, session, "pending_upgrade_at") ??
      session.default_pending_upgrade_ms;
    const occurredMs = this._resolveSessionTime(occurred_at, session, "occurred_at") ?? this.now();
    const fragment = {
      fragment_id: this._nextId("fragment", "F"),
      session_id,
      question_id,
      speaker_id,
      source_language,
      source_text: text,
      source_version: 1,
      quote_level: level,
      confirmations: [],
      embargo_ms: embargoMs,
      embargo_until: embargoMs === null ? null : new Date(embargoMs).toISOString(),
      availability: embargoMs !== null && embargoMs > this.now() ? "embargoed" : "available",
      pending_upgrade_ms: level === "pending_confirmation" ? pendingUpgradeMs : null,
      pending_upgrade_at:
        level === "pending_confirmation" && pendingUpgradeMs !== null
          ? new Date(pendingUpgradeMs).toISOString()
          : null,
      pending_target_level: pending_target_level ?? session.pending_target_level,
      translations: [],
      fact_attachments: [],
      releases: [],
      current_release_version: 0,
      scope_notices: [],
      occurred_ms: occurredMs,
      occurred_at: new Date(occurredMs).toISOString(),
      seq: this.state.counters.fragment,
    };
    this.state.fragments.set(fragment.fragment_id, fragment);
    this._emit("QUOTE_CAPTURED", "quote_fragment", fragment.fragment_id, {
      session_id,
      question_id,
      speaker_id,
      source_language,
      quote_level: level,
    });
    return { ...fragment };
  }

  attachFact({ fragment_id, title, content = null, uri = null, added_by }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(added_by, ["organizer", "editor"], "仅主办方或编辑可添加事实附件");
    if (typeof title !== "string" || title.trim() === "") fail("required", "附件标题必填");
    const attachment = {
      attachment_id: this._nextId("attachment", "FA"),
      title,
      content,
      uri,
      added_by,
      added_at: this._nowIso(),
    };
    fragment.fact_attachments.push(attachment);
    return { ...attachment };
  }

  // ---- 翻译：提交与审批分离 ----

  submitTranslation({ fragment_id, language, text, translator_id }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(translator_id, ["translator"], "仅登记翻译者可提交译文");
    if (typeof language !== "string" || language.trim() === "") fail("required", "译文语言必填");
    if (typeof text !== "string" || text.trim() === "") fail("required", "译文内容必填");
    const version =
      fragment.translations.filter((item) => item.language === language).length + 1;
    const translation = {
      translation_id: this._nextId("translation", "T"),
      language,
      text,
      translator_id,
      version,
      status: "draft",
      approved_by: null,
      approved_at: null,
      submitted_at: this._nowIso(),
    };
    fragment.translations.push(translation);
    return { ...translation };
  }

  approveTranslation({ fragment_id, translation_id, approver_id }) {
    const fragment = this._fragment(fragment_id);
    const translation = fragment.translations.find((item) => item.translation_id === translation_id);
    if (!translation) fail("unknown_translation", `译文不存在: ${translation_id}`);
    if (approver_id === translation.translator_id) {
      fail("self_approval_forbidden", "翻译者不能批准自己的译文");
    }
    this._requireParticipant(approver_id, ["editor", "organizer"], "译文须由编辑或主办方审批");
    if (translation.status === "approved") fail("already_approved", "该译文已审批");
    for (const item of fragment.translations) {
      if (item.language === translation.language && item.status === "approved") {
        item.status = "superseded";
      }
    }
    translation.status = "approved";
    translation.approved_by = approver_id;
    translation.approved_at = this._nowIso();
    this._emit("TRANSLATION_APPROVED", "quote_fragment", fragment_id, {
      translation_id,
      language: translation.language,
      version: translation.version,
      approver_id,
    });
    return { ...translation };
  }

  // ---- 确认与定时升级 ----

  confirmFragment({ fragment_id, confirmer_id, final_level = "on_record", note = null }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(confirmer_id, ["expert", "editor", "organizer"], "确认须由专家或编辑方作出");
    if (fragment.quote_level !== "pending_confirmation") {
      fail("not_pending", "片段不在等待确认状态");
    }
    if (!RELEASABLE_LEVELS.includes(final_level)) {
      fail("unsupported_value", `确认后的引用级别无效: ${final_level}`);
    }
    fragment.quote_level = final_level;
    fragment.pending_upgrade_ms = null;
    fragment.pending_upgrade_at = null;
    const confirmation = {
      confirmer_id,
      via: "manual",
      final_level,
      note,
      at: this._nowIso(),
    };
    fragment.confirmations.push(confirmation);
    return { ...confirmation };
  }

  setEmbargo({ fragment_id, embargo_until, set_by }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(set_by, ["editor", "organizer"], "禁发时点须由编辑或主办方设定");
    const session = this._session(fragment.session_id);
    const ms = this._resolveSessionTime(embargo_until, session, "embargo_until");
    fragment.embargo_ms = ms;
    fragment.embargo_until = ms === null ? null : new Date(ms).toISOString();
    fragment.availability =
      ms !== null && ms > this.now() ? "embargoed" : "available";
    return { fragment_id, embargo_until: fragment.embargo_until };
  }

  tick(atMs = null) {
    const now = atMs ?? this.now();
    const released = [];
    const upgraded = [];
    for (const fragment of this.state.fragments.values()) {
      if (
        fragment.availability === "embargoed" &&
        fragment.embargo_ms !== null &&
        now >= fragment.embargo_ms
      ) {
        fragment.availability = "available";
        released.push(fragment.fragment_id);
      }
      if (
        fragment.quote_level === "pending_confirmation" &&
        fragment.pending_upgrade_ms !== null &&
        now >= fragment.pending_upgrade_ms
      ) {
        fragment.quote_level = fragment.pending_target_level;
        fragment.pending_upgrade_ms = null;
        fragment.pending_upgrade_at = null;
        fragment.confirmations.push({
          confirmer_id: "system",
          via: "scheduled",
          final_level: fragment.pending_target_level,
          note: "到达场次规定时点，待确认材料自动升级",
          at: new Date(now).toISOString(),
        });
        upgraded.push(fragment.fragment_id);
      }
    }
    return { released, upgraded };
  }

  nextDueAt() {
    const times = [];
    for (const fragment of this.state.fragments.values()) {
      if (fragment.availability === "embargoed" && fragment.embargo_ms !== null) {
        times.push(fragment.embargo_ms);
      }
      if (fragment.quote_level === "pending_confirmation" && fragment.pending_upgrade_ms !== null) {
        times.push(fragment.pending_upgrade_ms);
      }
    }
    const future = times.filter((time) => time > this.now());
    return future.length === 0 ? null : new Date(Math.min(...future)).toISOString();
  }

  // ---- 发布：固定原文与翻译，并发只保留一个当前版本 ----

  releaseQuote({ fragment_id, editor_id, translation_id = null, quote_level = null, channels = [], expected_version }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(editor_id, ["editor", "organizer"], "仅编辑或主办方可发布片段");
    if (expected_version !== fragment.current_release_version) {
      fail(
        "version_conflict",
        `片段当前版本已变为 ${fragment.current_release_version}，并发发布只保留一个当前版本`,
      );
    }
    const level = quote_level ?? fragment.quote_level;
    if (fragment.quote_level === "pending_confirmation") {
      fail("not_confirmed", "等待确认的片段不得发布");
    }
    if (!RELEASABLE_LEVELS.includes(level)) {
      fail("not_releasable", `引用级别不可发布: ${level}`);
    }
    if (fragment.embargo_ms !== null && this.now() < fragment.embargo_ms) {
      fail("embargo_active", `禁发期未届满（至 ${fragment.embargo_until}）`);
    }
    let pinnedTranslation = null;
    if (translation_id !== null) {
      const translation = fragment.translations.find((item) => item.translation_id === translation_id);
      if (!translation) fail("unknown_translation", `译文不存在: ${translation_id}`);
      if (translation.status !== "approved") {
        fail("translation_not_approved", "发布只能固定已审批的译文");
      }
      pinnedTranslation = {
        translation_id: translation.translation_id,
        language: translation.language,
        version: translation.version,
        text: translation.text,
      };
    }
    const release = {
      release_id: this._nextId("release", "R"),
      fragment_id,
      release_version: fragment.current_release_version + 1,
      quote_level: level,
      pinned: {
        source_version: fragment.source_version,
        source_text: fragment.source_text,
        source_language: fragment.source_language,
        translation: pinnedTranslation,
      },
      channels: [...new Set(channels)],
      released_by: editor_id,
      released_at: this._nowIso(),
    };
    fragment.releases.push(release);
    fragment.current_release_version = release.release_version;
    this._emit("QUOTE_RELEASED", "quote_fragment", fragment_id, {
      quote_level: level,
      release_version: release.release_version,
      translation_id,
      channels: release.channels,
    });
    return JSON.parse(JSON.stringify(release));
  }

  // ---- 更正：不覆盖已发措辞，与旧引用相连，跟踪送达 ----

  issueCorrection({ fragment_id, expert_id, corrected_text, language = null, reason, channels_extra = [] }) {
    const fragment = this._fragment(fragment_id);
    this._requireParticipant(expert_id, ["expert", "organizer"], "更正须由专家或主办方发出");
    if (fragment.releases.length === 0) {
      fail("nothing_to_correct", "片段尚未发布，无需更正，可直接修正");
    }
    if (typeof corrected_text !== "string" || corrected_text.trim() === "") {
      fail("required", "更正措辞必填");
    }
    const supersedes = fragment.current_release_version;
    const recipientScope = [
      ...new Set([...fragment.releases.flatMap((release) => release.channels), ...channels_extra]),
    ];
    const correction = {
      correction_id: this._nextId("correction", "C"),
      fragment_id,
      supersedes_release: supersedes,
      corrected_text,
      language: language ?? fragment.source_language,
      reason: reason ?? null,
      issued_by: expert_id,
      issued_at: this._nowIso(),
      recipient_scope: recipientScope,
      deliveries: recipientScope.map((channel) => ({ channel, status: "pending", at: null })),
    };
    this.state.corrections.set(correction.correction_id, correction);
    this._emit("CORRECTION_SENT", "correction_notice", correction.correction_id, {
      fragment_id,
      supersedes,
      recipient_scope: recipientScope,
    });
    return JSON.parse(JSON.stringify(correction));
  }

  recordCorrectionDelivery({ correction_id, channel, status = "delivered", at = null }) {
    const correction = this.state.corrections.get(correction_id);
    if (!correction) fail("unknown_correction", `更正不存在: ${correction_id}`);
    const delivery = correction.deliveries.find((item) => item.channel === channel);
    if (!delivery) fail("unknown_recipient", `渠道不在更正送达范围: ${channel}`);
    delivery.status = status;
    delivery.at = at ?? this._nowIso();
    return { ...delivery };
  }

  // ---- 会后范围变更：只影响未发布内容，已发布渠道列出处理责任 ----

  changeScope({ session_id = null, fragment_ids = null, new_level, changed_by, reason = null }) {
    this._requireParticipant(changed_by, ["organizer", "editor"], "范围变更须由主办方或编辑作出");
    if (!QUOTE_LEVELS.includes(new_level)) fail("unsupported_value", `引用级别无效: ${new_level}`);
    let targets;
    if (fragment_ids !== null) {
      targets = fragment_ids.map((id) => this._fragment(id));
    } else if (session_id !== null) {
      this._session(session_id);
      targets = [...this.state.fragments.values()].filter((item) => item.session_id === session_id);
    } else {
      fail("required", "范围变更必须指定场次或片段");
    }
    const unpublishedUpdated = [];
    const publishedUntouched = [];
    const obligations = [];
    for (const fragment of targets) {
      if (fragment.releases.length === 0) {
        fragment.quote_level = new_level;
        unpublishedUpdated.push(fragment.fragment_id);
        continue;
      }
      publishedUntouched.push(fragment.fragment_id);
      fragment.scope_notices.push({
        new_level,
        reason,
        changed_by,
        at: this._nowIso(),
      });
      const channels = [...new Set(fragment.releases.flatMap((release) => release.channels))];
      for (const channel of channels) {
        const obligation = {
          obligation_id: this._nextId("obligation", "OB"),
          fragment_id: fragment.fragment_id,
          channel,
          required_action: OBLIGATION_ACTIONS[new_level],
          new_level,
          reason,
          created_by: changed_by,
          created_at: this._nowIso(),
          status: "pending",
          handled_by: null,
          handled_at: null,
          note: null,
        };
        this.state.obligations.set(obligation.obligation_id, obligation);
        obligations.push({ ...obligation });
      }
    }
    return {
      unpublished_updated: unpublishedUpdated,
      published_untouched: publishedUntouched,
      obligations,
    };
  }

  resolveObligation({ obligation_id, handled_by, note = null }) {
    const obligation = this.state.obligations.get(obligation_id);
    if (!obligation) fail("unknown_obligation", `处理责任不存在: ${obligation_id}`);
    obligation.status = "handled";
    obligation.handled_by = handled_by;
    obligation.handled_at = this._nowIso();
    obligation.note = note;
    return { ...obligation };
  }

  listObligations({ status = null } = {}) {
    return [...this.state.obligations.values()]
      .filter((item) => status === null || item.status === status)
      .map((item) => ({ ...item }));
  }

  // ---- 记者 API：只返回有权获得的材料，明确可引文字段与署名要求 ----

  _releasedView(fragment) {
    if (fragment.releases.length === 0) return null;
    if (fragment.embargo_ms !== null && this.now() < fragment.embargo_ms) return null;
    return fragment.releases[fragment.releases.length - 1];
  }

  _journalistRelease(journalistId, fragment) {
    const accreditation = this.state.accreditations.get(`${fragment.session_id}::${journalistId}`);
    if (!accreditation) fail("not_available", "材料不存在或不在可获取范围");
    const release = this._releasedView(fragment);
    if (!release) fail("not_available", "材料不存在或不在可获取范围");
    if (!accreditation.access_levels.includes(release.quote_level)) {
      fail("not_available", "材料不存在或不在可获取范围");
    }
    return { accreditation, release };
  }

  journalistFeed({ journalist_id, session_id }) {
    this._requireParticipant(journalist_id, ["journalist"], "仅记者可调用记者接口");
    this._session(session_id);
    if (!this.state.accreditations.has(`${session_id}::${journalist_id}`)) {
      fail("not_available", "材料不存在或不在可获取范围");
    }
    const feed = [];
    for (const fragment of this.state.fragments.values()) {
      if (fragment.session_id !== session_id) continue;
      try {
        const { release } = this._journalistRelease(journalist_id, fragment);
        feed.push({
          fragment_id: fragment.fragment_id,
          quote_level: release.quote_level,
          release_version: release.release_version,
          quotable: release.quote_level === "on_record",
          embargo_until: fragment.embargo_until,
        });
      } catch (error) {
        if (!(error instanceof PlatformError && error.code === "not_available")) throw error;
      }
    }
    return feed;
  }

  journalistView({ journalist_id, fragment_id, language = null }) {
    this._requireParticipant(journalist_id, ["journalist"], "仅记者可调用记者接口");
    const fragment = this.state.fragments.get(fragment_id);
    if (!fragment) fail("not_available", "材料不存在或不在可获取范围");
    const { release } = this._journalistRelease(journalist_id, fragment);
    const session = this._session(fragment.session_id);
    const speaker = this.state.participants.get(fragment.speaker_id);
    const pinnedTranslation = release.pinned.translation;
    const useTranslation =
      pinnedTranslation !== null && (language === null || language === pinnedTranslation.language);
    const level = release.quote_level;
    const rules = session.attribution_rules[level] ?? session.attribution_rules.background;
    const attribution =
      level === "on_record" && rules.mode === "named"
        ? {
            mode: "named",
            speaker: { name: speaker?.name ?? null, title: speaker?.title ?? null },
            requirement: `可直接引用并须署名：${speaker?.name ?? "不详"}${speaker?.title ? `（${speaker.title}）` : ""}`,
          }
        : {
            mode: "anonymous",
            speaker: null,
            requirement: `仅供背景理解，不得直接引用，不得署名；如需指向来源仅可表述为“${rules.label}”`,
          };
    const corrections = [...this.state.corrections.values()]
      .filter((item) => item.fragment_id === fragment_id)
      .map((item) => ({
        correction_id: item.correction_id,
        supersedes_release: item.supersedes_release,
        corrected_text: item.corrected_text,
        language: item.language,
        reason: item.reason,
        issued_at: item.issued_at,
      }));
    return {
      fragment_id,
      session_id: fragment.session_id,
      release_version: release.release_version,
      quote_level: level,
      quotable: level === "on_record",
      usage: level === "on_record" ? "可直接引用" : "仅供背景理解，不得直接引用",
      quotable_text: useTranslation ? pinnedTranslation.text : release.pinned.source_text,
      text_language: useTranslation ? pinnedTranslation.language : release.pinned.source_language,
      source_language: release.pinned.source_language,
      attribution,
      embargo_until: fragment.embargo_until,
      fact_attachments: fragment.fact_attachments.map((item) => ({ ...item })),
      corrections,
      scope_notice: fragment.scope_notices.length > 0 ? { ...fragment.scope_notices.at(-1) } : null,
    };
  }

  // ---- 主办方追溯：从报道引用追到提问、原话、翻译、确认与更正送达 ----

  traceCitation({ requester_id, fragment_id, release_version = null }) {
    this._requireParticipant(requester_id, ["organizer", "editor"], "仅主办方可追溯引用链");
    const fragment = this._fragment(fragment_id);
    const release =
      release_version === null
        ? fragment.releases[fragment.releases.length - 1]
        : fragment.releases.find((item) => item.release_version === release_version);
    if (!release) fail("unknown_release", "片段尚无发布版本");
    const question = fragment.question_id ? this.state.questions.get(fragment.question_id) : null;
    const speaker = this.state.participants.get(fragment.speaker_id);
    const corrections = [...this.state.corrections.values()]
      .filter((item) => item.fragment_id === fragment_id)
      .map((item) => ({
        correction_id: item.correction_id,
        supersedes_release: item.supersedes_release,
        corrected_text: item.corrected_text,
        language: item.language,
        reason: item.reason,
        issued_by: item.issued_by,
        issued_at: item.issued_at,
        deliveries: item.deliveries.map((delivery) => ({ ...delivery })),
      }));
    const aggregateIds = new Set([
      fragment_id,
      ...(fragment.question_id ? [fragment.question_id] : []),
      ...corrections.map((item) => item.correction_id),
    ]);
    return {
      citation: {
        release_id: release.release_id,
        release_version: release.release_version,
        quote_level: release.quote_level,
        quotable_text: release.pinned.translation?.text ?? release.pinned.source_text,
        channels: [...release.channels],
        released_by: release.released_by,
        released_at: release.released_at,
      },
      question: question
        ? {
            question_id: question.question_id,
            journalist_id: question.journalist_id,
            language: question.language,
            text: question.text,
            occurred_at: question.occurred_at,
          }
        : null,
      source: {
        speaker_id: fragment.speaker_id,
        speaker_name: speaker?.name ?? null,
        source_language: release.pinned.source_language,
        source_text: release.pinned.source_text,
        source_version: release.pinned.source_version,
      },
      translation: release.pinned.translation
        ? (() => {
            const record = fragment.translations.find(
              (item) => item.translation_id === release.pinned.translation.translation_id,
            );
            return {
              ...release.pinned.translation,
              translator_id: record?.translator_id ?? null,
              approved_by: record?.approved_by ?? null,
              approved_at: record?.approved_at ?? null,
            };
          })()
        : null,
      confirmations: fragment.confirmations.map((item) => ({ ...item })),
      corrections,
      obligations: [...this.state.obligations.values()]
        .filter((item) => item.fragment_id === fragment_id)
        .map((item) => ({ ...item })),
      events: this.state.audit.filter((event) => aggregateIds.has(event.aggregate_id)),
    };
  }

  sessionTimeline({ session_id }) {
    this._session(session_id);
    const entries = [];
    for (const question of this.state.questions.values()) {
      if (question.session_id === session_id) {
        entries.push({ kind: "question", id: question.question_id, occurred_ms: question.occurred_ms, seq: question.seq });
      }
    }
    for (const fragment of this.state.fragments.values()) {
      if (fragment.session_id === session_id) {
        entries.push({ kind: "quote", id: fragment.fragment_id, occurred_ms: fragment.occurred_ms, seq: fragment.seq });
      }
    }
    return entries
      .sort((left, right) => left.occurred_ms - right.occurred_ms || left.seq - right.seq)
      .map(({ kind, id, occurred_ms }) => ({ kind, id, occurred_at: new Date(occurred_ms).toISOString() }));
  }

  auditLog() {
    return this.state.audit.map((event) => JSON.parse(JSON.stringify(event)));
  }
}

/**
 * 事件重放投影：把事件流折叠成当前世界状态。
 * 投影本身不做业务裁决，只如实记录事件表达的事实；
 * 业务规则（资质、权限、幂等、冲突）全部在 service.js 中守护。
 */

export function createState() {
  return {
    sessions: new Map(),
    reporters: new Map(),
    grants: new Map(),
    questions: new Map(),
    quotes: new Map(),
    corrections: new Map(),
    /** external_id -> 首次成功采集的回执信息 */
    receiptsByExternal: new Map(),
    /** 被隔离的提交记录 */
    quarantines: [],
  };
}

export function applyEvent(state, event) {
  const p = event.payload;
  switch (event.event_type) {
    case "SESSION_REGISTERED":
      state.sessions.set(p.session_id, {
        id: p.session_id,
        timezone: p.timezone,
        name: p.name ?? null,
      });
      break;

    case "REPORTER_VERIFIED":
      state.reporters.set(p.reporter_id, {
        id: p.reporter_id,
        outlet: p.outlet,
        languages: [...p.languages],
        verified_at: p.verified_at ?? event.occurred_at,
      });
      break;

    case "GRANT_ISSUED":
      state.grants.set(p.grant_id, {
        id: p.grant_id,
        reporter_id: p.reporter_id,
        session_id: p.session_id,
        scopes: [...p.scopes],
        api_token: p.api_token ?? null,
        status: "active",
        issued_at: p.issued_at,
      });
      break;

    case "GRANT_REVOKED": {
      const grant = state.grants.get(p.grant_id);
      if (grant) {
        grant.status = "revoked";
        grant.revoked_at = p.revoked_at;
      }
      break;
    }

    case "QUESTION_ACCEPTED":
      state.questions.set(event.aggregate_id, {
        id: event.aggregate_id,
        session_id: p.session_id,
        reporter_id: p.reporter_id,
        text: p.text,
        language: p.language,
      });
      break;

    case "QUOTE_CAPTURED": {
      const quote = {
        id: event.aggregate_id,
        session_id: p.session_id,
        question_id: p.question_id,
        external_id: p.external_id,
        source_kind: p.source_kind,
        speaker_id: p.speaker_id,
        source_language: p.source_language,
        text: p.text,
        captured_at: event.occurred_at,
        status: "captured",
        translations: new Map(),
        facts: [],
        publish: null,
        publications: [],
        scope_change: null,
        correction_ids: [],
      };
      state.quotes.set(quote.id, quote);
      state.receiptsByExternal.set(p.external_id, {
        receipt_id: p.receipt_id,
        quote_id: quote.id,
        content_hash: p.content_hash,
        captured_at: event.occurred_at,
      });
      break;
    }

    case "QUOTE_QUARANTINED":
      state.quarantines.push({
        id: event.aggregate_id,
        external_id: p.external_id,
        reason: p.reason,
        content_hash: p.content_hash,
        expected_hash: p.expected_hash,
        text: p.text,
        source_kind: p.source_kind,
        at: event.occurred_at,
      });
      break;

    case "TRANSLATION_SUBMITTED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.translations.set(p.translation_id, {
          id: p.translation_id,
          translator_id: p.translator_id,
          language: p.language,
          text: p.text,
          submitted_at: p.submitted_at,
          status: "submitted",
          approved_by: null,
          approved_at: null,
        });
      }
      break;
    }

    case "TRANSLATION_APPROVED": {
      const quote = state.quotes.get(event.aggregate_id);
      const translation = quote?.translations.get(p.translation_id);
      if (translation) {
        translation.status = "approved";
        translation.approved_by = p.approver_id;
        translation.approved_at = event.occurred_at;
      }
      break;
    }

    case "FACT_ATTACHED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.facts.push({
          attachment_id: p.attachment_id,
          title: p.title,
          reference: p.reference,
          attached_at: p.attached_at,
        });
      }
      break;
    }

    case "QUOTE_PUBLISHED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        const record = {
          release_version: p.release_version,
          quote_level: p.quote_level,
          source_text_ref: p.source_text_ref,
          // 发布即固定：原文与译文快照随版本保存，后续更正不会改写它。
          source_text: p.source_text,
          source_language: p.source_language,
          speaker_id: p.speaker_id,
          approved_translation_ids: [...p.approved_translation_ids],
          approved_translations: [...(p.approved_translations ?? [])],
          embargo_until: p.embargo_until,
          session_timezone: p.session_timezone,
          attribution: p.attribution,
          eligible_grant_scopes: [...p.eligible_grant_scopes],
          published_at: p.published_at,
          released_at: p.released_at ?? null,
          current: true,
        };
        if (quote.publish) {
          quote.publish.current = false;
          quote.publications.push(quote.publish);
        }
        quote.publish = record;
        quote.status = "published";
      }
      break;
    }

    case "QUOTE_RELEASED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote?.publish) {
        quote.publish.released_at = event.occurred_at;
        quote.status = "released";
      }
      break;
    }

    case "QUOTE_HELD_FOR_CONFIRMATION": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.status = "held";
        quote.held_at = p.held_at;
      }
      break;
    }

    case "PENDING_ESCALATED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.status = "awaiting_confirmation";
        quote.escalated_at = p.escalated_at;
        quote.escalated_by = p.escalated_by;
      }
      break;
    }

    case "CONFIRMATION_RESOLVED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.confirmation = {
          resolution: p.resolution,
          new_level: p.new_level,
          resolved_by: p.resolved_by,
          resolved_at: p.resolved_at,
        };
        if (p.resolution === "confirmed" && quote.publish) {
          quote.publish.quote_level = p.new_level;
          quote.status = "published";
        } else if (p.resolution === "rejected") {
          quote.status = "rejected";
        }
      }
      break;
    }

    case "SCOPE_CHANGED": {
      const quote = state.quotes.get(event.aggregate_id);
      if (quote) {
        quote.scope_change = {
          new_scopes: [...p.new_scopes],
          changed_at: p.changed_at,
          applied_to_unpublished: p.applied_to_unpublished,
          published_channels: [...p.published_channels],
        };
        // 仅当没有任何已合法发布的版本时，新范围才改变当前可见性。
        if (p.applied_to_unpublished && quote.publish) {
          quote.publish.eligible_grant_scopes = [...p.new_scopes];
        }
      }
      break;
    }

    case "CORRECTION_SENT": {
      const correction = {
        id: event.aggregate_id,
        supersedes: p.supersedes,
        supersedes_version: p.supersedes_version ?? null,
        old_text: p.old_text ?? null,
        corrected_text: p.corrected_text,
        corrected_translations: [...(p.corrected_translations ?? [])],
        correction_kind: p.correction_kind,
        issued_by: p.issued_by,
        recipient_scope: p.recipient_scope,
        sent_at: p.sent_at,
        deliveries: [...(p.channels ?? [])].map((channel) => ({
          channel,
          status: "sent",
          sent_at: p.sent_at,
          acked_at: null,
        })),
      };
      state.corrections.set(correction.id, correction);
      const quote = state.quotes.get(p.supersedes);
      if (quote) quote.correction_ids.push(correction.id);
      break;
    }

    case "CORRECTION_DELIVERY_ACKED": {
      const correction = state.corrections.get(p.correction_id);
      const delivery = correction?.deliveries.find((d) => d.channel === p.channel);
      if (delivery) {
        delivery.status = "acked";
        delivery.acked_at = p.acked_at;
        delivery.acked_by = p.acked_by ?? null;
      }
      break;
    }

    default:
      break;
  }
  return state;
}

export function replay(events) {
  const state = createState();
  for (const event of events) applyEvent(state, event);
  return state;
}

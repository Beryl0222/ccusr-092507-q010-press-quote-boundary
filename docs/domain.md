# 领域约定

描述新闻交流场次中的记者资质、提问、回答采集、翻译审批、引用级别、禁发时点、范围变更与更正关系，支持多语言引语的权限隔离与端到端追溯。

## 聚合与事件

聚合：`press_session`、`reporter`、`grant`、`question_turn`、`quote_fragment`、`correction_notice`。

| 事件 | 聚合 | 含义 |
| --- | --- | --- |
| `SESSION_REGISTERED` | press_session | 场次登记，必须带 IANA `timezone`，全部禁发时点以该时区解释 |
| `REPORTER_VERIFIED` | reporter | 记者资质（所属媒体、可用语言） |
| `GRANT_ISSUED` / `GRANT_REVOKED` | grant | 场次内授权范围（`scopes`）与 API 令牌的发放、撤销 |
| `QUESTION_ACCEPTED` | question_turn | 提问受理，记者须持有该场次的有效授权 |
| `QUOTE_CAPTURED` | quote_fragment | 回答片段采集成功，记录 `external_id`、规范哈希 `content_hash` 与回执 `receipt_id` |
| `QUOTE_QUARANTINED` | quote_fragment | 同外部标识内容冲突，先隔离待人工裁决，不覆盖既有片段 |
| `TRANSLATION_SUBMITTED` / `TRANSLATION_APPROVED` | quote_fragment | 译稿提交与批准；批准人不得是译者本人 |
| `FACT_ATTACHED` | quote_fragment | 事实附件（标题、出处），随追溯链提供 |
| `QUOTE_PUBLISHED` | quote_fragment | 定版发布：`release_version` 递增，快照固定原文与已批准译文、署名、授权范围、禁发时点 |
| `QUOTE_RELEASED` | quote_fragment | 禁发到期后合法释放（DIRECT/BACKGROUND） |
| `QUOTE_HELD_FOR_CONFIRMATION` | quote_fragment | PENDING_CONFIRMATION 到期不释放，自动挂起等待确认 |
| `PENDING_ESCALATED` / `CONFIRMATION_RESOLVED` | quote_fragment | 待确认材料升级给专家；专家 confirmed（须给新级别）或 rejected |
| `SCOPE_CHANGED` | quote_fragment | 会后改变可见范围 |
| `CORRECTION_SENT` / `CORRECTION_DELIVERY_ACKED` | correction_notice | 专家更正只追加、链向 `supersedes` 旧引用与版本，并按渠道跟踪送达 |

所有时间都必须携带时区，版本号从 1 开始按聚合严格递增，校验层不会替调用方改写输入。

## 关键业务规则（由命令服务守护）

- **引用级别**：`DIRECT`（可直接引用）、`BACKGROUND`（仅供背景理解，不得逐字引用）、`PENDING_CONFIRMATION`（等待确认，记者视图永不出现）。
- **采集幂等与冲突**：实时接入与批量速记可能重复或乱序。`external_id` 相同且规范内容哈希一致时复用原回执；哈希冲突先隔离，保留首版原文。
- **发布固定快照**：每次 `QUOTE_PUBLISHED` 把原文与当时已批准译文逐字固化进事件。两个编辑并发发布同一片段时，后到者基于过期的 `expected_release_version` 收到 `VERSION_CONFLICT`，始终只有一个当前版本；旧版本保留在发布历史中。
- **合法发布后不可改写**：片段一旦 `QUOTE_RELEASED`，译文不能再批、措辞不能覆盖，专家修正只能生成与旧引用相连的 `correction_notice`（记录旧文本、新版本号、送达渠道与逐渠道送达确认）。
- **禁发时点**：组织方可用场次时区的墙钟时间（如 `2026-10-07 20:00`）表达，落库为带偏移的绝对时刻。服务重启后重放事件并按原绝对时刻判定；DIRECT/BACKGROUND 到期释放，PENDING_CONFIRMATION 到期挂起。
- **范围变更**：未合法发布的内容改范围即时生效；已合法发布的内容不回溯改写，必须在 `published_channels` 中列出各已发布渠道与处理责任人。
- **权限边界**：记者凭授权令牌只能看到本场次、授权范围相交、且已合法释放的材料；待确认、被驳回、被隔离内容不出现。记者 API 明确给出 `quotable`、`source`（固定原文）、`approved_translations` 与 `attribution` 署名要求。
- **追溯链**：组织方凭独立管理令牌可从片段追到提问、提问记者资质、采集原文与回执、全部译稿与审批人、事实附件、发布历史、确认结论和更正送达状态。

交换层（`contracts/`）只负责稳定报告结构、枚举、时间、版本和必需载荷；幂等、冲突隔离、权限与并发裁决在上层业务服务（`src/service.js`）中完成。

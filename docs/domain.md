# 领域约定

描述新闻交流场次中的提问、回答、翻译、引用级别和更正关系，支持多语言引语追溯。

聚合对象包括`press_session`、`question_turn`、`quote_fragment`、`correction_notice`。事件类型包括`QUESTION_ACCEPTED`、`QUOTE_CAPTURED`、`TRANSLATION_APPROVED`、`QUOTE_RELEASED`、`CORRECTION_SENT`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 事件载荷

- `QUOTE_CAPTURED`：还需包含 `speaker_id`, `source_language`。
- `QUOTE_RELEASED`：还需包含 `quote_level`, `release_version`。
- `CORRECTION_SENT`：还需包含 `supersedes`, `recipient_scope`。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。

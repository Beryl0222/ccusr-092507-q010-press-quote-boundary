# 新闻茶座引语边界台

按场次规则管理中美关系新闻茶座的记者资质、提问、回答片段、说话人、原文/译文、引用级别、禁发时点、事实附件、专家确认与更正，并让每个对外片段固定它采用的原文和翻译。

## 能力

- **资质与授权**：场次（含指定时区）、记者资质登记，按场次发放/撤销带令牌的授权范围。
- **采集**：实时接入与批量速记的重复/乱序按 `external_id` + 规范内容哈希去重，内容一致复用原回执，冲突先隔离。
- **翻译与审批分离**：译稿提交后须由非译者批准；发布快照逐字固定原文与已批准译文。
- **引用级别**：DIRECT 可直接引用 / BACKGROUND 仅供背景 / PENDING_CONFIRMATION 等待确认（永不进记者视图）。
- **禁发**：以场次 IANA 时区墙钟表达，落库为绝对时刻；重启重放后按原时点释放 DIRECT/BACKGROUND，PENDING 到期挂起。
- **并发发布**：乐观版本控制，两个编辑并发发布只有一个当前版本，旧版本保留在历史里。
- **范围变更**：只影响尚未合法发布的内容；已发布渠道必须列出处理责任，不回溯改写。
- **更正链**：专家修正不覆盖旧措辞，生成链向旧引用的更正，按渠道跟踪送达与确认。
- **记者 HTTP API**：明确返回可引文字段、固定译文与署名要求；非公开讨论留在权限边界内。
- **追溯**：组织方可从一条引用追到提问、原话、翻译、确认及更正送达情况。

## 目录

- `contracts/domain.schema.json`：事件信封、对象类型、事件载荷与枚举约定。
- `data/sample.json`：可直接校验的中文联调样例。
- `src/contracts.js`：契约校验器。
- `src/store.js`：JSONL 追加式事件存储（进程内串行、聚合版本严格递增、重启重放）。
- `src/model.js`：事件投影（当前世界状态）。
- `src/time.js`：场次时区墙钟与绝对时刻转换。
- `src/service.js`：命令服务，守护全部业务规则。
- `src/views.js`：读模型（记者 Feed、单条引用、组织方追溯链、隔离区）。
- `src/server.js`：只读 HTTP API（node:http，无第三方依赖）。
- `scripts/demo.js`：端到端演示。
- `tests/`：契约、服务规则与 HTTP 集成测试。
- `docs/domain.md`：领域对象与事件语义。

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例校验

```bash
npm run check:sample
```

命令成功时输出 `valid`；校验失败时逐行输出字段、代码和中文说明，并以非零状态结束。

## 端到端演示

```bash
npm run demo
```

演示真实启动 HTTP 服务，串联：资质/授权 → 提问 → 实时+批量重复复用回执与冲突隔离 → 翻译自批被拒、换人批准 → 三种级别发布（含场次时区禁发）→ 记者视图看到固定原文/译文与署名 → 禁发到期自动释放 → 专家更正链与逐渠道送达 → 越权访问 401。

## HTTP API（只读）

启动：`EVENT_LOG=data/eventlog.jsonl ORGANIZER_TOKEN=... PORT=8080 npm run serve`

| 请求 | 令牌 | 说明 |
| --- | --- | --- |
| `GET /v1/me/quotes` | `X-Api-Token` | 记者可见条目：`quotable`、`source`（固定原文）、`approved_translations`、`attribution`/`attribution_required` |
| `GET /v1/me/quotes/:id` | `X-Api-Token` | 单条可引用内容；无权或不存在返回 404 |
| `GET /v1/organizer/quotes/:id/trace` | `X-Organizer-Token` | 追溯链：提问→采集原文/回执→译稿/审批→事实附件→发布历史→确认→更正送达 |
| `GET /v1/organizer/quarantines` | `X-Organizer-Token` | 冲突隔离区清单 |

写入路径（登记、采集、审批、发布、确认、范围变更、更正）通过 `src/service.js` 命令服务完成；HTTP 侧只暴露对记者和组织方的只读视图。

## 持久化与重启

事件以 JSONL 追加到 `EVENT_LOG`（默认 `data/eventlog.jsonl`）。服务启动即重放，因此禁发释放/挂起、授权撤销、更正送达等状态在重启后不依赖内存定时器，仍按落库的绝对时点执行。

# 新闻茶座引语边界台

描述新闻交流场次中的提问、回答、翻译、引用级别和更正关系，支持多语言引语追溯。

## 目录

- `contracts/domain.schema.json`：事件信封、对象类型和事件载荷约定。
- `data/sample.json`：可直接校验的中文联调样例。
- `src/contracts.js`、`src/cli.js`：契约校验与命令行入口。
- `src/time.js`：场次时区换算，把场次本地墙钟时间（如禁发时点）换算为瞬间。
- `src/platform.js`：引语边界台服务层——场次与记者资质、接入幂等与冲突隔离、翻译审批分离、确认与禁发调度、并发发布控制、更正与送达、范围变更与渠道责任、记者 API 与主办方追溯。
- `tests/`：契约边界、时区换算与服务层行为测试。
- `docs/domain.md`：领域对象、事件语义与服务层规则。

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

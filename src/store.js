import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";

function aggregateKey(event) {
  return `${event.aggregate_type}:${event.aggregate_id}`;
}

/**
 * JSONL 追加式事件存储。
 *
 * 不变式：
 * - event_id 全局唯一（重复提交由业务层决定复用回执还是拒绝，存储层拒绝二次写入）；
 * - 同一聚合内 version 从 1 开始严格递增；
 * - 全部事件按写入顺序落盘，服务重启后逐行重放即可恢复状态。
 *
 * filePath 传 null 时为纯内存存储（测试用）。
 */
export class EventStore {
  #filePath;
  #events = [];
  #indexById = new Map();
  #versionByAggregate = new Map();
  #loaded = false;

  constructor(filePath) {
    this.#filePath = filePath;
  }

  load() {
    if (this.#loaded) return;
    if (this.#filePath !== null && existsSync(this.#filePath)) {
      const lines = readFileSync(this.#filePath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.#ingest(JSON.parse(trimmed));
      }
    }
    this.#loaded = true;
  }

  #ingest(event) {
    if (this.#indexById.has(event.event_id)) {
      throw new Error(`事件标识重复: ${event.event_id}`);
    }
    const key = aggregateKey(event);
    const expected = (this.#versionByAggregate.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new Error(`聚合 ${key} 版本不连续: 期望 ${expected}, 实际 ${event.version}`);
    }
    this.#versionByAggregate.set(key, event.version);
    this.#indexById.set(event.event_id, event);
    this.#events.push(event);
  }

  append(event) {
    this.load();
    const key = aggregateKey(event);
    const expected = (this.#versionByAggregate.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      const error = new Error(
        `聚合 ${key} 并发冲突: 期望版本 ${expected}, 提交版本 ${event.version}`,
      );
      error.code = "VERSION_CONFLICT";
      throw error;
    }
    if (this.#filePath !== null) {
      mkdirSync(path.dirname(this.#filePath), { recursive: true });
      // 进程内串行写入；同一进程的并发发布在业务层加锁，
      // 此处只是把已经确定顺序的事件落盘。
      appendFileSync(this.#filePath, `${JSON.stringify(event)}\n`);
    }
    this.#ingest(event);
    return event;
  }

  all() {
    this.load();
    return this.#events;
  }

  nextVersion(aggregateType, aggregateId) {
    this.load();
    const key = `${aggregateType}:${aggregateId}`;
    return (this.#versionByAggregate.get(key) ?? 0) + 1;
  }
}

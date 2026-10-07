import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { EventStore } from "./store.js";
import { QuoteBoundaryService } from "./service.js";
import { reporterFeed, reporterQuote, organizerTrace, quarantineList } from "./views.js";

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/**
 * 只读 HTTP 层：
 * - 记者凭授权令牌访问 /v1/me/*，视图只返回有权获得的材料；
 * - 主办方凭独立管理令牌访问追溯链与隔离区；
 * - 禁发扫描在后台定时执行，启动时先扫一次，因此重启后仍按原时点释放或挂起。
 */
export function createAppServer(store, schema, options = {}) {
  const organizerToken = options.organizerToken ?? process.env.ORGANIZER_TOKEN ?? "";
  const scanIntervalMs = options.scanIntervalMs ?? 5000;
  const service = new QuoteBoundaryService(store, schema, options.clock);
  let timer = null;

  async function scanOnce() {
    await service.scanDueReleases();
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const state = () => service.snapshot();
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/me/quotes") {
        const token = request.headers["x-api-token"];
        const feed = reporterFeed(state(), token);
        const status = feed.status === "ok" ? 200 : 401;
        sendJson(response, status, feed);
        return;
      }

      const singleMatch = /^\/v1\/me\/quotes\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && singleMatch) {
        const token = request.headers["x-api-token"];
        const result = reporterQuote(state(), token, decodeURIComponent(singleMatch[1]));
        const status = result.status === "ok" ? 200 : result.status === "not_found" ? 404 : 401;
        sendJson(response, status, result);
        return;
      }

      const traceMatch = /^\/v1\/organizer\/quotes\/([^/]+)\/trace$/.exec(url.pathname);
      if (request.method === "GET" && traceMatch) {
        if (!organizerToken || request.headers["x-organizer-token"] !== organizerToken) {
          sendJson(response, 401, { status: "unauthorized" });
          return;
        }
        const trace = organizerTrace(state(), decodeURIComponent(traceMatch[1]));
        sendJson(response, trace ? 200 : 404, trace ?? { status: "not_found" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/organizer/quarantines") {
        if (!organizerToken || request.headers["x-organizer-token"] !== organizerToken) {
          sendJson(response, 401, { status: "unauthorized" });
          return;
        }
        sendJson(response, 200, { quarantines: quarantineList(state()) });
        return;
      }

      sendJson(response, 404, { status: "not_found" });
    } catch (error) {
      sendJson(response, 500, { status: "error", code: error.code ?? "internal", message: error.message });
    }
  });

  server.on("close", () => {
    if (timer) clearInterval(timer);
  });

  return {
    server,
    service,
    async start() {
      await scanOnce();
      timer = setInterval(() => {
        scanOnce().catch(() => {});
      }, scanIntervalMs);
      timer.unref?.();
    },
  };
}

async function main() {
  const store = new EventStore(process.env.EVENT_LOG ?? "data/eventlog.jsonl");
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const app = createAppServer(store, schema);
  const port = Number(process.env.PORT ?? 8080);
  await app.start();
  app.server.listen(port, () => {
    console.log(`引语边界台只读 API 监听 :${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// Обрывы связи с Hyperbeam: облачные браузеры не должны оставаться висеть и тратить минуты,
// а частые запуски во время ограничения Hyperbeam не должны его продлевать. Вместо Hyperbeam —
// поддельный сервер, который умеет «терять» ответы и пропадать из сети.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { api, closeRoom, createRoom, sleep, startServer, type TestServer } from "./helpers.ts";

type Mode = "ok" | "down" | "lose-create-reply" | "rate-limited";

class FakeHyperbeam {
  mode: Mode = "ok";
  sessions = new Map<string, { created: string; ended: string | null }>();
  creates = 0;
  private seq = 0;
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => this.handle(req.method ?? "GET", req.url ?? "/", res));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/v0`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  active(): string[] {
    return [...this.sessions].filter(([, s]) => !s.ended).map(([id]) => id);
  }

  private handle(method: string, url: string, res: import("node:http").ServerResponse): void {
    // Сеть пропала: соединение рвётся без ответа.
    if (this.mode === "down") return void res.socket?.destroy();
    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    };
    const path = url.replace(/^\/v0/, "").split("?")[0];

    if (method === "POST" && path === "/vm") {
      this.creates++;
      if (this.mode === "rate-limited") return json(429, { code: "err_too_many_vm_requests", message: "rate-limited" });
      const id = `vm-${++this.seq}`;
      this.sessions.set(id, { created: new Date().toISOString(), ended: null });
      // Запрос дошёл и облачный браузер запустился, а ответ потерялся по дороге.
      if (this.mode === "lose-create-reply") return void res.socket?.destroy();
      return json(200, { session_id: id, embed_url: `https://fake.example/${id}`, admin_token: "admin" });
    }
    if (method === "GET" && path === "/vm") {
      const results = this.active().map((id) => ({ id, creation_date: this.sessions.get(id)!.created }));
      return json(200, { results, next: results.at(-1)?.id ?? null });
    }
    const one = path.match(/^\/vm\/([\w-]+)$/);
    const session = one && this.sessions.get(one[1]);
    if (!one || !session) return json(404, { code: "err_not_found" });
    if (method === "GET") return json(200, { session_id: one[1], termination_date: session.ended });
    if (method === "DELETE") {
      if (session.ended) return json(400, { code: "err_terminated" });
      session.ended = new Date().toISOString();
      return json(200, {});
    }
    json(405, {});
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

describe("обрывы связи с Hyperbeam", () => {
  const hb = new FakeHyperbeam();
  let server: TestServer;
  const env = () => ({ HYPERBEAM_API_KEY: "fake-key", HYPERBEAM_API_URL: hb.url, JANITOR_MS: "300" });

  before(async () => {
    await hb.start();
    server = await startServer(env());
  });
  after(async () => {
    await server?.stop();
    await hb.stop();
  });

  it("ответ на запуск потерялся — облачный браузер находится и закрывается", async () => {
    hb.mode = "lose-create-reply";
    const failed = await createRoom(server);
    assert.equal(failed.status, 502);
    assert.equal(hb.active().length, 1, "Hyperbeam запустил браузер, хотя мы не получили ответ");
    hb.mode = "ok";
    assert.ok(await until(() => hb.active().length === 0), "повисший браузер так и не закрыт");

    // Следующая комната запускается и не закрывается уборкой по ошибке.
    const room = await createRoom(server);
    assert.equal(room.status, 200);
    await sleep(1000);
    assert.equal(hb.active().length, 1, "уборка закрыла сессию живой комнаты");
    await closeRoom(server);
    assert.equal(hb.active().length, 0);
  });

  it("сеть пропала при закрытии комнаты — сессия закрывается, когда сеть вернётся", async () => {
    const room = await createRoom(server);
    assert.equal(room.status, 200);
    hb.mode = "down";
    await closeRoom(server);
    const status = await api<{ room: unknown }>(server, "GET", "/api/status");
    assert.equal(status.body.room, null, "комната у нас закрыта сразу");
    assert.equal(hb.active().length, 1, "без сети Hyperbeam о закрытии не узнал");
    await sleep(1000);
    assert.equal(hb.active().length, 1);
    hb.mode = "ok";
    assert.ok(await until(() => hb.active().length === 0), "сессия так и не закрыта после возврата сети");
  });

  it("сервер перезапустили, пока сети не было, — незакрытая сессия закрывается после старта", async () => {
    const room = await createRoom(server);
    assert.equal(room.status, 200);
    hb.mode = "down";
    await closeRoom(server);
    const port = server.port;
    await server.stop();
    hb.mode = "ok";
    server = await startServer({ ...env(), PORT: String(port) });
    assert.ok(await until(() => hb.active().length === 0), "после перезапуска сессия осталась висеть");
  });

  it("Hyperbeam ограничил запуски — повторные нажатия минуту не доходят до него", async () => {
    hb.mode = "rate-limited";
    const before = hb.creates;
    const first = await createRoom(server);
    assert.equal(first.status, 502);
    assert.match(String(first.body.error), /временно ограничил/);
    const second = await createRoom(server);
    const third = await createRoom(server);
    assert.equal(second.status, 502);
    assert.match(String(third.body.error), /временно ограничил/);
    assert.equal(hb.creates - before, 1, "повторные нажатия продлевают ограничение Hyperbeam");
    hb.mode = "ok";
  });
});

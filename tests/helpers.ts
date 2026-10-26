// Обвязка для интеграционных тестов: настоящий сервер на свободном порту (демо-режим, без
// ключа Hyperbeam и без туннеля) и WebSocket-клиенты, которые говорят на протоколе приложения.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface TestServer {
  url: string;
  port: number;
  logs: string[];
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const logs: string[] = [];
  const proc: ChildProcess = spawn(process.execPath, [TSX, "server/index.ts"], {
    cwd: ROOT,
    // Пустые значения перекрывают .env разработчика: dotenv не трогает уже заданные переменные.
    env: {
      ...process.env,
      PORT: String(port),
      HYPERBEAM_API_KEY: "",
      PUBLIC_URL: "off",
      NODE_ENV: "test",
      ROOM_PASSWORD: "test-pass",
      EMPTY_ROOM_TIMEOUT: "600",
      OPEN_BROWSER: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => logs.push(String(d)));
  proc.stderr?.on("data", (d) => logs.push(String(d)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch {
      // ещё стартует
    }
    if (proc.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Сервер не поднялся:\n${logs.join("")}`);
    }
    await sleep(150);
  }

  return {
    url,
    port,
    logs,
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGINT");
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export async function api<T = Record<string, unknown>>(
  server: TestServer,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const res = await fetch(server.url + path, {
    method,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

export async function createRoom(server: TestServer, body: Record<string, unknown> = {}) {
  const res = await api<{ id: string; ownerToken: string; error?: string }>(server, "POST", "/api/room", {
    body: { hostName: "Lukas", startUrl: "https://example.com", ...body },
  });
  return res;
}

export async function closeRoom(server: TestServer): Promise<void> {
  await api(server, "DELETE", "/api/room", { body: { password: "test-pass" }, headers: { "x-forwarded-for": "10.0.0.250" } });
}

/** WebSocket-участник комнаты: копит входящие сообщения и умеет ждать нужное. */
export class Client {
  readonly messages: ServerMessage[] = [];
  private cursor = 0;
  private listeners = new Set<() => void>();
  selfId = "";
  selfUid = "";
  closeCode: number | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)) as ServerMessage);
      this.listeners.forEach((l) => l());
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      this.listeners.forEach((l) => l());
    });
  }

  static async connect(
    server: TestServer,
    options: { name?: string; owner?: string; key?: string; color?: string } = {},
  ): Promise<Client> {
    const params = new URLSearchParams();
    if (options.owner) params.set("owner", options.owner);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${params}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`WebSocket отклонён: ${res.statusCode}`)));
    });
    const client = new Client(ws);
    client.send({
      t: "hello",
      name: options.name ?? "Guest",
      color: options.color ?? "#7c8cff",
      micOn: false,
      key: options.key ?? `key-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    });
    const welcome = await client.next((m) => m.t === "welcome");
    if (welcome.t === "welcome") {
      client.selfId = welcome.selfId;
      client.selfUid = welcome.selfUid;
    }
    return client;
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Ждёт следующее подходящее сообщение (уже пришедшие тоже учитываются). */
  next<T extends ServerMessage = ServerMessage>(match: (m: ServerMessage) => boolean, timeout = 2000): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.messages.length; i++) {
          if (match(this.messages[i])) {
            this.cursor = i + 1;
            cleanup();
            resolve(this.messages[i] as T);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Не дождались сообщения. Пришло: ${JSON.stringify(this.messages.slice(this.cursor).map((m) => m.t))}`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      const listener = () => void check();
      if (!check()) this.listeners.add(listener);
    });
  }

  /** Проверяет, что подходящее сообщение НЕ пришло за отведённое время. */
  async none(match: (m: ServerMessage) => boolean, ms = 400): Promise<void> {
    const from = this.messages.length;
    await sleep(ms);
    const got = this.messages.slice(from).find(match);
    if (got) throw new Error(`Пришло лишнее сообщение: ${JSON.stringify(got)}`);
  }

  async closed(timeout = 2000): Promise<number> {
    const deadline = Date.now() + timeout;
    while (this.closeCode === null && Date.now() < deadline) await sleep(30);
    if (this.closeCode === null) throw new Error("Сокет не закрылся");
    return this.closeCode;
  }

  close(): void {
    this.ws.close();
  }
}

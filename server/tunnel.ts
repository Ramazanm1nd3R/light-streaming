import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.ts";

export type TunnelState = "starting" | "ready" | "off" | "error" | "missing";

let state: TunnelState = "off";
let publicUrl: string | null = null;
let child: ChildProcess | null = null;
let stopped = false;
let restarts = 0;
let restartTimer: NodeJS.Timeout | undefined;
const listeners = new Set<(url: string | null) => void>();

const MAX_RESTARTS = 6;

export function tunnelStatus(): { state: TunnelState; publicUrl: string | null; protected: boolean } {
  return { state, publicUrl, protected: config.tunnelAllowedEmails.length > 0 };
}

/** Вызывается при каждой смене публичного адреса (в том числе после перезапуска туннеля). */
export function onTunnelChange(listener: (url: string | null) => void): void {
  listeners.add(listener);
}

function setUrl(url: string | null): void {
  if (url === publicUrl) return;
  publicUrl = url;
  for (const listener of listeners) listener(url);
}

/**
 * Публичный HTTPS-адрес без домена и проброса портов — Cloudflare Quick Tunnel.
 * Адрес вида https://xxx.trycloudflare.com живёт, пока запущен сервер: это и есть
 * «комната существует, пока работает ноутбук». Видео Hyperbeam через туннель не идёт —
 * через него ходят только интерфейс, API и WebSocket (чат, голосовая сигнализация).
 */
export function startTunnel(localPort: number): void {
  const mode = config.publicUrl;
  if (mode === "off") return;
  if (/^https?:\/\//.test(mode)) {
    state = "ready";
    setUrl(mode.replace(/\/$/, ""));
    return;
  }
  stopped = false;
  spawnTunnel(localPort);
}

function spawnTunnel(localPort: number): void {
  state = "starting";
  let candidate: string | null = null;

  const args = ["tunnel", "--no-autoupdate", "--url", `http://localhost:${localPort}`];
  // Вход только по одноразовому коду на почту — Cloudflare показывает свою страницу проверки.
  if (config.tunnelAllowedEmails.length) args.push("--allowed-mail", config.tunnelAllowedEmails.join(","));

  const proc = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;

  const scan = (chunk: Buffer) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !candidate) candidate = match[0];
    // Адрес выдаётся сразу, но принимать запросы туннель начинает только после
    // регистрации соединения с edge Cloudflare — до этого ссылка отдаёт ошибку.
    if (candidate && /Registered tunnel connection/i.test(text) && state !== "ready") {
      state = "ready";
      restarts = 0;
      setUrl(candidate);
    }
    if (/failed to request quick Tunnel|429 Too Many Requests/i.test(text)) {
      console.warn("[tunnel] Cloudflare не выдал адрес:", text.trim().split("\n").pop());
    }
  };
  proc.stdout?.on("data", scan);
  proc.stderr?.on("data", scan);

  proc.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      state = "missing";
      console.warn("[tunnel] cloudflared не найден. Установи: brew install cloudflared — или задай PUBLIC_URL.");
    } else {
      state = "error";
      console.error("[tunnel]", err);
    }
    child = null;
  });

  proc.on("exit", (code) => {
    if (child === proc) child = null;
    if (stopped || state === "missing") return;
    setUrl(null);
    if (restarts >= MAX_RESTARTS) {
      state = "error";
      console.error(`[tunnel] cloudflared падает раз за разом (код ${code}) — туннель выключен`);
      return;
    }
    // Quick Tunnel иногда рвётся (сон ноутбука, смена сети) — поднимаем заново.
    // Адрес при этом поменяется: ведущему придёт новая ссылка.
    restarts += 1;
    state = "starting";
    const delay = Math.min(30_000, 2000 * 2 ** (restarts - 1));
    console.warn(`[tunnel] cloudflared завершился (код ${code}), перезапуск через ${delay / 1000} с`);
    restartTimer = setTimeout(() => spawnTunnel(localPort), delay);
  });
}

export function stopTunnel(): void {
  stopped = true;
  clearTimeout(restartTimer);
  child?.kill("SIGTERM");
  child = null;
}

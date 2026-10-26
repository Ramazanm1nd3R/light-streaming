import { execFile, spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.ts";

export type TunnelState = "starting" | "ready" | "off" | "error" | "missing";
export type TunnelProvider = "cloudflare" | "tailscale" | "custom" | "none";

let state: TunnelState = "off";
let provider: TunnelProvider = "none";
let publicUrl: string | null = null;
/** Что сделать, чтобы туннель заработал (ссылка на включение Funnel, команда входа и т.п.). */
let hint: string | null = null;
let child: ChildProcess | null = null;
let stopped = false;
let restarts = 0;
let restartTimer: NodeJS.Timeout | undefined;
const listeners = new Set<(url: string | null) => void>();

const MAX_RESTARTS = 6;

export function tunnelStatus() {
  return {
    state,
    provider,
    publicUrl,
    hint,
    protected: provider === "cloudflare" && config.tunnelAllowedEmails.length > 0,
  };
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

function setHint(text: string | null): void {
  if (text === hint) return;
  hint = text;
  if (text) console.warn(`\n  ⚠️  ${text}\n`);
}

/**
 * Публичный HTTPS-адрес без проброса портов. Через туннель ходят только интерфейс, API
 * и WebSocket; видео Hyperbeam идёт на устройства напрямую из облака.
 *
 *  PUBLIC_URL=auto       — Cloudflare Quick Tunnel: без аккаунта, но адрес новый при каждом запуске;
 *  PUBLIC_URL=tailscale  — Tailscale Funnel: постоянный адрес https://<машина>.<tailnet>.ts.net;
 *  PUBLIC_URL=https://…  — свой адрес (named tunnel и т.п.), сервер просто его показывает;
 *  PUBLIC_URL=off        — только локальная сеть.
 */
export function startTunnel(localPort: number): void {
  const mode = config.publicUrl;
  stopped = false;
  if (mode === "off") return;
  if (/^https?:\/\//.test(mode)) {
    provider = "custom";
    state = "ready";
    setUrl(mode.replace(/\/$/, ""));
    return;
  }
  if (mode === "tailscale") {
    provider = "tailscale";
    void startTailscale(localPort);
    return;
  }
  provider = "cloudflare";
  spawnTunnel(localPort, cloudflare(localPort));
}

// ---------------------------------------------------------------- общий запуск процесса туннеля

interface Runner {
  cmd: string;
  args: string[];
  /** Разбирает очередную порцию вывода; возвращает адрес, когда туннель готов принимать запросы. */
  scan(text: string): string | null;
  missingHint: string;
}

function spawnTunnel(localPort: number, runner: Runner): void {
  state = "starting";
  const proc = spawn(runner.cmd, runner.args, { stdio: ["ignore", "pipe", "pipe"] });
  child = proc;

  const onData = (chunk: Buffer) => {
    const url = runner.scan(chunk.toString());
    if (url && state !== "ready") {
      state = "ready";
      restarts = 0;
      setHint(null);
      setUrl(url);
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  proc.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      state = "missing";
      setHint(runner.missingHint);
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
      console.error(`[tunnel] ${runner.cmd} падает раз за разом (код ${code}) — туннель выключен`);
      return;
    }
    // Туннель иногда рвётся (сон ноутбука, смена сети) — поднимаем заново.
    restarts += 1;
    state = "starting";
    const delay = Math.min(30_000, 2000 * 2 ** (restarts - 1));
    console.warn(`[tunnel] ${runner.cmd} завершился (код ${code}), перезапуск через ${delay / 1000} с`);
    restartTimer = setTimeout(() => {
      if (provider === "tailscale") void startTailscale(localPort);
      else spawnTunnel(localPort, runner);
    }, delay);
  });
}

// ---------------------------------------------------------------- Cloudflare Quick Tunnel

function cloudflare(localPort: number): Runner {
  const args = ["tunnel", "--no-autoupdate", "--url", `http://localhost:${localPort}`];
  // Вход только по одноразовому коду на почту — Cloudflare показывает свою страницу проверки.
  if (config.tunnelAllowedEmails.length) args.push("--allowed-mail", config.tunnelAllowedEmails.join(","));
  let candidate: string | null = null;
  return {
    cmd: "cloudflared",
    args,
    missingHint: "cloudflared не найден. Установи: brew install cloudflared — или выбери PUBLIC_URL=tailscale.",
    scan(text) {
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !candidate) candidate = match[0];
      if (/failed to request quick Tunnel|429 Too Many Requests/i.test(text)) {
        console.warn("[tunnel] Cloudflare не выдал адрес:", text.trim().split("\n").pop());
      }
      // Адрес выдаётся сразу, но принимать запросы туннель начинает только после
      // регистрации соединения с edge Cloudflare — до этого ссылка отдаёт ошибку.
      return candidate && /Registered tunnel connection/i.test(text) ? candidate : null;
    },
  };
}

// ---------------------------------------------------------------- Tailscale Funnel

const run = (cmd: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === "ENOENT" ? -1 : Number((err as { code?: number }).code ?? 1)) : 0;
      resolve({ code, stdout, stderr });
    });
  });

/**
 * Tailscale Funnel: постоянный адрес машины в tailnet, гостям ничего ставить не нужно.
 * Сначала проверяем, что Tailscale запущен и выполнен вход, и узнаём имя машины;
 * затем держим `tailscale funnel <порт>` запущенным, пока работает сервер —
 * в этом режиме Funnel сам выключается, когда процесс завершается.
 */
async function startTailscale(localPort: number): Promise<void> {
  state = "starting";
  const status = await run("tailscale", ["status", "--json"]);
  if (stopped) return;

  if (status.code === -1) {
    state = "missing";
    setHint("Tailscale не установлен. Для Funnel на Mac нужен вариант из Homebrew: brew install tailscale && sudo brew services start tailscale && tailscale up");
    return;
  }
  let self: { BackendState?: string; Self?: { DNSName?: string } } = {};
  try {
    self = JSON.parse(status.stdout);
  } catch {
    // демон не запущен — status печатает ошибку вместо JSON
  }
  if (!self.BackendState) {
    state = "error";
    setHint("Служба Tailscale не запущена: sudo brew services start tailscale");
    return;
  }
  if (self.BackendState !== "Running") {
    state = "error";
    setHint("Tailscale не подключён: выполни tailscale up и войди в аккаунт");
    return;
  }
  const dnsName = self.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) {
    state = "error";
    setHint("У машины нет имени в tailnet — включи MagicDNS в админке Tailscale");
    return;
  }
  const expected = `https://${dnsName}`;

  spawnTunnel(localPort, {
    cmd: "tailscale",
    args: ["funnel", String(localPort)],
    missingHint: "Tailscale не установлен: brew install tailscale",
    scan(text) {
      // Первый запуск: Funnel надо один раз разрешить в аккаунте — CLI печатает ссылку и ждёт.
      const enable = text.match(/https:\/\/login\.tailscale\.com\/\S+/);
      if (enable) setHint(`Разреши Funnel для этой машины (один раз): ${enable[0]}`);
      if (/Available on the internet/i.test(text)) {
        return text.match(/https:\/\/[a-z0-9.-]+\.ts\.net/)?.[0] ?? expected;
      }
      return null;
    },
  });
}

export function stopTunnel(): void {
  stopped = true;
  clearTimeout(restartTimer);
  child?.kill("SIGTERM");
  child = null;
}

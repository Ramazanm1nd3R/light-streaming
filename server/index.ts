import express, { type Request } from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { config, demoMode } from "./config.ts";
import { attachRealtime, lobbyPeople } from "./realtime.ts";
import {
  RoomExistsError,
  checkPassword,
  cleanupOrphanSession,
  getRoom,
  isOwner,
  startRoom,
  stopRoom,
} from "./room.ts";
import { onTunnelChange, startTunnel, stopTunnel, tunnelStatus } from "./tunnel.ts";
import type { CreateRoomResponse, QualityMode, Region, RoomOptions, StatusResponse } from "../shared/protocol.ts";

// В dev фронтенд отдаёт Vite (5173), поэтому туннель и ссылки смотрят на него.
const WEB_PORT = config.production ? config.port : 5173;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

/** Адрес для друзей: публичный адрес туннеля, а без него — адрес ноутбука в Wi-Fi сети. */
function shareUrl(): string {
  return tunnelStatus().publicUrl ?? `http://${lanAddress() ?? "localhost"}:${WEB_PORT}`;
}

const ownerToken = (req: Request) => req.get("x-owner-token") ?? null;

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
  const room = getRoom();
  const owner = isOwner(ownerToken(req));
  const tunnel = tunnelStatus();
  let publicRoom: StatusResponse["room"] = null;
  if (room) {
    const { ownerToken: _o, sessionId: _s, adminToken, ...info } = room;
    publicRoom = owner ? { ...info, adminToken: adminToken ?? undefined } : info;
  }
  const body: StatusResponse = {
    isHost: owner,
    demo: demoMode,
    defaults: { region: config.region },
    room: publicRoom,
    people: room ? lobbyPeople() : [],
    shareUrl: shareUrl(),
    publicUrl: tunnel.publicUrl,
    tunnel: tunnel.state,
    tunnelProtected: tunnel.protected,
  };
  res.json(body);
});

function parseOptions(raw: Record<string, unknown>): RoomOptions {
  const quality: QualityMode[] = ["smooth", "sharp", "blocky"];
  const regions: Region[] = ["NA", "EU", "AS"];
  let startUrl = String(raw.startUrl ?? "").trim();
  if (startUrl && !/^[a-z]+:/i.test(startUrl)) startUrl = `https://${startUrl}`;
  return {
    startUrl: startUrl.slice(0, 2048) || "https://www.google.com",
    quality: quality.includes(raw.quality as QualityMode) ? (raw.quality as QualityMode) : "smooth",
    region: regions.includes(raw.region as Region) ? (raw.region as Region) : config.region,
    fps: raw.fps === 60 ? 60 : 30,
    guestControl: raw.guestControl !== false,
  };
}

function cleanName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 32) || "Ведущий";
}

// Создать комнату может любой, кто знает адрес, — но только если сейчас нет другой.
app.post("/api/room", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const room = await startRoom(parseOptions(body), cleanName(body.hostName));
    const response: CreateRoomResponse = { id: room.id, ownerToken: room.ownerToken };
    res.json(response);
  } catch (err) {
    if (err instanceof RoomExistsError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("[api] не удалось создать комнату:", err);
    const message = String(err).includes("401")
      ? "Hyperbeam отклонил ключ API — проверь HYPERBEAM_API_KEY"
      : "Не удалось запустить облачный браузер. Подробности в консоли сервера.";
    res.status(502).json({ error: message });
  }
});

// Защита пароля от перебора: не больше 5 неверных попыток за 5 минут с одного адреса.
const failures = new Map<string, number[]>();
const clientIp = (req: Request) => req.get("cf-connecting-ip") ?? req.socket.remoteAddress ?? "?";

app.delete("/api/room", async (req, res) => {
  if (!getRoom()) {
    res.json({ ok: true });
    return;
  }
  if (!isOwner(ownerToken(req))) {
    const ip = clientIp(req);
    const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 5 * 60_000);
    if (recent.length >= 5) {
      res.status(429).json({ error: "Слишком много попыток — подожди пару минут" });
      return;
    }
    if (!checkPassword((req.body as { password?: string } | undefined)?.password)) {
      failures.set(ip, [...recent, Date.now()]);
      res.status(403).json({ error: "Неверный пароль" });
      return;
    }
    failures.delete(ip);
    await stopRoom("Комнату закрыли паролем");
  } else {
    await stopRoom("Ведущий завершил просмотр");
  }
  res.json({ ok: true });
});

// В production сервер сам раздаёт собранный фронтенд.
const dist = fileURLToPath(new URL("../dist", import.meta.url));
if (config.production && existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws$).*/, (_req, res) => res.sendFile(`${dist}/index.html`, { maxAge: 0 }));
}

// ---------------------------------------------------------------- терминал

let lastPrinted = "";

/** Адрес и QR-код прямо в терминале: навёл камеру телефона — и ты на странице. */
async function printShare(): Promise<void> {
  const url = shareUrl();
  if (url === lastPrinted) return;
  lastPrinted = url;
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  const { state, protected: guarded } = tunnelStatus();
  const scope =
    state === "ready"
      ? guarded
        ? "из любой сети, вход по коду из письма"
        : "из любой сети"
      : "только в этой Wi-Fi сети";
  console.log(`\n  🔗 Ссылка для своих (${scope}):\n  ${url}\n\n${qr}`);
  console.log(`  🔑 Пароль, чтобы закрыть повисшую комнату: ${config.roomPassword}\n`);
}

onTunnelChange((url) => {
  if (url) void printShare();
  else console.warn("\n  ⚠️  Туннель переподключается — старая ссылка перестанет работать, новая появится здесь.");
});

function openInBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

/** npm run watch: дождаться публичного адреса, создать комнату и открыть её как ведущий. */
async function autoStart(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (tunnelStatus().state === "starting" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await printShare();
  try {
    const room = await startRoom(
      { startUrl: config.startUrl, quality: "smooth", region: config.region, fps: 30, guestControl: true },
      "Ведущий",
    );
    // Токен владельца передаётся в ссылке один раз — браузер запомнит его и уберёт из адреса.
    if (config.autoOpen) openInBrowser(`http://localhost:${WEB_PORT}/?owner=${room.ownerToken}`);
  } catch (err) {
    console.error("[watch] не удалось создать комнату:", err);
  }
}

// ---------------------------------------------------------------- запуск

const server = createServer(app);
attachRealtime(server);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  ✖ Порт ${config.port} уже занят — скорее всего, Light Streaming уже запущен.\n` +
        `    Открой http://localhost:${WEB_PORT} или запусти второй экземпляр с другим PORT.\n`,
    );
  } else {
    console.error("[server]", err);
  }
  process.exit(1);
});

// Сначала занимаем порт, и только потом трогаем облачные сессии: если порт занят,
// значит, уже работает другой сервер, и его комнату закрывать нельзя.
server.listen(config.port, async () => {
  await cleanupOrphanSession();
  const lan = lanAddress();
  console.log(`
  ✦ Light Streaming${demoMode ? "  (демо-режим: HYPERBEAM_API_KEY не задан)" : ""}

  На этом ноутбуке: http://localhost:${WEB_PORT}
  В Wi-Fi сети:     ${lan ? `http://${lan}:${WEB_PORT}` : "—"}
`);
  startTunnel(WEB_PORT);
  if (config.autoRoom) void autoStart();
  // Туннеля нет (не установлен cloudflared, PUBLIC_URL=off) или он так и не поднялся —
  // печатаем адрес в Wi-Fi сети. Публичный адрес, если появится, напечатается сам.
  setTimeout(() => tunnelStatus().state !== "starting" && void printShare(), 1500);
  setTimeout(() => void printShare(), 30_000);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal}: закрываю комнату, облачную сессию и туннель…`);
  stopTunnel();
  await stopRoom("Ноутбук ведущего выключил сервис");
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

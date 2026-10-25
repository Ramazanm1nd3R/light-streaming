import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { config, demoMode } from "./config.ts";
import { createSession, endSession, isSessionAlive } from "./hyperbeam.ts";
import type { RoomInfo, RoomOptions } from "../shared/protocol.ts";

// Последняя созданная сессия пишется на диск. Если ноутбук выключили, не закрыв
// комнату, то при следующем старте сервер найдёт «осиротевшую» облачную сессию и
// завершит её, чтобы она не тратила минуты.
// Файл привязан к порту, чтобы второй экземпляр сервера (например, тестовый) не закрыл чужую сессию.
const SESSION_FILE = new URL(`../.session-${config.port}.json`, import.meta.url);

export interface Room extends RoomInfo {
  /** Секрет создателя комнаты: даёт права ведущего (закрыть без пароля, раздавать управление). */
  ownerToken: string;
  sessionId: string | null;
  adminToken: string | null;
}

export class RoomExistsError extends Error {
  constructor() {
    super("Комната уже открыта — можно войти в неё");
  }
}

let current: Room | null = null;
let pending: Promise<Room> | null = null;
let emptyTimer: NodeJS.Timeout | undefined;
let monitorTimer: NodeJS.Timeout | undefined;
const endListeners = new Set<(reason: string) => void>();

export function getRoom(): Room | null {
  return current;
}

export function onRoomEnded(listener: (reason: string) => void): void {
  endListeners.add(listener);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isOwner(token: string | null | undefined): boolean {
  return Boolean(current && token && safeEqual(token, current.ownerToken));
}

export function checkPassword(password: string | null | undefined): boolean {
  return Boolean(password) && safeEqual(String(password), config.roomPassword);
}

/** Одновременно открыта только одна комната. */
export async function startRoom(options: RoomOptions, hostName: string): Promise<Room> {
  if (current || pending) throw new RoomExistsError();

  pending = (async () => {
    const base = {
      id: randomBytes(4).toString("hex"),
      title: "Совместный просмотр",
      createdAt: Date.now(),
      ownerToken: randomBytes(18).toString("base64url"),
      hostName,
      options,
    };

    if (demoMode) {
      return { ...base, embedUrl: "", demo: true, stream: null, sessionId: null, adminToken: null };
    }

    const session = await createSession(options);
    // PID владельца: другой экземпляр сервера никогда не закроет сессию живого процесса.
    await writeFile(SESSION_FILE, JSON.stringify({ sessionId: session.session_id, pid: process.pid }), "utf8");
    return {
      ...base,
      embedUrl: session.embed_url,
      demo: false,
      stream: session.stream,
      sessionId: session.session_id,
      adminToken: session.admin_token,
    };
  })();

  try {
    current = await pending;
  } finally {
    pending = null;
  }
  // Создатель может так и не войти (закрыл вкладку) — пустая комната закроется сама.
  setOccupancy(0);
  startMonitor();
  return current;
}

function finish(reason: string): Room | null {
  const room = current;
  if (!room) return null;
  current = null;
  clearTimeout(emptyTimer);
  clearInterval(monitorTimer);
  for (const listener of endListeners) listener(reason);
  return room;
}

export async function stopRoom(reason = "Ведущий завершил просмотр"): Promise<void> {
  const room = finish(reason);
  if (!room) return;
  if (room.sessionId) {
    await endSession(room.sessionId).catch((err) => console.error("[room] не удалось закрыть сессию:", err));
  }
  await rm(SESSION_FILE, { force: true });
}

/**
 * Сколько человек сейчас в комнате. Если никого нет дольше EMPTY_ROOM_TIMEOUT —
 * комната закрывается сама: так не остаётся «повисших» комнат после вылета.
 */
export function setOccupancy(count: number): void {
  clearTimeout(emptyTimer);
  if (!current || count > 0) return;
  emptyTimer = setTimeout(() => {
    const minutes = Math.round(config.emptyRoomTimeout / 60);
    console.log(`[room] в комнате никого нет ${minutes} мин — закрываю`);
    void stopRoom(`Комната закрылась сама: в ней никого не было ${minutes} мин`);
  }, config.emptyRoomTimeout * 1000);
}

/** Hyperbeam может завершить сессию сам (таймауты) — тогда закрываем и комнату. */
function startMonitor(): void {
  clearInterval(monitorTimer);
  if (demoMode) return;
  monitorTimer = setInterval(async () => {
    const room = current;
    if (!room?.sessionId) return;
    const alive = await isSessionAlive(room.sessionId).catch(() => true);
    if (!alive && current === room) {
      console.log("[room] Hyperbeam завершил облачную сессию — закрываю комнату");
      finish("Облачная сессия завершилась");
      void rm(SESSION_FILE, { force: true });
    }
  }, 30_000);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Вызывать только после того, как сервер занял порт, — иначе можно закрыть комнату работающего сервера. */
export async function cleanupOrphanSession(): Promise<void> {
  if (demoMode) return;
  try {
    const { sessionId, pid } = JSON.parse(await readFile(SESSION_FILE, "utf8")) as { sessionId?: string; pid?: number };
    if (pid && pid !== process.pid && isAlive(pid)) {
      console.warn(`[room] сессия ${sessionId} принадлежит работающему процессу ${pid} — не трогаю`);
      return;
    }
    if (sessionId) {
      console.log(`[room] закрываю сессию, оставшуюся с прошлого запуска: ${sessionId}`);
      await endSession(sessionId);
    }
  } catch {
    // Файла нет — значит, прошлый запуск завершился корректно.
  }
  await rm(SESSION_FILE, { force: true });
}

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  if (config.turn.urls.length) {
    servers.push({ urls: config.turn.urls, username: config.turn.username, credential: config.turn.credential });
  }
  return servers;
}

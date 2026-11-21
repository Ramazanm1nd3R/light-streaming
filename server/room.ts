import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { config, demoMode } from "./config.ts";
import { createSession, endSession, isSessionAlive, listSessions, outcomeUnknown } from "./hyperbeam.ts";
import type { RoomInfo, RoomOptions } from "../shared/protocol.ts";

// Текущая сессия и всё, что ещё надо закрыть, пишется на диск. Если ноутбук выключили, не закрыв
// комнату, то при следующем старте сервер найдёт «осиротевшую» облачную сессию и
// завершит её, чтобы она не тратила минуты.
// Файл привязан к порту, чтобы второй экземпляр сервера (например, тестовый) не закрыл чужую сессию.
const SESSION_FILE = new URL(`../.session-${config.port}.json`, import.meta.url);
// Как часто повторять уборку, пока сеть или Hyperbeam недоступны.
const JANITOR_MS = Number(process.env.JANITOR_MS) || 30_000;
// Запас на расхождение часов ноутбука и Hyperbeam, когда ищем сессию по времени создания.
const CLOCK_SLACK_MS = 60_000;

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

// Без связи облачные браузеры остаются висеть и тратить минуты: закрыть сессию не удалось, или
// запрос на создание дошёл до Hyperbeam, а ответ с номером сессии — нет. Такие сессии запоминаем
// и добиваем, когда сеть вернётся.
/** Сессии, которые надо закрыть. */
const toEnd = new Set<string>();
/** Промежутки времени, когда запуск мог создать сессию, о которой мы не знаем. */
let blindSpots: { from: number; to: number }[] = [];
let janitorTimer: NodeJS.Timeout | undefined;
let janitorRunning = false;

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

    const startedAt = Date.now();
    let session: Awaited<ReturnType<typeof createSession>>;
    try {
      session = await createSession(options);
    } catch (err) {
      if (outcomeUnknown(err)) {
        console.warn("[room] запуск без ответа — проверю позже, не остался ли облачный браузер");
        blindSpots.push({ from: startedAt, to: Date.now() });
        await saveState();
        scheduleJanitor(0);
      }
      throw err;
    }
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
  await saveState();
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
    await endSession(room.sessionId).catch((err) => {
      console.error("[room] не удалось закрыть сессию, повторю позже:", String(err));
      toEnd.add(room.sessionId!);
      scheduleJanitor();
    });
  }
  await saveState();
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
      void saveState();
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

interface SavedState {
  pid?: number;
  sessionId?: string | null;
  toEnd?: string[];
  blindSpots?: { from: number; to: number }[];
}

/** Записать на диск, что надо закрыть, если сервер упадёт. Нечего закрывать — файла нет. */
async function saveState(): Promise<void> {
  if (demoMode) return;
  const state: SavedState = {
    // PID владельца: другой экземпляр сервера никогда не закроет сессию живого процесса.
    pid: process.pid,
    sessionId: current?.sessionId ?? null,
    toEnd: [...toEnd],
    blindSpots,
  };
  try {
    if (!state.sessionId && !toEnd.size && !blindSpots.length) await rm(SESSION_FILE, { force: true });
    else await writeFile(SESSION_FILE, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("[room] не удалось сохранить состояние сессий:", String(err));
  }
}

function scheduleJanitor(delay = JANITOR_MS): void {
  if (demoMode || janitorTimer) return;
  janitorTimer = setTimeout(() => {
    janitorTimer = undefined;
    void tidy();
  }, delay);
  janitorTimer.unref?.();
}

/**
 * Закрыть то, что не удалось закрыть раньше, и найти сессии от запусков без ответа: активные
 * сессии этого ключа, созданные в те моменты, и не принадлежащие текущей комнате. Пока сеть
 * или Hyperbeam недоступны, повторяем каждые JANITOR_MS.
 */
async function tidy(): Promise<void> {
  if (janitorRunning) return;
  janitorRunning = true;
  try {
    // Пока идёт запуск, его сессия уже может быть в списке — подождём, чтобы не закрыть её.
    if (blindSpots.length && !pending) {
      try {
        const spots = blindSpots;
        for (const s of await listSessions()) {
          const at = Date.parse(s.creation_date);
          const suspicious = spots.some((w) => at >= w.from - CLOCK_SLACK_MS && at <= w.to + CLOCK_SLACK_MS);
          if (suspicious && s.id !== current?.sessionId) toEnd.add(s.id);
        }
        blindSpots = blindSpots.filter((w) => !spots.includes(w));
      } catch {
        // список не получили — попробуем в следующий раз
      }
    }
    for (const id of [...toEnd]) {
      if (id === current?.sessionId) {
        toEnd.delete(id);
        continue;
      }
      try {
        await endSession(id);
        toEnd.delete(id);
        console.log(`[room] закрыл повисшую облачную сессию ${id}`);
      } catch {
        // сеть ещё не вернулась — попробуем в следующий раз
      }
    }
    await saveState();
  } finally {
    janitorRunning = false;
  }
  if (toEnd.size || blindSpots.length) scheduleJanitor();
}

/** Вызывать только после того, как сервер занял порт, — иначе можно закрыть комнату работающего сервера. */
export async function cleanupOrphanSession(): Promise<void> {
  if (demoMode) return;
  let saved: SavedState = {};
  try {
    saved = JSON.parse(await readFile(SESSION_FILE, "utf8")) as SavedState;
  } catch {
    // Файла нет — значит, прошлый запуск завершился корректно.
    return;
  }
  if (saved.pid && saved.pid !== process.pid && isAlive(saved.pid)) {
    console.warn(`[room] сессия ${saved.sessionId} принадлежит работающему процессу ${saved.pid} — не трогаю`);
    return;
  }
  if (saved.sessionId) {
    console.log(`[room] закрываю сессию, оставшуюся с прошлого запуска: ${saved.sessionId}`);
    toEnd.add(saved.sessionId);
  }
  for (const id of saved.toEnd ?? []) toEnd.add(id);
  blindSpots.push(...(saved.blindSpots ?? []));
  await tidy();
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

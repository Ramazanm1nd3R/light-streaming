import { config } from "./config.ts";
import type { RoomOptions } from "../shared/protocol.ts";

const API = "https://engine.hyperbeam.com/v0";

export interface HyperbeamSession {
  session_id: string;
  embed_url: string;
  admin_token: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.hyperbeamKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hyperbeam ${method} ${path} → ${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}

// Профиль, доступный любому ключу. Если ключ однажды отказал в большем, дальше просим сразу его:
// лишний запрос замедляет создание комнаты и расходует лимит Hyperbeam на создание сессий.
const BASIC_PROFILE: StreamProfile = { width: 1280, height: 720, fps: 30 };
let keyRestricted = false;

export async function createSession(options: RoomOptions): Promise<HyperbeamSession & { stream: StreamProfile }> {
  if (keyRestricted) return { ...(await requestSession(options, BASIC_PROFILE)), stream: BASIC_PROFILE };
  const wanted: StreamProfile = { width: 1920, height: 1080, fps: options.fps };
  try {
    return { ...(await requestSession(options, wanted)), stream: wanted };
  } catch (err) {
    // Тестовые и базовые ключи Hyperbeam не дают 1080p и 60 fps (err_api_restricted).
    // Тогда откатываемся к профилю, доступному всем: 1280×720, 30 кадров.
    if (!String(err).includes("err_api_restricted")) throw err;
    keyRestricted = true;
    console.warn("[hyperbeam] ключ не позволяет 1080p/60fps — дальше комнаты запускаются в 720p/30fps");
    return { ...(await requestSession(options, BASIC_PROFILE)), stream: BASIC_PROFILE };
  }
}

export interface StreamProfile {
  width: number;
  height: number;
  fps: number;
}

/**
 * Роли того, кто управляет облачным браузером: ввод мышью и клавиатурой (control) и API вкладок
 * (chrome_apis) — переход по адресу, назад, вперёд, обновить. Выдаются и отбираются только вместе:
 * без chrome_apis у зрителя не работают кнопки браузера, а с ним одним он мог бы листать сайт за всех.
 */
export const CONTROL_ROLES = ["control", "chrome_apis"];

function requestSession(options: RoomOptions, profile: StreamProfile): Promise<HyperbeamSession> {

  return request<HyperbeamSession>("POST", "/vm", {
    start_url: options.startUrl || "about:blank",
    // Своя панель управления вместо браузерной: адресную строку и вкладки рисуем сами.
    kiosk: true,
    region: options.region,
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    quality: { mode: options.quality },
    adblock: true,
    dark: true,
    search_engine: "google",
    locale: { language: "ru-RU,ru,en-US,en" },
    touch_gestures: { swipe: false, pinch: false },
    // Права раздаёт ведущий; у него admin_token, так что сам он всегда может вернуть себе управление.
    // Зрителю без управления не достаётся ни одной роли — только смотреть.
    default_roles: options.guestControl ? CONTROL_ROLES : [],
    timeout: {
      offline: config.offlineTimeout,
      absolute: config.absoluteTimeout,
      warning: 120,
    },
  });
}

/** false, если Hyperbeam уже завершил сессию (termination_date выставлен или сессии нет). */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  try {
    const session = await request<{ termination_date: string | null }>("GET", `/vm/${sessionId}`);
    return !session.termination_date;
  } catch (err) {
    if (String(err).includes("404")) return false;
    throw err;
  }
}

export async function endSession(sessionId: string): Promise<void> {
  try {
    await request("DELETE", `/vm/${sessionId}`);
  } catch (err) {
    // 404 означает, что сессия уже завершилась по таймауту — это нормально.
    if (!String(err).includes("404")) throw err;
  }
}

/** Права пользователя внутри сессии — через session endpoint с admin_token. */
export async function setControl(
  embedUrl: string,
  adminToken: string,
  hbUserId: string,
  allowed: boolean,
): Promise<void> {
  const baseUrl = embedUrl.split("?")[0];
  const res = await fetch(`${baseUrl}/${allowed ? "addRoles" : "removeRoles"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    // Параметры передаются массивом — так же, как аргументы hb.addRoles(userIds, roles).
    body: JSON.stringify([[hbUserId], CONTROL_ROLES]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperbeam roles → ${res.status} ${await res.text().catch(() => "")}`);
}

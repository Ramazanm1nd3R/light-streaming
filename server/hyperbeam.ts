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

export async function createSession(options: RoomOptions): Promise<HyperbeamSession & { stream: StreamProfile }> {
  const wanted: StreamProfile = { width: 1920, height: 1080, fps: options.fps };
  try {
    return { ...(await requestSession(options, wanted)), stream: wanted };
  } catch (err) {
    // Тестовые и базовые ключи Hyperbeam не дают 1080p и 60 fps (err_api_restricted).
    // Тогда откатываемся к профилю, доступному всем: 1280×720, 30 кадров.
    if (!String(err).includes("err_api_restricted")) throw err;
    const fallback: StreamProfile = { width: 1280, height: 720, fps: 30 };
    console.warn("[hyperbeam] ключ не позволяет 1080p/60fps — запускаю 720p/30fps");
    return { ...(await requestSession(options, fallback)), stream: fallback };
  }
}

export interface StreamProfile {
  width: number;
  height: number;
  fps: number;
}

function requestSession(options: RoomOptions, profile: StreamProfile): Promise<HyperbeamSession> {
  const defaultRoles = ["chrome_apis", "resize"];
  if (options.guestControl) defaultRoles.push("control");

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
    default_roles: defaultRoles,
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
    body: JSON.stringify([[hbUserId], ["control"]]),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hyperbeam roles → ${res.status} ${await res.text().catch(() => "")}`);
}

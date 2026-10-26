import "dotenv/config";
import type { Region } from "../shared/protocol.ts";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

function region(raw: string | undefined): Region {
  return raw === "NA" || raw === "AS" || raw === "EU" ? raw : "EU";
}

export const config = {
  port: num("PORT", 8787),
  production: process.env.NODE_ENV === "production",
  hyperbeamKey: process.env.HYPERBEAM_API_KEY?.trim() || "",
  publicUrl: (process.env.PUBLIC_URL ?? "auto").trim(),
  tunnelAllowedEmails: (process.env.TUNNEL_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // npm run watch: после старта открыть общую страницу в браузере.
  openBrowser: process.env.OPEN_BROWSER === "1",
  // Пароль, которым любой участник может закрыть комнату (например, если ведущий вылетел).
  roomPassword: process.env.ROOM_PASSWORD?.trim() || "12345",
  // Пустая комната закрывается сама через столько секунд.
  emptyRoomTimeout: num("EMPTY_ROOM_TIMEOUT", 600),
  region: region(process.env.HYPERBEAM_REGION),
  offlineTimeout: num("HB_OFFLINE_TIMEOUT", 600),
  absoluteTimeout: num("HB_ABSOLUTE_TIMEOUT", 6 * 3600),
  turn: {
    urls: (process.env.TURN_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    username: process.env.TURN_USERNAME ?? "",
    credential: process.env.TURN_CREDENTIAL ?? "",
  },
};

export const demoMode = !config.hyperbeamKey;

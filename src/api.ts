import type { CreateRoomRequest, CreateRoomResponse, StatusResponse } from "../shared/protocol.ts";
import { load, save } from "./lib/storage.ts";

/**
 * Токен владельца комнаты. Его получает браузер, создавший комнату, — с ним можно
 * вернуться ведущим после вылета. `npm run watch` передаёт его один раз через ?owner=.
 */
function initOwnerToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("owner");
  if (fromUrl) {
    save("ownerToken", fromUrl);
    history.replaceState(null, "", "/");
    return fromUrl;
  }
  // Старые ссылки вида /r/<токен> больше не нужны — адрес у всех общий.
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  return load<string | null>("ownerToken", null);
}

let ownerToken = initOwnerToken();

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ownerToken) h["x-owner-token"] = ownerToken;
  return h;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data as T;
}

export function fetchStatus(): Promise<StatusResponse> {
  return call<StatusResponse>("GET", "/api/status");
}

export async function createRoom(request: CreateRoomRequest): Promise<CreateRoomResponse> {
  const created = await call<CreateRoomResponse>("POST", "/api/room", request);
  ownerToken = created.ownerToken;
  save("ownerToken", ownerToken);
  return created;
}

/** Ведущему пароль не нужен; остальные закрывают комнату паролем. */
export function closeRoom(password?: string): Promise<{ ok: boolean }> {
  return call("DELETE", "/api/room", password ? { password } : undefined);
}

export function wsUrl(): string {
  const params = new URLSearchParams();
  if (ownerToken) params.set("owner", ownerToken);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?${params}`;
}

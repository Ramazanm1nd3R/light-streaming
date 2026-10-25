// Общие типы клиента и сервера: REST-ответы и сообщения WebSocket.

export type QualityMode = "smooth" | "sharp" | "blocky";
export type Region = "NA" | "EU" | "AS";

export interface RoomOptions {
  startUrl: string;
  quality: QualityMode;
  region: Region;
  fps: 30 | 60;
  /** Гости могут управлять браузером сразу после входа. */
  guestControl: boolean;
}

/**
 * Комната одна на весь сервис, и адрес у всех общий: кто знает ссылку, тот и свой.
 * Ведущий — тот, кто создал комнату (его браузер хранит токен владельца).
 */
export interface RoomInfo {
  id: string;
  title: string;
  createdAt: number;
  embedUrl: string;
  demo: boolean;
  options: RoomOptions;
  /** Фактические параметры потока: ключ API может не позволить 1080p/60fps. */
  stream: { width: number; height: number; fps: number } | null;
  hostName: string;
}

/** Кто сейчас в комнате — показывается на общей странице до входа. */
export interface LobbyPerson {
  name: string;
  color: string;
  isHost: boolean;
}

export interface StatusResponse {
  /** Этот браузер создал текущую комнату. */
  isHost: boolean;
  demo: boolean;
  defaults: { region: Region };
  /** admin_token Hyperbeam получает только ведущий. */
  room: (RoomInfo & { adminToken?: string }) | null;
  people: LobbyPerson[];
  /** Адрес, который можно отправить: публичный адрес туннеля или адрес ноутбука в Wi-Fi. */
  shareUrl: string;
  publicUrl: string | null;
  tunnel: "starting" | "ready" | "off" | "error" | "missing";
  /** Туннель пускает только указанные email (одноразовый код от Cloudflare). */
  tunnelProtected: boolean;
}

export interface CreateRoomRequest extends RoomOptions {
  hostName: string;
}

export interface CreateRoomResponse {
  id: string;
  ownerToken: string;
}

export interface Participant {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  micOn: boolean;
  /** userId внутри Hyperbeam — нужен ведущему, чтобы выдавать права на управление. */
  hbUserId?: string;
  canControl: boolean;
  joinedAt: number;
  /**
   * Постоянный публичный id браузера (хеш секретного ключа из localStorage).
   * В отличие от id соединения, не меняется при переподключении — по нему узнаём
   * свои сообщения и реакции, а сервер проверяет право редактировать.
   */
  uid: string;
}

export interface ReplyRef {
  id: string;
  name: string;
  text: string;
}

export interface ReactionEntry {
  uid: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  authorUid: string;
  name: string;
  color: string;
  text: string;
  at: number;
  editedAt?: number;
  replyTo?: ReplyRef;
  /** emoji → кто поставил. У каждого не больше одной реакции на сообщение, как в Telegram. */
  reactions: Record<string, ReactionEntry[]>;
}

export interface IceConfig {
  iceServers: RTCIceServer[];
}

// ---------- клиент → сервер ----------
export type ClientMessage =
  | { t: "hello"; name: string; color: string; micOn: boolean; key: string }
  | { t: "chat"; text: string; replyTo?: string }
  | { t: "edit"; id: string; text: string }
  | { t: "react"; id: string; emoji: string }
  | { t: "reaction"; emoji: string }
  | { t: "mic"; on: boolean }
  | { t: "hb-user"; hbUserId: string }
  | { t: "set-control"; participantId: string; canControl: boolean }
  | { t: "signal"; to: string; data: SignalData }
  | { t: "ping"; at: number };

// ---------- сервер → клиент ----------
export type ServerMessage =
  | { t: "welcome"; selfId: string; selfUid: string; participants: Participant[]; history: ChatMessage[]; ice: IceConfig }
  | { t: "joined"; participant: Participant }
  | { t: "left"; id: string }
  | { t: "updated"; participant: Participant }
  | { t: "chat"; message: ChatMessage }
  | { t: "chat-update"; message: ChatMessage }
  | { t: "reaction"; from: string; emoji: string }
  | { t: "signal"; from: string; data: SignalData }
  | { t: "room-ended"; reason: string }
  | { t: "pong"; at: number }
  | { t: "error"; message: string };

export type SignalData =
  | { kind: "description"; description: RTCSessionDescriptionInit }
  | { kind: "candidate"; candidate: RTCIceCandidateInit | null };

export const REACTIONS = ["❤️", "😂", "😮", "😭", "🔥", "👏", "😡", "👀"] as const;

/** Реакции на сообщения в чате. */
export const MESSAGE_REACTIONS = ["👍", "❤️", "😂", "😮", "😭", "🔥", "👏", "👀"] as const;

import type { IncomingMessage, Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { setControl } from "./hyperbeam.ts";
import { getRoom, iceServers, isOwner, onRoomEnded, setOccupancy } from "./room.ts";
import { isMessageReaction, type ChatMessage, type ClientMessage, type Participant, type ServerMessage } from "../shared/protocol.ts";

const HISTORY_LIMIT = 200;
const MAX_TEXT = 1000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

interface Client {
  socket: WebSocket;
  isHost: boolean;
  alive: boolean;
  participant: Participant | null;
  lastReactionAt: number;
  lastChatActionAt: number;
}

const clients = new Map<string, Client>();
let history: ChatMessage[] = [];
/** Решение ведущего о правах гостя — по постоянному uid, чтобы оно пережило переподключение. */
let controlByUid = new Map<string, boolean>();

function send(client: Client, message: ServerMessage): void {
  if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage, exceptId?: string): void {
  for (const [id, client] of clients) {
    if (id !== exceptId && client.participant) send(client, message);
  }
}

/** Кто в комнате — для общей страницы до входа. */
export function lobbyPeople(): { name: string; color: string; isHost: boolean }[] {
  return participants().map(({ name, color, isHost }) => ({ name, color, isHost }));
}

function participants(): Participant[] {
  return [...clients.values()].flatMap((c) => (c.participant ? [c.participant] : []));
}

/**
 * Публичный id из секретного ключа браузера. Ключ знает только сам браузер, поэтому
 * чужие сообщения отредактировать нельзя, а свои — можно и после переподключения.
 */
function uidFromKey(key: unknown): string {
  const secret = typeof key === "string" && key.length >= 16 ? key.slice(0, 128) : randomUUID();
  return createHash("sha256").update(secret).digest("base64url").slice(0, 16);
}

const cleanText = (raw: unknown) => String(raw ?? "").trim().slice(0, MAX_TEXT);
const snippet = (text: string) => (text.length > 140 ? `${text.slice(0, 140)}…` : text);

function findMessage(messageId: unknown): ChatMessage | undefined {
  return history.find((m) => m.id === messageId);
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
  return name || "Гость";
}

async function handle(id: string, client: Client, msg: ClientMessage): Promise<void> {
  const room = getRoom();
  if (!room) return;

  if (msg.t === "hello") {
    if (client.participant) return;
    client.participant = {
      id,
      name: cleanName(msg.name),
      color: COLOR_RE.test(msg.color) ? msg.color : "#7c8cff",
      isHost: client.isHost,
      micOn: Boolean(msg.micOn),
      canControl: client.isHost || (controlByUid.get(uidFromKey(msg.key)) ?? room.options.guestControl),
      joinedAt: Date.now(),
      uid: uidFromKey(msg.key),
    };
    send(client, {
      t: "welcome",
      selfId: id,
      selfUid: client.participant.uid,
      participants: participants(),
      history,
      ice: { iceServers: iceServers() },
    });
    broadcast({ t: "joined", participant: client.participant }, id);
    setOccupancy(participants().length);
    return;
  }

  const self = client.participant;
  if (!self) return;

  switch (msg.t) {
    case "chat": {
      const text = cleanText(msg.text);
      if (!text) return;
      // Цитата хранится снимком: её видно, даже если оригинал ушёл из истории.
      const quoted = msg.replyTo ? findMessage(msg.replyTo) : undefined;
      const message: ChatMessage = {
        id: randomUUID(),
        authorUid: self.uid,
        name: self.name,
        color: self.color,
        text,
        at: Date.now(),
        reactions: {},
        ...(quoted && { replyTo: { id: quoted.id, name: quoted.name, text: snippet(quoted.text) } }),
      };
      history = [...history.slice(-(HISTORY_LIMIT - 1)), message];
      broadcast({ t: "chat", message });
      return;
    }
    case "edit": {
      const message = findMessage(msg.id);
      const text = cleanText(msg.text);
      if (!message || !text || message.authorUid !== self.uid || message.text === text) return;
      message.text = text;
      message.editedAt = Date.now();
      broadcast({ t: "chat-update", message });
      // Обновляем и цитаты этого сообщения в ответах.
      for (const reply of history) {
        if (reply.replyTo?.id === message.id) {
          reply.replyTo.text = snippet(text);
          broadcast({ t: "chat-update", message: reply });
        }
      }
      return;
    }
    case "react": {
      const now = Date.now();
      if (now - client.lastChatActionAt < 120) return;
      client.lastChatActionAt = now;
      const message = findMessage(msg.id);
      if (!message || !isMessageReaction(msg.emoji)) return;
      // Одна реакция от человека: та же — снимается, другая — заменяет прежнюю.
      const had = Object.entries(message.reactions).find(([, list]) => list.some((r) => r.uid === self.uid))?.[0];
      for (const [emoji, list] of Object.entries(message.reactions)) {
        const rest = list.filter((r) => r.uid !== self.uid);
        if (rest.length) message.reactions[emoji] = rest;
        else delete message.reactions[emoji];
      }
      if (had !== msg.emoji) {
        message.reactions[msg.emoji] = [...(message.reactions[msg.emoji] ?? []), { uid: self.uid, name: self.name }];
      }
      broadcast({ t: "chat-update", message });
      return;
    }
    case "reaction": {
      const now = Date.now();
      if (now - client.lastReactionAt < 250) return;
      client.lastReactionAt = now;
      broadcast({ t: "reaction", from: id, emoji: String(msg.emoji).slice(0, 8) });
      return;
    }
    case "mic": {
      self.micOn = Boolean(msg.on);
      broadcast({ t: "updated", participant: self });
      return;
    }
    case "hb-user": {
      const hbUserId = String(msg.hbUserId).slice(0, 64);
      // Чужой id не принимаем: иначе можно было бы выдать или отобрать права у другого человека.
      if (participants().some((p) => p.id !== id && p.hbUserId === hbUserId)) return;
      self.hbUserId = hbUserId;
      // Роли по умолчанию в Hyperbeam одни на всех: управление есть у всех, если гостям его
      // разрешили, и ни у кого — если нет. Тем, чьи права отличаются (ведущему всегда, гостю —
      // по решению ведущего), выставляем роли явно, в том числе после переподключения.
      if (self.canControl !== room.options.guestControl && room.adminToken) {
        try {
          await setControl(room.embedUrl, room.adminToken, self.hbUserId, self.canControl);
        } catch (err) {
          console.error("[realtime] не удалось выставить права:", err);
          send(client, { t: "error", message: "Hyperbeam не применил права на управление — попробуй переподключиться" });
        }
      }
      broadcast({ t: "updated", participant: self });
      return;
    }
    case "set-control": {
      if (!client.isHost) return send(client, { t: "error", message: "Только ведущий может менять права" });
      const target = clients.get(msg.participantId)?.participant;
      if (!target || target.isHost) return;
      if (target.hbUserId && room.adminToken) {
        try {
          await setControl(room.embedUrl, room.adminToken, target.hbUserId, msg.canControl);
        } catch (err) {
          console.error("[realtime] роли:", err);
          return send(client, { t: "error", message: "Hyperbeam не принял изменение прав" });
        }
      }
      target.canControl = msg.canControl;
      controlByUid.set(target.uid, msg.canControl);
      broadcast({ t: "updated", participant: target });
      return;
    }
    case "signal": {
      const target = clients.get(msg.to);
      if (target?.participant) send(target, { t: "signal", from: id, data: msg.data });
      return;
    }
    case "ping":
      send(client, { t: "pong", at: msg.at });
      return;
  }
}

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();

    // Адрес общий — войти может любой, кто его знает. Ведущий подтверждает себя токеном владельца.
    const isHost = isOwner(url.searchParams.get("owner"));
    if (!getRoom()) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = randomUUID();
      const client: Client = { socket: ws, isHost, alive: true, participant: null, lastReactionAt: 0, lastChatActionAt: 0 };
      clients.set(id, client);

      ws.on("pong", () => (client.alive = true));
      ws.on("message", (raw) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        handle(id, client, msg).catch((err) => console.error("[realtime]", err));
      });
      ws.on("close", () => {
        clients.delete(id);
        if (client.participant) broadcast({ t: "left", id });
        setOccupancy(participants().length);
      });
    });
  });

  // Телефон, ушедший в фон, может не закрыть сокет — выкидываем «мёртвые» соединения.
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 15_000);
  wss.on("close", () => clearInterval(heartbeat));

  onRoomEnded((reason) => {
    broadcast({ t: "room-ended", reason });
    for (const client of clients.values()) client.socket.close(4000, "room ended");
    clients.clear();
    history = [];
    controlByUid = new Map();
  });
}

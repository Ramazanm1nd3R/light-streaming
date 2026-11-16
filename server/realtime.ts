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
/** Уже обработанные cid (uid:cid): повтор после обрыва не должен задвоить сообщение или реакцию. */
let seenCids = new Set<string>();
const SEEN_LIMIT = 5000;

/** cid сообщения, которое браузер повторит после обрыва, пока не получит ack. */
function cidOf(msg: ClientMessage): string | null {
  return "cid" in msg && typeof msg.cid === "string" && msg.cid ? msg.cid.slice(0, 64) : null;
}

function remember(key: string): void {
  seenCids.add(key);
  if (seenCids.size > SEEN_LIMIT) seenCids = new Set([...seenCids].slice(-SEEN_LIMIT / 2));
}

/** Убрать подключение из комнаты сразу, не дожидаясь, пока сокет закроется сам. */
function drop(id: string, client: Client): void {
  if (clients.get(id) !== client) return;
  clients.delete(id);
  if (client.participant) broadcast({ t: "left", id });
  setOccupancy(participants().length);
  client.socket.terminate();
}

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
    const uid = uidFromKey(msg.key);
    // После смены сети старое соединение браузера ещё числится живым (сервер узнает о его смерти
    // только через 15–30 с). Если это тот же браузер — убираем «призрака» сразу: иначе в комнате
    // двое одинаковых, а id Hyperbeam и права остаются за мёртвым подключением.
    const ghost = typeof msg.resume === "string" ? clients.get(msg.resume) : undefined;
    if (ghost && ghost !== client && ghost.participant?.uid === uid) drop(msg.resume!, ghost);
    client.participant = {
      id,
      name: cleanName(msg.name),
      color: COLOR_RE.test(msg.color) ? msg.color : "#7c8cff",
      isHost: client.isHost,
      micOn: Boolean(msg.micOn),
      canControl: client.isHost || (controlByUid.get(uid) ?? room.options.guestControl),
      joinedAt: Date.now(),
      uid,
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

  const cid = cidOf(msg);
  if (cid) {
    const key = `${self.uid}:${cid}`;
    // Уже обработано — ack потерялся вместе со старым соединением. Подтверждаем ещё раз.
    if (seenCids.has(key)) return send(client, { t: "ack", cid });
    remember(key);
  }
  try {
    await apply(id, client, self, msg);
  } finally {
    if (cid) send(client, { t: "ack", cid });
  }
}

async function apply(id: string, client: Client, self: Participant, msg: ClientMessage): Promise<void> {
  const room = getRoom();
  if (!room) return;

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
      const holder = participants().find((p) => p.id !== id && p.hbUserId === hbUserId);
      // Чужой id не принимаем: иначе можно было бы выдать или отобрать права у другого человека.
      // Свой же (тот же браузер, старое подключение после смены сети) — забираем себе.
      if (holder && holder.uid !== self.uid) return;
      if (holder) delete holder.hbUserId;
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
        client.alive = true;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        handle(id, client, msg).catch((err) => console.error("[realtime]", err));
      });
      ws.on("close", () => {
        // Уже убран при переподключении того же браузера — второй раз «вышел» не объявляем.
        if (clients.get(id) !== client) return;
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
    seenCids = new Set();
  });
}

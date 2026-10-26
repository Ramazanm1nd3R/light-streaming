import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, api, closeRoom, createRoom, sleep, startServer, type TestServer } from "./helpers.ts";
import type { ChatMessage, ServerMessage, StatusResponse } from "../shared/protocol.ts";

type ChatEvent = Extract<ServerMessage, { t: "chat" | "chat-update" }>;
const isChat = (text: string) => (m: ServerMessage) => m.t === "chat" && m.message.text === text;
const chatOf = async (client: Client, text: string): Promise<ChatMessage> => (await client.next<ChatEvent>(isChat(text))).message;

let server: TestServer;
const clients: Client[] = [];
const join = async (options: Parameters<typeof Client.connect>[1] = {}) => {
  const client = await Client.connect(server, options);
  clients.push(client);
  return client;
};

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.stop();
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await closeRoom(server);
});

// ------------------------------------------------------------------ комната

describe("комната и владелец", () => {
  it("без комнаты общая страница предлагает создать: room=null, людей нет", async () => {
    const { status, body } = await api<StatusResponse>(server, "GET", "/api/status");
    assert.equal(status, 200);
    assert.equal(body.room, null);
    assert.deepEqual(body.people, []);
    assert.equal(body.isHost, false);
    assert.equal(body.demo, true);
  });

  it("создание выдаёт токен владельца, вторую комнату создать нельзя (409)", async () => {
    const first = await createRoom(server);
    assert.equal(first.status, 200);
    assert.ok(first.body.ownerToken.length >= 20, "токен владельца слишком короткий");

    const second = await createRoom(server, { hostName: "Другой" });
    assert.equal(second.status, 409);
  });

  it("ведущим статус считает только браузер с токеном владельца", async () => {
    const { body: room } = await createRoom(server);
    const owner = await api<StatusResponse>(server, "GET", "/api/status", { headers: { "x-owner-token": room.ownerToken } });
    const guest = await api<StatusResponse>(server, "GET", "/api/status");
    const forged = await api<StatusResponse>(server, "GET", "/api/status", { headers: { "x-owner-token": "x".repeat(24) } });
    assert.equal(owner.body.isHost, true);
    assert.equal(guest.body.isHost, false);
    assert.equal(forged.body.isHost, false);
    assert.equal(guest.body.room?.hostName, "Lukas");
  });

  it("имя ведущего обрезается и чистится от лишних пробелов", async () => {
    await createRoom(server, { hostName: "   Очень    длинное имя ведущего, которое не помещается   " });
    const { body } = await api<StatusResponse>(server, "GET", "/api/status");
    assert.ok(body.room!.hostName.length <= 32);
    assert.ok(!body.room!.hostName.includes("  "));
  });

  it("стартовая страница без схемы получает https://", async () => {
    await createRoom(server, { startUrl: "youtube.com" });
    const { body } = await api<StatusResponse>(server, "GET", "/api/status");
    assert.equal(body.room!.options.startUrl, "https://youtube.com");
  });

  it("общая страница видит, кто внутри", async () => {
    const { body: room } = await createRoom(server);
    await join({ name: "Lukas", owner: room.ownerToken });
    await join({ name: "Mia" });
    const { body } = await api<StatusResponse>(server, "GET", "/api/status");
    assert.deepEqual(
      body.people.map((p) => [p.name, p.isHost]).sort(),
      [
        ["Lukas", true],
        ["Mia", false],
      ],
    );
  });

  it("без комнаты WebSocket не пускает", async () => {
    await assert.rejects(Client.connect(server), /403|отклонён/);
  });
});

describe("закрытие комнаты", () => {
  it("ведущий закрывает без пароля, участники получают room-ended и закрытый сокет", async () => {
    const { body: room } = await createRoom(server);
    const mia = await join({ name: "Mia" });
    const res = await api(server, "DELETE", "/api/room", { headers: { "x-owner-token": room.ownerToken } });
    assert.equal(res.status, 200);
    const ended = await mia.next((m) => m.t === "room-ended");
    assert.match((ended as Extract<ServerMessage, { t: "room-ended" }>).reason, /Ведущий/);
    assert.equal(await mia.closed(), 4000);
  });

  it("гость без пароля и с неверным паролем — 403, с верным — закрывает", async () => {
    await createRoom(server);
    const headers = { "x-forwarded-for": "10.0.0.1" };
    assert.equal((await api(server, "DELETE", "/api/room", { headers })).status, 403);
    assert.equal((await api(server, "DELETE", "/api/room", { body: { password: "nope" }, headers })).status, 403);
    assert.equal((await api(server, "DELETE", "/api/room", { body: { password: "test-pass" }, headers })).status, 200);
    const { body } = await api<StatusResponse>(server, "GET", "/api/status");
    assert.equal(body.room, null);
  });

  it("после 5 неверных паролей — 429, даже верный пароль не проходит; другой адрес не задет", async () => {
    await createRoom(server);
    const attacker = { "x-forwarded-for": "10.0.0.66" };
    for (let i = 0; i < 5; i++) {
      assert.equal((await api(server, "DELETE", "/api/room", { body: { password: `bad${i}` }, headers: attacker })).status, 403);
    }
    assert.equal((await api(server, "DELETE", "/api/room", { body: { password: "test-pass" }, headers: attacker })).status, 429);
    const other = await api(server, "DELETE", "/api/room", { body: { password: "test-pass" }, headers: { "x-forwarded-for": "10.0.0.67" } });
    assert.equal(other.status, 200);
  });

  it("подделка X-Forwarded-For не обходит лимит: учитывается адрес, добавленный прокси", async () => {
    await createRoom(server);
    for (let i = 0; i < 5; i++) {
      await api(server, "DELETE", "/api/room", {
        body: { password: `bad${i}` },
        headers: { "x-forwarded-for": `1.2.3.${i}, 10.0.0.77` },
      });
    }
    const res = await api(server, "DELETE", "/api/room", { body: { password: "test-pass" }, headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.77" } });
    assert.equal(res.status, 429);
  });
});

describe("автозакрытие пустой комнаты", () => {
  it("комната без участников закрывается сама", async () => {
    const quick = await startServer({ EMPTY_ROOM_TIMEOUT: "1" });
    try {
      const room = await createRoom(quick);
      const c = await Client.connect(quick, { owner: room.body.ownerToken });
      await sleep(1300);
      assert.ok((await api<StatusResponse>(quick, "GET", "/api/status")).body.room, "пока внутри кто-то есть, комната жива");
      c.close();
      await sleep(1600);
      assert.equal((await api<StatusResponse>(quick, "GET", "/api/status")).body.room, null);
    } finally {
      await quick.stop();
    }
  });
});

// ------------------------------------------------------------------ чат

describe("чат", () => {
  it("сообщение доходит до всех, пробелы по краям обрезаются, пустое не отправляется", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    const b = await join({ name: "Mia" });
    a.send({ t: "chat", text: "   " });
    a.send({ t: "chat", text: "  Привет  " });
    const got = await chatOf(b, "Привет");
    assert.equal(got.name, "Lukas");
    assert.equal(got.authorUid, a.selfUid);
    await b.none((m) => m.t === "chat" && m.message.text.trim() === "");
  });

  it("слишком длинное сообщение обрезается до 1000 символов", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "chat", text: "я".repeat(5000) });
    const m = await a.next<ChatEvent>((x) => x.t === "chat");
    assert.equal(m.message.text.length, 1000);
  });

  it("новичок получает историю чата", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    a.send({ t: "chat", text: "было до тебя" });
    await chatOf(a, "было до тебя");
    const late = await join({ name: "Jonas" });
    const welcome = late.messages.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    assert.deepEqual(
      welcome.history.map((m) => m.text),
      ["было до тебя"],
    );
  });

  it("ответ хранит снимок цитаты", async () => {
    await createRoom(server);
    const a = await join({ name: "Mia" });
    const b = await join({ name: "Lukas" });
    a.send({ t: "chat", text: "Этот кролик — лучший" });
    const original = await chatOf(b, "Этот кролик — лучший");
    b.send({ t: "chat", text: "согласен", replyTo: original.id });
    const reply = await chatOf(a, "согласен");
    assert.deepEqual(reply.replyTo, { id: original.id, name: "Mia", text: "Этот кролик — лучший" });
  });

  it("ответ на несуществующее сообщение уходит без цитаты", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "chat", text: "ответ в пустоту", replyTo: "нет-такого" });
    const m = await chatOf(a, "ответ в пустоту");
    assert.equal(m.replyTo, undefined);
  });

  it("правка своего сообщения доходит до всех с пометкой и обновляет цитаты в ответах", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    const b = await join({ name: "Mia" });
    a.send({ t: "chat", text: "черновик" });
    const original = await chatOf(b, "черновик");
    b.send({ t: "chat", text: "ответ", replyTo: original.id });
    const reply = await chatOf(a, "ответ");

    a.send({ t: "edit", id: original.id, text: "исправлено" });
    const edited = await b.next<ChatEvent>((m) => m.t === "chat-update" && m.message.id === original.id);
    assert.equal(edited.message.text, "исправлено");
    assert.ok(edited.message.editedAt);
    const quoted = await b.next<ChatEvent>((m) => m.t === "chat-update" && m.message.id === reply.id);
    assert.equal(quoted.message.replyTo?.text, "исправлено");
  });

  it("чужое сообщение отредактировать нельзя", async () => {
    await createRoom(server);
    const author = await join({ name: "Lukas" });
    const intruder = await join({ name: "Mallory" });
    author.send({ t: "chat", text: "моё" });
    const original = await chatOf(intruder, "моё");
    intruder.send({ t: "edit", id: original.id, text: "взломано" });
    await author.none((m) => m.t === "chat-update");
  });

  it("правка на пустой текст или тот же текст игнорируется", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "chat", text: "текст" });
    const m = await chatOf(a, "текст");
    a.send({ t: "edit", id: m.id, text: "   " });
    a.send({ t: "edit", id: m.id, text: "текст" });
    await a.none((x) => x.t === "chat-update");
  });
});

describe("реакции на сообщения", () => {
  it("одна реакция от человека: та же снимается, другая заменяет", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    const b = await join({ name: "Mia" });
    a.send({ t: "chat", text: "кадр" });
    const msg = await chatOf(b, "кадр");
    const update = () => a.next<ChatEvent>((m) => m.t === "chat-update" && m.message.id === msg.id);

    b.send({ t: "react", id: msg.id, emoji: "🔥" });
    assert.deepEqual(Object.keys((await update()).message.reactions), ["🔥"]);

    await sleep(150);
    b.send({ t: "react", id: msg.id, emoji: "😂" });
    const replaced = (await update()).message.reactions;
    assert.deepEqual(Object.keys(replaced), ["😂"]);
    assert.equal(replaced["😂"][0].name, "Mia");

    await sleep(150);
    b.send({ t: "react", id: msg.id, emoji: "😂" });
    assert.deepEqual((await update()).message.reactions, {});
  });

  it("реакции разных людей складываются", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    const b = await join({ name: "Mia" });
    a.send({ t: "chat", text: "смешно" });
    const msg = await chatOf(a, "смешно");
    a.send({ t: "react", id: msg.id, emoji: "😂" });
    await a.next((m) => m.t === "chat-update");
    b.send({ t: "react", id: msg.id, emoji: "😂" });
    const both = await a.next<ChatEvent>((m) => m.t === "chat-update");
    assert.deepEqual(both.message.reactions["😂"].map((r) => r.name).sort(), ["Lukas", "Mia"]);
  });

  it("эмодзи не из списка игнорируется", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "chat", text: "x" });
    const msg = await chatOf(a, "x");
    a.send({ t: "react", id: msg.id, emoji: "<script>" });
    a.send({ t: "react", id: msg.id, emoji: "🍕🍕" });
    a.send({ t: "react", id: msg.id, emoji: "x" });
    await a.none((m) => m.t === "chat-update");
  });

  it("принимается любая реакция из полного списка, а не только из быстрого набора", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "chat", text: "y" });
    const msg = await chatOf(a, "y");
    a.send({ t: "react", id: msg.id, emoji: "🥳" });
    const update = await a.next<ChatEvent>((m) => m.t === "chat-update");
    assert.deepEqual(Object.keys(update.message.reactions), ["🥳"]);
  });
});

describe("постоянный uid участника", () => {
  it("тот же ключ браузера — тот же uid после переподключения, и свои сообщения можно править", async () => {
    await createRoom(server);
    const key = "постоянный-секретный-ключ-браузера";
    const first = await join({ name: "Mia", key });
    first.send({ t: "chat", text: "до обрыва" });
    const msg = await chatOf(first, "до обрыва");
    first.close();
    await sleep(100);

    const again = await join({ name: "Mia", key });
    assert.equal(again.selfUid, first.selfUid);
    assert.notEqual(again.selfId, first.selfId);
    again.send({ t: "edit", id: msg.id, text: "после обрыва" });
    const edited = await again.next<ChatEvent>((m) => m.t === "chat-update");
    assert.equal(edited.message.text, "после обрыва");
  });

  it("разные ключи дают разные uid, а сам ключ наружу не уходит", async () => {
    await createRoom(server);
    const a = await join({ key: "ключ-первого-браузера-123" });
    const b = await join({ key: "ключ-второго-браузера-456" });
    assert.notEqual(a.selfUid, b.selfUid);
    const everything = JSON.stringify(a.messages.concat(b.messages));
    assert.ok(!everything.includes("ключ-первого") && !everything.includes("ключ-второго"));
  });
});

// ------------------------------------------------------------------ права и сигнализация

describe("права и сигнализация", () => {
  it("гость не может менять права, ведущий — может", async () => {
    const { body: room } = await createRoom(server, { guestControl: false });
    const host = await join({ name: "Lukas", owner: room.ownerToken });
    const guest = await join({ name: "Mia" });
    const welcome = guest.messages.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    assert.equal(welcome.participants.find((p) => p.id === guest.selfId)?.canControl, false);
    assert.equal(welcome.participants.find((p) => p.id === host.selfId)?.canControl, true);

    guest.send({ t: "set-control", participantId: guest.selfId, canControl: true });
    await guest.next((m) => m.t === "error");

    host.send({ t: "set-control", participantId: guest.selfId, canControl: true });
    const upd = await guest.next<Extract<ServerMessage, { t: "updated" }>>((m) => m.t === "updated" && m.participant.id === guest.selfId);
    assert.equal(upd.participant.canControl, true);
  });

  it("отобранное управление не возвращается после переподключения", async () => {
    const { body: room } = await createRoom(server, { guestControl: true });
    const host = await join({ name: "Lukas", owner: room.ownerToken });
    const key = "ключ-браузера-гостя-без-прав";
    const guest = await join({ name: "Mia", key });
    host.send({ t: "set-control", participantId: guest.selfId, canControl: false });
    await host.next((m) => m.t === "updated" && m.participant.id === guest.selfId);
    guest.close();
    await host.next((m) => m.t === "left");

    const again = await join({ name: "Mia", key });
    const welcome = again.messages.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    assert.equal(welcome.participants.find((p) => p.id === again.selfId)?.canControl, false);
    // а другой гость по-прежнему получает права по настройке комнаты
    const other = await join({ name: "Jonas" });
    const welcome2 = other.messages.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    assert.equal(welcome2.participants.find((p) => p.id === other.selfId)?.canControl, true);
  });

  it("выданное управление тоже переживает переподключение", async () => {
    const { body: room } = await createRoom(server, { guestControl: false });
    const host = await join({ name: "Lukas", owner: room.ownerToken });
    const key = "ключ-браузера-гостя-с-правами";
    const guest = await join({ name: "Mia", key });
    host.send({ t: "set-control", participantId: guest.selfId, canControl: true });
    await host.next((m) => m.t === "updated" && m.participant.id === guest.selfId);
    guest.close();
    await host.next((m) => m.t === "left");
    const again = await join({ name: "Mia", key });
    const welcome = again.messages.find((m) => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>;
    assert.equal(welcome.participants.find((p) => p.id === again.selfId)?.canControl, true);
  });

  it("чужой id пользователя Hyperbeam не принимается", async () => {
    await createRoom(server);
    const a = await join({ name: "A" });
    const b = await join({ name: "B" });
    a.send({ t: "hb-user", hbUserId: "hb-user-a" });
    await b.next((m) => m.t === "updated" && m.participant.id === a.selfId);
    b.send({ t: "hb-user", hbUserId: "hb-user-a" });
    await a.none((m) => m.t === "updated" && m.participant.id === b.selfId);
  });

  it("сигнализация WebRTC уходит только адресату", async () => {
    await createRoom(server);
    const a = await join({ name: "A" });
    const b = await join({ name: "B" });
    const c = await join({ name: "C" });
    a.send({ t: "signal", to: b.selfId, data: { kind: "candidate", candidate: null } });
    const got = await b.next<Extract<ServerMessage, { t: "signal" }>>((m) => m.t === "signal");
    assert.equal(got.from, a.selfId);
    await c.none((m) => m.t === "signal");
  });

  it("летящие реакции ограничены по частоте", async () => {
    await createRoom(server);
    const a = await join();
    const b = await join();
    for (let i = 0; i < 5; i++) a.send({ t: "reaction", emoji: "❤️" });
    await sleep(400);
    const count = b.messages.filter((m) => m.t === "reaction").length;
    assert.equal(count, 1);
  });

  it("ping → pong с тем же временем", async () => {
    await createRoom(server);
    const a = await join();
    a.send({ t: "ping", at: 12345 });
    const pong = await a.next<Extract<ServerMessage, { t: "pong" }>>((m) => m.t === "pong");
    assert.equal(pong.at, 12345);
  });

  it("вход и выход участников видят все", async () => {
    await createRoom(server);
    const a = await join({ name: "Lukas" });
    const b = await join({ name: "Mia" });
    await a.next((m) => m.t === "joined" && m.participant.name === "Mia");
    b.close();
    await a.next((m) => m.t === "left" && m.id === b.selfId);
  });
});

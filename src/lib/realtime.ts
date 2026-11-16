import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

export type SocketState = "connecting" | "open" | "reconnecting" | "closed";

// Сообщения, правки, реакции и решения ведущего о правах не теряются при обрыве: каждое ждёт
// подтверждения (ack) от сервера и повторяется после переподключения, пока его не получит.
// Сервер по cid отбрасывает повтор. Летящие реакции, пинги и сигнализация голоса через минуту
// бессмысленны, а id участников после переподключения другие — их не повторяем.
const RELIABLE: ReadonlySet<ClientMessage["t"]> = new Set(["chat", "edit", "react", "set-control"]);
const OUTBOX_LIMIT = 50;
// Сервер принимает реакции на сообщения не чаще раза в 120 мс — очередь уходит с интервалом.
const SEND_GAP_MS = 150;
const PING_MS = 4000;
// Нет ни одного ответа сервера столько времени после пинга — соединение мёртвое, хоть браузер
// и считает его открытым. Так бывает при смене точки Wi-Fi: старые пакеты уходят в никуда,
// а браузеру об этом никто не сообщает — он может «держать» такой сокет минутами.
const DEAD_AFTER_MS = 10_000;
// После возврата сети или вкладки проверяем соединение быстрее.
const PROBE_MS = 3000;
// Рукопожатие на медленном мобильном интернете бывает долгим — ему даём больше.
const CONNECT_TIMEOUT_MS = 15_000;

type Reliable = Extract<ClientMessage, { t: "chat" | "edit" | "react" | "set-control" }>;

interface Outgoing {
  cid: string;
  msg: Reliable;
  sentOn: WebSocket | null;
}

const newCid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * WebSocket с автоматическим переподключением. Смена Wi-Fi, LTE или уход Safari в фон рвут
 * соединение — клиент замечает это сам (даже когда браузер молчит) и тихо восстанавливает его
 * с нарастающей паузой, повторяя всё неподтверждённое.
 */
export class Realtime {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private watchTimer: number | undefined;
  private sendTimer: number | undefined;
  private outbox: Outgoing[] = [];
  /** Когда соединение считать мёртвым, если сервер так и не ответит. 0 — ответ получен. */
  private deadline = 0;

  private readonly onVisible = () => {
    if (document.visibilityState === "visible") this.probe();
  };
  /** Сеть вернулась или сменилась (другая точка Wi-Fi, LTE) — старое соединение, скорее всего, мертво. */
  private readonly onNetwork = () => this.probe();

  constructor(
    private readonly url: string,
    private readonly hello: () => ClientMessage,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: SocketState) => void,
  ) {
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("online", this.onNetwork);
    connection()?.addEventListener?.("change", this.onNetwork);
    this.watchTimer = window.setInterval(() => this.watch(), 1000);
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (RELIABLE.has(msg.t)) {
      const cid = newCid();
      this.outbox = [...this.outbox, { cid, msg: { ...(msg as Reliable), cid }, sentOn: null }].slice(-OUTBOX_LIMIT);
      this.pump();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** Сколько сообщений ещё не подтверждено сервером. */
  get unconfirmed(): number {
    return this.outbox.length;
  }

  /** Отправить по порядку всё, что ещё не уходило в это соединение. */
  private pump(): void {
    const socket = this.socket;
    if (this.sendTimer !== undefined || !socket || socket.readyState !== WebSocket.OPEN) return;
    const next = this.outbox.find((o) => o.sentOn !== socket);
    if (!next) return;
    socket.send(JSON.stringify(next.msg));
    next.sentOn = socket;
    this.expectAnswer(DEAD_AFTER_MS);
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = undefined;
      this.pump();
    }, SEND_GAP_MS);
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onNetwork);
    connection()?.removeEventListener?.("change", this.onNetwork);
    this.socket?.close();
    this.onState("closed");
  }

  /** Ждём от сервера хоть какого-то ответа не дольше ms — иначе переподключаемся. */
  private expectAnswer(ms: number): void {
    const at = Date.now() + ms;
    this.deadline = this.deadline ? Math.min(this.deadline, at) : at;
  }

  private ping(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: "ping", at: performance.now() }));
    this.expectAnswer(DEAD_AFTER_MS);
  }

  /** Быстрая проверка: жив ли сокет. Не открыт — переподключаемся сразу, открыт — пингуем. */
  private probe(): void {
    if (this.stopped) return;
    const state = this.socket?.readyState;
    if (state === WebSocket.OPEN) {
      this.ping();
      this.expectAnswer(PROBE_MS);
    } else if (state !== WebSocket.CONNECTING) {
      this.reconnectNow();
    }
  }

  private watch(): void {
    if (this.stopped || !this.deadline || Date.now() < this.deadline) return;
    const state = this.socket?.readyState;
    this.deadline = 0;
    if (state === WebSocket.OPEN) {
      console.warn("[realtime] сервер не отвечает — переподключаюсь");
      this.reconnectNow();
    } else if (state === WebSocket.CONNECTING) {
      // Рукопожатие повисло (пакеты уходят в старую сеть) — пробуем заново.
      this.reconnectNow();
    }
  }

  private connect(): void {
    this.onState(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    this.deadline = 0;
    this.expectAnswer(CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.onState("open");
      socket.send(JSON.stringify(this.hello()));
      this.deadline = 0;
      this.expectAnswer(DEAD_AFTER_MS);
      this.pump();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.deadline = 0;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return; // мусор игнорируем
      }
      if (msg.t === "ack") this.outbox = this.outbox.filter((o) => o.cid !== msg.cid);
      this.onMessage(msg);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      clearInterval(this.pingTimer);
      // 4000 — комната закрыта ведущим, переподключаться некуда.
      if (this.stopped || event.code === 4000) {
        this.onState("closed");
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.attempt += 1;
    this.onState("reconnecting");
    this.deadline = 0;
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempt, 5)) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const old = this.socket;
    this.socket = null;
    // Старый сокет больше не наш: его поздний onclose ничего не сломает.
    old?.close();
    this.attempt += 1;
    this.connect();
  }
}

/** Network Information API (Chrome, Android): событие change при смене сети. */
function connection(): EventTarget | undefined {
  return (navigator as Navigator & { connection?: EventTarget }).connection;
}

import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

export type SocketState = "connecting" | "open" | "reconnecting" | "closed";

/**
 * WebSocket с автоматическим переподключением. Смена Wi-Fi на LTE или уход
 * Safari в фон рвут соединение — клиент тихо восстанавливает его с нарастающей паузой.
 */
export class Realtime {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private readonly onVisible = () => {
    const state = this.socket?.readyState;
    if (document.visibilityState === "visible" && state !== WebSocket.OPEN && state !== WebSocket.CONNECTING) {
      this.reconnectNow();
    }
  };

  constructor(
    private readonly url: string,
    private readonly hello: () => ClientMessage,
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onState: (state: SocketState) => void,
  ) {
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.socket?.close();
    this.onState("closed");
  }

  private connect(): void {
    this.onState(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.onState("open");
      socket.send(JSON.stringify(this.hello()));
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", at: performance.now() }), 5000);
    };
    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        // мусор игнорируем
      }
    };
    socket.onclose = (event) => {
      clearInterval(this.pingTimer);
      if (this.socket !== socket) return;
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
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempt, 5)) * (0.8 + Math.random() * 0.4);
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
    this.connect();
  }
}

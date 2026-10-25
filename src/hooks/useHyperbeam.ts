import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { HyperbeamEmbed } from "@hyperbeam/web";

export type StreamState = "idle" | "connecting" | "playing" | "reconnecting" | "failed" | "ended";

interface Options {
  embedUrl: string;
  adminToken?: string;
  volume: number;
  onEnded(reason: string): void;
  onWarning(seconds: number | null): void;
  onNotice(text: string): void;
}

const REASONS: Record<string, string> = {
  request: "Сессия завершена",
  inactive: "Сессия закрыта из-за бездействия",
  absolute: "Истекло максимальное время сессии",
  kicked: "Ведущий отключил тебя от просмотра",
  unauthorized: "Ссылка больше не действует",
};

// Если за это время кадры так и не пошли — пересоздаём медиасоединение.
const STALL_SECONDS = 12;
const MAX_AUTO_RETRIES = 3;

/** Есть ли реальные кадры. Видео у SDK лежит в shadow DOM контейнера; в Safari по http — canvas. */
function hasFrames(el: HTMLDivElement): boolean | null {
  const video = el.shadowRoot?.querySelector("video");
  if (!video) return null;
  return video.videoWidth > 0 && video.readyState >= 2;
}

/**
 * Встраивает облачный браузер Hyperbeam в контейнер.
 * Видео и звук идут из облака Hyperbeam прямо на устройство зрителя —
 * ноутбук ведущего в передаче медиа не участвует.
 *
 * Состояние берётся только из событий SDK: Hyperbeam() разрешается, когда соединение
 * установлено, но кадры могут прийти позже — или застрять. За этим следит сторож.
 */
export function useHyperbeam(container: RefObject<HTMLDivElement | null>, options: Options | null) {
  const [hb, setHb] = useState<HyperbeamEmbed | null>(null);
  const [state, setState] = useState<StreamState>("idle");
  const [rtt, setRtt] = useState<number | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;
  const stateRef = useRef<StreamState>("idle");
  const retries = useRef(0);
  const stalled = useRef(0);

  const update = useCallback((next: StreamState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const embedUrl = options?.embedUrl;

  useEffect(() => {
    const el = container.current;
    if (!el || !embedUrl) return;
    let disposed = false;
    let instance: HyperbeamEmbed | null = null;
    retries.current = 0;
    stalled.current = 0;
    update("connecting");

    (async () => {
      const { default: Hyperbeam } = await import("@hyperbeam/web");
      try {
        instance = await Hyperbeam(el, embedUrl, {
          adminToken: optsRef.current?.adminToken,
          volume: optsRef.current?.volume ?? 1,
          delegateKeyboard: true,
          timeout: 15_000,
          onConnectionStateChange: ({ state }) => !disposed && update(state),
          onDisconnect: ({ type }) => {
            if (disposed) return;
            update("ended");
            optsRef.current?.onEnded(REASONS[type] ?? "Соединение с облачным браузером потеряно");
          },
          onCloseWarning: ({ deadline }) => optsRef.current?.onWarning(deadline ? Math.round(deadline.delay / 1000) : null),
        });
      } catch (err) {
        console.error("[hyperbeam]", err);
        if (!disposed) update("failed");
        return;
      }
      if (disposed) {
        instance.destroy();
        return;
      }
      setHb(instance);
    })();

    const timer = window.setInterval(() => {
      if (!instance) return;
      if (instance.rtt !== undefined) setRtt(Math.round(instance.rtt));

      const current = stateRef.current;
      if (current === "ended" || current === "failed") return;
      const frames = hasFrames(el);
      const ok = current === "playing" && frames !== false;
      if (ok) {
        stalled.current = 0;
        retries.current = 0;
        return;
      }
      stalled.current += 2;
      if (stalled.current < STALL_SECONDS) return;
      stalled.current = 0;
      if (retries.current >= MAX_AUTO_RETRIES) {
        update("failed");
        return;
      }
      retries.current += 1;
      console.warn(`[hyperbeam] кадры не идут ${STALL_SECONDS} с — переподключение #${retries.current}`);
      optsRef.current?.onNotice("Видео не пришло — переподключаюсь…");
      update("reconnecting");
      instance.reconnect();
    }, 2000);

    return () => {
      disposed = true;
      clearInterval(timer);
      instance?.destroy();
      setHb(null);
    };
  }, [container, embedUrl, update]);

  /** Ручной повтор с экрана ошибки или из меню. */
  const retry = useCallback(() => {
    if (!hb) return location.reload();
    retries.current = 0;
    stalled.current = 0;
    update("reconnecting");
    hb.reconnect();
  }, [hb, update]);

  return { hb, state, rtt, retry };
}

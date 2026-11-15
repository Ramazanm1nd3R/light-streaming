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

// Если за это время кадры так и не пошли — пересоздаём медиасоединение. Бывает, что самое первое
// соединение с Hyperbeam уже «играет», а видео так и не приходит, — его переподключаем быстрее.
// Во всех остальных случаях не торопим: на медленной сети (iPhone в мобильном интернете) ранний
// перезапуск обрывал бы рукопожатие или только что начатое переподключение.
const STALL_SECONDS = 12;
const FIRST_FRAME_SECONDS = 6;
// SDK повторяет подключение сам и может так и не ответить — тогда сторож ниже ещё не работает.
// Вместо вечного «Подключаемся…» показываем экран ошибки с кнопкой «Повторить».
const INIT_TIMEOUT_MS = 20_000;
const MAX_AUTO_RETRIES = 4;

/**
 * Есть ли реальные кадры. Видео у SDK лежит в shadow DOM контейнера; в Safari по http — canvas.
 * Сразу после переподключения SDK ставит заглушку 2×2 — это ещё не видео (настоящее — от 256 px).
 */
function hasFrames(el: HTMLDivElement): boolean | null {
  const video = el.shadowRoot?.querySelector("video");
  if (!video) return null;
  return video.videoWidth > 16 && video.readyState >= 2;
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
  const gotFrames = useRef(false);

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
    gotFrames.current = false;
    update("connecting");

    const initTimer = window.setTimeout(() => {
      if (instance || disposed) return;
      console.warn("[hyperbeam] SDK не ответил за 20 с");
      update("failed");
    }, INIT_TIMEOUT_MS);

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
      clearTimeout(initTimer);
      if (disposed) {
        instance.destroy();
        return;
      }
      // SDK всё-таки ответил после экрана ошибки — соединение живо, показываем видео.
      if (stateRef.current === "failed") update("connecting");
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
        if (frames) gotFrames.current = true;
        return;
      }
      stalled.current += 2;
      const noFirstFrame = current === "playing" && !gotFrames.current && retries.current === 0;
      if (stalled.current < (noFirstFrame ? FIRST_FRAME_SECONDS : STALL_SECONDS)) return;
      stalled.current = 0;
      if (retries.current >= MAX_AUTO_RETRIES) {
        update("failed");
        return;
      }
      retries.current += 1;
      console.warn(`[hyperbeam] кадры не идут — переподключение #${retries.current}`);
      optsRef.current?.onNotice("Видео не пришло — переподключаюсь…");
      update("reconnecting");
      instance.reconnect();
    }, 2000);

    return () => {
      disposed = true;
      clearTimeout(initTimer);
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

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
// После серии неудачных попыток не сдаёмся навсегда: длинный обрыв интернета — не повод
// оставлять человека с кнопкой «Повторить». Пробуем ещё раз с такой паузой.
const FAILED_RETRY_SECONDS = 30;
// После смены сети картинка может восстановиться сама (WebRTC перескакивает на новую сеть),
// а канал управления — нет: видео идёт, а клики, клавиши и адреса никуда не доходят. Поэтому
// канал управления проверяем отдельно — дешёвым запросом, на который облако отвечает всегда
// (с правами или без). Нет ответа дважды подряд — переподключаемся.
const CONTROL_PROBE_EVERY_MS = 20_000;
const CONTROL_PROBE_TIMEOUT_MS = 4000;

/** Отвечает ли облачный браузер по каналу управления. Ответ без прав — тоже ответ. */
async function controlAlive(hb: HyperbeamEmbed): Promise<boolean> {
  let timer: number | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => resolve(false), CONTROL_PROBE_TIMEOUT_MS);
  });
  const answer = Promise.resolve()
    .then(() => hb.tabs.query({ active: true }))
    .then(
      () => true,
      () => true,
    );
  try {
    return await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
  // Растёт при каждом восстановлении видео: по нему права в Hyperbeam выставляются заново.
  const [epoch, setEpoch] = useState(0);
  // Пересоздать встраивание целиком (если SDK так и не поднялся).
  const [generation, setGeneration] = useState(0);
  const optsRef = useRef(options);
  optsRef.current = options;
  const stateRef = useRef<StreamState>("idle");
  const retries = useRef(0);
  const stalled = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  // Сколько раз подряд пересоздавали подключение, не дождавшись кадров (живёт между пересозданиями).
  const reinits = useRef(0);
  const gotFrames = useRef(false);

  const update = useCallback((next: StreamState) => {
    const was = stateRef.current;
    stateRef.current = next;
    setState(next);
    if (next === "playing" && was !== "playing") setEpoch((n) => n + 1);
  }, []);

  const embedUrl = options?.embedUrl;

  useEffect(() => {
    const el = container.current;
    if (!el || !embedUrl) return;
    let disposed = false;
    let instance: HyperbeamEmbed | null = null;
    let failedFor = 0;
    let probing = false;
    let lastProbe = Date.now();

    /** Проверить канал управления; молчит дважды подряд — переподключиться. */
    const checkControl = async (reason: string) => {
      if (probing || !instance || disposed || stateRef.current !== "playing") return;
      probing = true;
      lastProbe = Date.now();
      const hb = instance;
      const alive = (await controlAlive(hb)) || (await controlAlive(hb));
      probing = false;
      if (alive || disposed || hb !== instance || stateRef.current !== "playing") return;
      // Обычный reconnect() пошёл бы по тому же мёртвому соединению и висел бы до таймаута.
      // Пересоздаём подключение целиком: новые соединения, новый id — права сервер выставит заново.
      console.warn(`[hyperbeam] управление не отвечает (${reason}) — подключаюсь заново`);
      update("reconnecting");
      setGeneration((n) => n + 1);
    };
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
      if (current === "ended") return;
      if (current === "failed") {
        failedFor += 2;
        if (failedFor < FAILED_RETRY_SECONDS || !navigator.onLine) return;
        failedFor = 0;
        retries.current = 0;
        stalled.current = 0;
        update("reconnecting");
        instance.reconnect();
        return;
      }
      failedFor = 0;
      const frames = hasFrames(el);
      const ok = current === "playing" && frames !== false;
      if (ok) {
        stalled.current = 0;
        retries.current = 0;
        if (frames) {
          gotFrames.current = true;
          reinits.current = 0;
        }
        if (document.visibilityState === "visible" && Date.now() - lastProbe > CONTROL_PROBE_EVERY_MS) {
          void checkControl("плановая проверка");
        }
        return;
      }
      stalled.current += 2;
      const noFirstFrame = current === "playing" && !gotFrames.current && retries.current === 0;
      if (stalled.current < (noFirstFrame ? FIRST_FRAME_SECONDS : STALL_SECONDS)) return;
      stalled.current = 0;
      // Без сети попытки бесполезны — не тратим их, ждём возврата сети (см. online ниже).
      if (!navigator.onLine) return;
      if (retries.current >= MAX_AUTO_RETRIES) {
        update("failed");
        return;
      }
      // Два переподключения не помогли — вероятно, SDK держится за мёртвое соединение старой сети.
      // Один раз пересоздаём подключение целиком, дальше — снова обычные попытки.
      if (retries.current === 2 && reinits.current === 0) {
        reinits.current += 1;
        console.warn("[hyperbeam] кадры не идут после двух попыток — подключаюсь заново");
        update("reconnecting");
        setGeneration((n) => n + 1);
        return;
      }
      retries.current += 1;
      console.warn(`[hyperbeam] кадры не идут — переподключение #${retries.current}`);
      optsRef.current?.onNotice("Видео не пришло — переподключаюсь…");
      update("reconnecting");
      instance.reconnect();
    }, 2000);

    // Сеть вернулась или сменилась: не ждём сторожа, переподключаемся сразу.
    // Через пару секунд — чтобы новая сеть успела подняться.
    let networkTimer: number | undefined;
    refreshRef.current = () => {
      if (disposed) return;
      if (!instance) {
        if (stateRef.current === "failed") setGeneration((n) => n + 1);
        return;
      }
      if (stateRef.current === "playing") {
        void checkControl("сеть менялась");
      } else if (stateRef.current !== "ended") {
        // Видео и так стоит — сторож кадров переподключит его; попытки начинаем заново.
        retries.current = 0;
      }
    };
    const onNetwork = () => {
      clearTimeout(networkTimer);
      networkTimer = window.setTimeout(() => refreshRef.current(), 2000);
    };
    const onVisible = () => document.visibilityState === "visible" && refreshRef.current();
    document.addEventListener("visibilitychange", onVisible);
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener("online", onNetwork);
    conn?.addEventListener?.("change", onNetwork);

    return () => {
      disposed = true;
      clearTimeout(initTimer);
      clearTimeout(networkTimer);
      clearInterval(timer);
      window.removeEventListener("online", onNetwork);
      document.removeEventListener("visibilitychange", onVisible);
      conn?.removeEventListener?.("change", onNetwork);
      instance?.destroy();
      setHb(null);
    };
  }, [container, embedUrl, update, generation]);

  /** Ручной повтор с экрана ошибки или из меню. */
  const retry = useCallback(() => {
    if (!hb) return setGeneration((n) => n + 1);
    retries.current = 0;
    stalled.current = 0;
    update("reconnecting");
    hb.reconnect();
  }, [hb, update]);

  /** Наше соединение с сервером восстановилось после обрыва — сеть менялась, проверяем и управление. */
  const refresh = useCallback(() => refreshRef.current(), []);

  return { hb, state, rtt, epoch, retry, refresh };
}

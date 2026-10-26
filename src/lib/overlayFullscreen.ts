// Полный экран на iPhone с чатом и реакциями поверх видео.
//
// Safari на iPhone разворачивает на весь экран только <video> — в нативном плеере, поверх
// которого страница ничего нарисовать не может. Поэтому в плеер уходит не исходное видео
// Hyperbeam, а наше: каждый кадр трансляции рисуется на canvas, поверх — всплывающие
// сообщения и летящие реакции, а canvas.captureStream() превращает это в видеопоток.
// Сообщения становятся частью картинки и видны и на весь экран, и в «картинке в картинке».
// Звук и голос не затрагиваются: они по-прежнему играют отдельно.

import type { ChatMessage } from "../../shared/protocol.ts";
import type { FloatingReaction } from "../hooks/useRoomSession.ts";
import type { IosVideo } from "./fullscreen.ts";

export interface OverlayFeed {
  messages: ChatMessage[];
  reactions: FloatingReaction[];
  selfUid: string;
}

const FPS = 30;
const TOAST_MS = 6500;
const REACTION_MS = 2600;

type CaptureCanvas = HTMLCanvasElement & { captureStream?(fps?: number): MediaStream };

export function canOverlayFullscreen(): boolean {
  return typeof (document.createElement("canvas") as CaptureCanvas).captureStream === "function";
}

/** Что происходит в нативном плеере, пока он открыт. */
export interface FullscreenEvents {
  onExit(): void;
  /** Пауза в плеере — это пауза у себя: картинка и звук сайта, а не только видео с чатом. */
  onPause(): void;
  onPlay(): void;
}

export interface OverlayPlayer {
  /** Видео из canvas загрузилось — можно открывать полный экран прямо в обработчике нажатия. */
  ready(): boolean;
  /** Открыть нативный полный экран. false — не вышло, нужно разворачивать исходное видео. */
  enter(events: FullscreenEvents): boolean;
  dispose(): void;
}

const IDLE_FPS = 4;

/**
 * Готовит видео с наложенным чатом заранее. Safari разрешает открыть полный экран только
 * синхронно в обработчике нажатия, а видео из canvas получает размеры не мгновенно — поэтому
 * готовим его, как только пошла трансляция: в ожидании рисуем 4 кадра в секунду, в полном
 * экране — 30.
 */
export function prepareOverlayFullscreen(source: HTMLVideoElement, feed: () => OverlayFeed): OverlayPlayer | null {
  if (!canOverlayFullscreen() || !source.videoWidth) return null;

  const canvas = document.createElement("canvas") as CaptureCanvas;
  canvas.width = source.videoWidth;
  canvas.height = source.videoHeight;
  canvas.dataset.lsOverlay = "";
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const scale = canvas.height / 720;

  // Когда сообщение или реакция впервые попали в кадр — по часам этого устройства,
  // чтобы рассинхрон часов с сервером не ломал анимацию.
  const seen = new Map<string, number>();
  const firstSeen = (id: string, now: number) => {
    if (!seen.has(id)) seen.set(id, now);
    return seen.get(id)!;
  };

  const draw = () => {
    const now = performance.now();
    try {
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    } catch {
      // кадр ещё не готов — оставляем предыдущий
    }
    const { messages, reactions, selfUid } = feed();
    drawReactions(ctx, canvas, scale, reactions, now, firstSeen);
    drawToasts(ctx, canvas, scale, messages, selfUid, now, firstSeen);
  };
  draw();

  const stream = canvas.captureStream!(FPS);
  const out = document.createElement("video") as IosVideo;
  out.muted = true;
  out.playsInline = true;
  out.setAttribute("playsinline", "");
  out.srcObject = stream;
  // В DOM, но невидимое: iOS разворачивает только видео, которое есть на странице.
  Object.assign(out.style, { position: "fixed", width: "2px", height: "2px", opacity: "0", pointerEvents: "none", left: "0", top: "0" });
  document.body.appendChild(out);
  void out.play().catch(() => {});

  let timer = window.setInterval(draw, 1000 / IDLE_FPS);
  const setFps = (fps: number) => {
    clearInterval(timer);
    timer = window.setInterval(draw, 1000 / fps);
  };

  return {
    ready: () => out.readyState >= 1 && out.videoWidth > 0,
    enter(events) {
      if (!out.webkitEnterFullscreen) return false;
      // Всё, что уже было в чате до входа в полный экран, не всплывает.
      const now = performance.now();
      for (const m of feed().messages) if (!seen.has(m.id)) seen.set(m.id, now - TOAST_MS);
      setFps(FPS);

      let active = true;
      let pauseTimer: number | undefined;
      // iOS сама ставит на паузу беззвучное видео, которого не видно на странице, — а наше видео
      // с чатом до нажатия спрятано. Поэтому при входе в полный экран явно запускаем его,
      // иначе плеер открывается на паузе, а звук сайта при этом продолжает играть.
      const play = () => void out.play().catch(() => {});
      // Пауза, нажатая в плеере, — это пауза у себя. Ждём немного и проверяем, что плеер всё ещё
      // открыт и страница видна: при выходе из полного экрана, сворачивании или смене аудио
      // (голосовой чат) iOS ставит видео на паузу сама, и такую паузу пользовательской не считаем.
      const onPause = () => {
        clearTimeout(pauseTimer);
        pauseTimer = window.setTimeout(() => {
          if (active && out.paused && out.webkitDisplayingFullscreen !== false && document.visibilityState === "visible") events.onPause();
        }, 250);
      };
      const onPlay = () => {
        clearTimeout(pauseTimer);
        if (active) events.onPlay();
      };
      const onEnd = () => {
        active = false;
        clearTimeout(pauseTimer);
        out.removeEventListener("pause", onPause);
        out.removeEventListener("play", onPlay);
        out.removeEventListener("webkitbeginfullscreen", play);
        setFps(IDLE_FPS);
        void source.play().catch(() => {});
        play();
        events.onExit();
      };
      out.addEventListener("pause", onPause);
      out.addEventListener("play", onPlay);
      out.addEventListener("webkitbeginfullscreen", play);
      out.addEventListener("webkitendfullscreen", onEnd, { once: true });
      try {
        out.webkitEnterFullscreen();
        play();
        return true;
      } catch {
        onEnd();
        return false;
      }
    },
    dispose() {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      out.srcObject = null;
      out.remove();
    },
  };
}

// ---------------------------------------------------------------- рисование

function drawReactions(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  s: number,
  reactions: FloatingReaction[],
  now: number,
  firstSeen: (id: string, now: number) => number,
): void {
  for (const r of reactions) {
    const t = (now - firstSeen(`r${r.id}`, now)) / REACTION_MS;
    if (t < 0 || t > 1) continue;
    // та же траектория, что у CSS-анимации float-up: вылет, покачивание, растворение
    const opacity = t < 0.12 ? t / 0.12 : 1 - Math.max(0, (t - 0.5) / 0.5);
    const rise = (t < 0.12 ? (t / 0.12) * 20 : 20 + ((t - 0.12) / 0.88) * 200) * s;
    const sway = Math.sin(t * Math.PI * 2) * 10 * s;
    const size = (t < 0.12 ? 0.6 + (t / 0.12) * 0.5 : 1.1 - (t - 0.12) * 0.2) * 46 * s;
    ctx.globalAlpha = Math.max(0, opacity);
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(r.emoji, (r.x / 100) * canvas.width + sway, canvas.height * 0.94 + 20 * s - rise);
  }
  ctx.globalAlpha = 1;
}

function drawToasts(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  s: number,
  messages: ChatMessage[],
  selfUid: string,
  now: number,
  firstSeen: (id: string, now: number) => number,
): void {
  const visible = messages
    .filter((m) => m.authorUid !== selfUid)
    .map((m) => ({ m, age: now - firstSeen(m.id, now) }))
    .filter(({ age }) => age >= 0 && age < TOAST_MS)
    .slice(-3);

  const font = '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif';
  const pad = 14 * s;
  const avatar = 34 * s;
  const maxText = 560 * s;
  let bottom = canvas.height - 30 * s;

  for (let i = visible.length - 1; i >= 0; i--) {
    const { m, age } = visible[i];
    const appear = Math.min(1, age / 220);
    const fade = age > TOAST_MS - 600 ? (TOAST_MS - age) / 600 : 1;
    ctx.globalAlpha = Math.max(0, Math.min(appear, fade));

    ctx.font = `600 ${18 * s}px ${font}`;
    const nameWidth = ctx.measureText(m.name).width;
    ctx.font = `${24 * s}px ${font}`;
    const lines = wrap(ctx, m.text, maxText, 2);
    const textWidth = Math.max(nameWidth, ...lines.map((l) => ctx.measureText(l).width));
    const height = pad * 2 + 22 * s + lines.length * 30 * s;
    const width = pad * 3 + avatar + textWidth;
    const x = 28 * s - (1 - appear) * 12 * s;
    const y = bottom - height;

    ctx.fillStyle = "rgba(10, 11, 16, 0.62)";
    roundRect(ctx, x, y, width, height, 20 * s);
    ctx.fill();

    // аватар с инициалами
    const cx = x + pad + avatar / 2;
    const cy = y + pad + avatar / 2;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(cx, cy, avatar / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${14 * s}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(m.name), cx, cy + 1 * s);

    // имя и текст
    const tx = x + pad * 2 + avatar;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = m.color;
    ctx.font = `600 ${18 * s}px ${font}`;
    ctx.fillText(m.name, tx, y + pad);
    ctx.fillStyle = "#f3f4f8";
    ctx.font = `${24 * s}px ${font}`;
    lines.forEach((line, n) => ctx.fillText(line, tx, y + pad + 24 * s + n * 30 * s));

    bottom = y - 10 * s;
  }
  ctx.globalAlpha = 1;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s*\S*$/, "")}…`;
    return kept;
  }
  return lines;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

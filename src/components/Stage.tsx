import { useRef, useState, type ReactNode, type RefObject } from "react";
import { FastForward, Loader2, MousePointerClick, Pause, Play, RefreshCw, Rewind, X } from "lucide-react";
import type { FloatingReaction } from "../hooks/useRoomSession.ts";
import type { StreamState } from "../hooks/useHyperbeam.ts";

export type PlayerKey = " " | "ArrowLeft" | "ArrowRight" | "f" | "m";

interface Props {
  hbRef: RefObject<HTMLDivElement | null>;
  demo: boolean;
  streamState: StreamState;
  controlMode: boolean;
  /** Плашка «Управление включено» — только на телефоне, на компьютере управление включено всегда. */
  showControlPill: boolean;
  overlayVisible: boolean;
  reactions: FloatingReaction[];
  onTap(): void;
  onKey(key: PlayerKey): void;
  onExitControl(): void;
  onRetry(): void;
  /** Пауза только у этого зрителя: кадр замер, звук сайта выключен, остальные смотрят дальше. */
  localPaused: boolean;
  onResume(): void;
  children?: ReactNode;
}

interface Ripple {
  id: number;
  side: "left" | "right" | "center";
}

let rippleSeq = 0;

/**
 * Видео в рамке 16:9, вписанной в доступное место. Поверх — слой жестов:
 *  • одно касание — показать/спрятать управление;
 *  • двойное касание слева/справа — перемотка (как в YouTube), по центру — пауза.
 * Пока не включён режим «Управление», случайные касания не попадают в облачный браузер.
 */
export function Stage(props: Props) {
  const { hbRef, demo, streamState, controlMode, showControlPill, overlayVisible, reactions, onTap, onKey, onExitControl, onRetry, localPaused, onResume, children } = props;
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  const ripple = (side: Ripple["side"]) => {
    const id = ++rippleSeq;
    setRipples((list) => [...list, { id, side }]);
    window.setTimeout(() => setRipples((list) => list.filter((r) => r.id !== id)), 650);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = performance.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;

    if (now - lastTap.current < 280) {
      clearTimeout(tapTimer.current);
      lastTap.current = 0;
      if (x < 0.35) {
        onKey("ArrowLeft");
        ripple("left");
      } else if (x > 0.65) {
        onKey("ArrowRight");
        ripple("right");
      } else {
        onKey(" ");
        ripple("center");
      }
      return;
    }
    lastTap.current = now;
    tapTimer.current = window.setTimeout(onTap, 240);
  };

  return (
    <div className="stage">
      <div className="stage__box">
        {demo ? <DemoScreen /> : <div ref={hbRef} className="stage__hb" />}

        {!controlMode && <div className="stage__gestures" onPointerUp={onPointerUp} />}

        {ripples.map((r) => (
          <div key={r.id} className={`seek-ripple seek-ripple--${r.side}`}>
            {r.side === "left" ? <Rewind size={26} /> : r.side === "right" ? <FastForward size={26} /> : <Play size={26} />}
          </div>
        ))}

        {!controlMode && !localPaused && (
          <div className={`player-keys${overlayVisible ? " is-visible" : ""}`}>
            <button type="button" aria-label="Назад" onClick={() => onKey("ArrowLeft")}>
              <Rewind size={22} />
            </button>
            <button type="button" className="player-keys__main" aria-label="Пауза / воспроизведение" onClick={() => onKey(" ")}>
              <Play size={26} className="player-keys__play" />
            </button>
            <button type="button" aria-label="Вперёд" onClick={() => onKey("ArrowRight")}>
              <FastForward size={22} />
            </button>
          </div>
        )}

        {controlMode && showControlPill && (
          <button type="button" className={`control-pill${overlayVisible ? " is-visible" : ""}`} onClick={onExitControl}>
            <MousePointerClick size={14} />
            Управление браузером
            <X size={14} />
          </button>
        )}

        {localPaused && (
          <div className="local-pause">
            <div className="local-pause__card">
              <Pause size={22} />
              <strong>Пауза только у тебя</strong>
              <span>Остальные смотрят дальше, голосовой чат работает</span>
              <button type="button" className="btn btn--primary" onClick={onResume}>
                <Play size={16} /> Вернуться в эфир
              </button>
            </div>
          </div>
        )}

        <div className="reactions-layer" aria-hidden="true">
          {reactions.map((r) => (
            <span key={r.id} className="float-emoji" style={{ left: `${r.x}%` }}>
              {r.emoji}
            </span>
          ))}
        </div>

        {!demo && streamState !== "playing" && streamState !== "ended" && (
          <div className={`stage__status${streamState === "reconnecting" ? " stage__status--soft" : ""}`}>
            {streamState === "failed" ? (
              <>
                <p>Не удалось подключиться к облачному браузеру</p>
                <button type="button" className="btn btn--glass" onClick={onRetry}>
                  <RefreshCw size={16} /> Повторить
                </button>
              </>
            ) : (
              <>
                <Loader2 className="spin" size={26} />
                <p>{streamState === "reconnecting" ? "Переподключение…" : "Подключаемся к трансляции…"}</p>
              </>
            )}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

function DemoScreen() {
  return (
    <div className="demo-screen">
      <div className="demo-screen__sun" />
      <div className="demo-cloud demo-cloud--a" />
      <div className="demo-cloud demo-cloud--b" />
      <div className="demo-cloud demo-cloud--c" />
      <div className="demo-screen__label">
        <strong>Демо-режим</strong>
        <span>Добавь HYPERBEAM_API_KEY в .env — здесь появится облачный браузер</span>
      </div>
    </div>
  );
}

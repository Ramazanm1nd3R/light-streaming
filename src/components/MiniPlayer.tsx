import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { MessageCircle, MessageCircleOff, Mic, MicOff, PhoneOff, Play, SendHorizontal, Smile } from "lucide-react";
import { REACTIONS } from "../../shared/protocol.ts";
import type { RoomSession } from "../hooks/useRoomSession.ts";
import { ChatToasts } from "./Chat.tsx";
import { Avatar, IconButton } from "./ui.tsx";

interface Props {
  /** Окно Document Picture-in-Picture, в которое рисуется мини-плеер. */
  win: Window;
  /** Текущее видео трансляции: после переподключения SDK может подменить элемент. */
  source(): HTMLVideoElement | null;
  demo: boolean;
  session: RoomSession;
  localPaused: boolean;
  onResume(): void;
  onLeave(): void;
}

/**
 * Мини-плеер в окне поверх всех окон: видео, летящие реакции, мини-чат, микрофон и выход.
 * Видео не переносится из вкладки — окно показывает тот же поток (MediaStream) во втором
 * <video> без звука, а звук продолжает играть вкладка.
 */
export function MiniPlayer(props: Props) {
  return createPortal(<MiniPlayerView {...props} />, props.win.document.body);
}

function MiniPlayerView({ source, demo, session, localPaused, onResume, onLeave }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [chat, setChat] = useState(true);
  const [picker, setPicker] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Подключаем поток трансляции и следим, не сменился ли он после переподключения.
  useEffect(() => {
    const sync = () => {
      const el = video.current;
      const stream = source()?.srcObject ?? null;
      if (!el || el.srcObject === stream) return;
      el.srcObject = stream;
      if (stream) void el.play().catch(() => {});
    };
    sync();
    const timer = window.setInterval(sync, 1000);
    return () => clearInterval(timer);
  }, [source]);

  // Выход — по второму нажатию: случайно задеть кнопку в маленьком окне легко.
  useEffect(() => {
    if (!confirmLeave) return;
    const timer = window.setTimeout(() => setConfirmLeave(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmLeave]);

  return (
    <div className={`mini${chat ? " mini--chat" : ""}`}>
      <div className="mini__video">
        {demo ? <div className="mini__demo">Демо-режим: видео нет</div> : <video ref={video} muted autoPlay playsInline />}

        <div className="reactions-layer" aria-hidden="true">
          {session.reactions.map((r) => (
            <span key={r.id} className="float-emoji" style={{ left: `${r.x}%` }}>
              {r.emoji}
            </span>
          ))}
        </div>
        {!chat && <ChatToasts messages={session.messages} selfUid={session.selfUid} />}

        {localPaused && (
          <div className="mini__paused">
            <span>Пауза только у тебя</span>
            <button type="button" className="btn btn--primary" onClick={onResume}>
              <Play size={14} /> В эфир
            </button>
          </div>
        )}
      </div>

      {chat && <MiniChat session={session} />}

      {picker && (
        <div className="mini__picker">
          {REACTIONS.map((emoji) => (
            <button key={emoji} type="button" onClick={() => session.react(emoji)} aria-label={`Реакция ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
      )}

      <nav className="mini__bar" aria-label="Управление">
        <IconButton
          label={session.micOn ? "Выключить микрофон" : "Включить микрофон"}
          tone={session.micOn ? "solid" : "glass"}
          size="sm"
          onClick={session.toggleMic}
        >
          {session.micOn ? <Mic size={16} /> : <MicOff size={16} />}
        </IconButton>
        <IconButton label="Реакции" tone={picker ? "active" : "glass"} size="sm" onClick={() => setPicker((v) => !v)}>
          <Smile size={16} />
        </IconButton>
        <IconButton label={chat ? "Скрыть чат" : "Показать чат"} tone={chat ? "active" : "glass"} size="sm" onClick={() => setChat((v) => !v)}>
          {chat ? <MessageCircle size={16} /> : <MessageCircleOff size={16} />}
        </IconButton>
        <span className="mini__spacer" />
        {confirmLeave ? (
          <button type="button" className="mini__leave" onClick={onLeave}>
            <PhoneOff size={14} /> Точно выйти?
          </button>
        ) : (
          <IconButton label="Выйти из комнаты" tone="danger" size="sm" onClick={() => setConfirmLeave(true)}>
            <PhoneOff size={16} />
          </IconButton>
        )}
      </nav>
    </div>
  );
}

/** Компактный чат: последние сообщения и поле ввода. Ответы и правка — в основной вкладке. */
function MiniChat({ session }: { session: RoomSession }) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState("");
  const messages = session.messages.slice(-60);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session.messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    session.sendChat(value);
    setText("");
    stick.current = true;
  };

  return (
    <div className="mini__chat">
      <div
        className="mini__messages"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 && <p className="mini__empty">Сообщений пока нет</p>}
        {messages.map((m) => {
          const mine = m.authorUid === session.selfUid;
          const reactions = Object.entries(m.reactions);
          return (
            <div key={m.id} className="mini-msg">
              <Avatar person={m} size={22} />
              <div className="mini-msg__body">
                <span className="mini-msg__name" style={{ color: mine ? undefined : m.color }}>
                  {mine ? "Вы" : m.name}
                </span>
                <span className="mini-msg__text">{m.text}</span>
                {reactions.length > 0 && (
                  <span className="mini-msg__reactions">
                    {reactions.map(([emoji, people]) => (
                      <span key={emoji}>
                        {emoji}
                        {people.length > 1 && <b>{people.length}</b>}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <form className="mini__composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Сообщение…" maxLength={1000} aria-label="Сообщение" />
        <button type="submit" aria-label="Отправить" disabled={!text.trim()}>
          <SendHorizontal size={16} />
        </button>
      </form>
    </div>
  );
}

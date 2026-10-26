import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, MessageCircleOff, Pencil, Reply, SendHorizontal, Smile, SmilePlus, X } from "lucide-react";
import { MESSAGE_REACTIONS, REACTIONS, type ChatMessage } from "../../shared/protocol.ts";
import { Avatar } from "./ui.tsx";

const time = (at: number) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** Сообщения подряд от одного автора в пределах пары минут склеиваются в группу. */
function groups(messages: ChatMessage[]): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last[0].authorUid === m.authorUid && !m.replyTo && m.at - last[last.length - 1].at < 120_000) last.push(m);
    else out.push([m]);
  }
  return out;
}

function myReaction(message: ChatMessage, selfUid: string): string | undefined {
  return Object.entries(message.reactions).find(([, list]) => list.some((r) => r.uid === selfUid))?.[0];
}

// ---------------------------------------------------------------- чат целиком

interface ChatAreaProps {
  variant: "portrait" | "panel";
  messages: ChatMessage[];
  selfUid: string;
  onSend(text: string, replyTo?: string): void;
  onEdit(id: string, text: string): void;
  onReactMessage(id: string, emoji: string): void;
  onFloatReaction(emoji: string): void;
  onFocusChange(focused: boolean): void;
}

/**
 * Лента + поле ввода + меню сообщения. Как в Telegram: долгое нажатие (или правый клик)
 * открывает меню с реакциями, «Ответить», «Изменить», «Копировать»; на компьютере
 * те же действия появляются кружками при наведении.
 */
export function ChatArea(props: ChatAreaProps) {
  const { messages, selfUid } = props;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [menu, setMenu] = useState<{ message: ChatMessage; rect: DOMRect } | null>(null);
  const [copied, setCopied] = useState(false);

  // Сообщение могли отредактировать или отреагировать на него, пока открыто меню / ответ.
  const fresh = (m: ChatMessage | null) => (m ? (messages.find((x) => x.id === m.id) ?? m) : null);

  const startReply = useCallback((m: ChatMessage) => {
    setEditing(null);
    setReplyTo(m);
  }, []);
  const startEdit = useCallback((m: ChatMessage) => {
    setReplyTo(null);
    setEditing(m);
  }, []);

  const copy = async (m: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(m.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // http в локальной сети — буфер обмена недоступен
    }
  };

  const lastOwn = [...messages].reverse().find((m) => m.authorUid === selfUid) ?? null;

  const list = (
    <ChatList
      messages={messages}
      selfUid={selfUid}
      activeId={menu?.message.id ?? null}
      onOpenMenu={(message, rect) => setMenu({ message, rect })}
      onReact={props.onReactMessage}
      onReply={startReply}
      onEdit={startEdit}
    />
  );
  const composer = (
    <Composer
      replyTo={fresh(replyTo)}
      editing={fresh(editing)}
      lastOwn={lastOwn}
      onCancelContext={() => {
        setReplyTo(null);
        setEditing(null);
      }}
      onEditLast={startEdit}
      onSend={(text) => {
        if (editing) {
          if (text !== editing.text) props.onEdit(editing.id, text);
          setEditing(null);
        } else {
          props.onSend(text, replyTo?.id);
          setReplyTo(null);
        }
      }}
      onReact={props.onFloatReaction}
      onFocusChange={props.onFocusChange}
    />
  );

  return (
    <>
      {props.variant === "portrait" ? <div className="portrait-chat">{list}</div> : list}
      {composer}
      {menu && (
        <MessageMenu
          rect={menu.rect}
          mine={menu.message.authorUid === selfUid}
          current={myReaction(fresh(menu.message)!, selfUid)}
          onClose={() => setMenu(null)}
          onReact={(emoji) => {
            props.onReactMessage(menu.message.id, emoji);
            setMenu(null);
          }}
          onReply={() => {
            startReply(menu.message);
            setMenu(null);
          }}
          onEdit={() => {
            startEdit(menu.message);
            setMenu(null);
          }}
          onCopy={() => {
            void copy(menu.message);
            setMenu(null);
          }}
        />
      )}
      {copied && createPortal(<div className="copied-toast">Скопировано</div>, document.body)}
    </>
  );
}

// ---------------------------------------------------------------- лента

function ChatList({
  messages,
  selfUid,
  activeId,
  onOpenMenu,
  onReact,
  onReply,
  onEdit,
}: {
  messages: ChatMessage[];
  selfUid: string;
  activeId: string | null;
  onOpenMenu(message: ChatMessage, rect: DOMRect): void;
  onReact(id: string, emoji: string): void;
  onReply(m: ChatMessage): void;
  onEdit(m: ChatMessage): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Если пользователь листает историю, новые сообщения его не дёргают.
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setPicker(null);
  };

  // При открытии клавиатуры высота меняется — держим низ ленты в поле зрения.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const jumpTo = (id: string) => {
    const target = ref.current?.querySelector(`[data-mid="${id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(id);
    window.setTimeout(() => setFlash(null), 1200);
  };

  // Долгое нажатие на телефоне открывает меню сообщения.
  const pressStart = (m: ChatMessage) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    const bubble = e.currentTarget;
    const timer = window.setTimeout(() => {
      press.current = null;
      navigator.vibrate?.(12);
      onOpenMenu(m, bubble.getBoundingClientRect());
    }, 420);
    press.current = { timer, x: e.clientX, y: e.clientY };
  };
  const pressMove = (e: PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) pressEnd();
  };
  const pressEnd = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  return (
    <div className="chat-list" ref={ref} onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="chat-empty">
          <MessageCircleOff size={18} />
          <span>Сообщения живут только во время просмотра и исчезнут, когда комната закроется</span>
        </div>
      ) : (
        groups(messages).map((group) => {
          const first = group[0];
          const mine = first.authorUid === selfUid;
          return (
            <div key={first.id} className={`msg-group${mine ? " msg-group--mine" : ""}`}>
              {!mine && <Avatar person={first} size={28} />}
              <div className="msg-group__body">
                <div className="msg-group__meta">
                  <span className="msg-group__name" style={{ color: mine ? undefined : first.color }}>
                    {mine ? "Вы" : first.name}
                  </span>
                  <span className="msg-group__time">{time(first.at)}</span>
                </div>
                {group.map((m) => {
                  const own = myReaction(m, selfUid);
                  const reactions = Object.entries(m.reactions);
                  return (
                    <div
                      key={m.id}
                      data-mid={m.id}
                      className={`msg${m.id === activeId ? " msg--active" : ""}${m.id === flash ? " msg--flash" : ""}`}
                    >
                      <div
                        className="bubble"
                        onPointerDown={pressStart(m)}
                        onPointerMove={pressMove}
                        onPointerUp={pressEnd}
                        onPointerCancel={pressEnd}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          pressEnd();
                          onOpenMenu(m, e.currentTarget.getBoundingClientRect());
                        }}
                      >
                        {m.replyTo && (
                          <button
                            type="button"
                            className="bubble__quote"
                            onClick={() => jumpTo(m.replyTo!.id)}
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <strong>{m.replyTo.name}</strong>
                            <span>{m.replyTo.text}</span>
                          </button>
                        )}
                        <span className="bubble__text">{m.text}</span>
                        {m.editedAt && <span className="bubble__edited">изменено</span>}
                      </div>

                      {reactions.length > 0 && (
                        <div className="msg__reactions">
                          {reactions.map(([emoji, people]) => (
                            <button
                              key={emoji}
                              type="button"
                              className={`reaction-chip${own === emoji ? " is-mine" : ""}`}
                              title={people.map((p) => p.name).join(", ")}
                              onClick={() => onReact(m.id, emoji)}
                            >
                              <span>{emoji}</span>
                              {people.length > 1 && <b>{people.length}</b>}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Компьютер: кружки действий при наведении — реакция, ответ, правка своего. */}
                      <div className={`msg__tools${picker === m.id ? " is-open" : ""}`}>
                        <button type="button" aria-label="Реакция" title="Реакция" onClick={() => setPicker(picker === m.id ? null : m.id)}>
                          <SmilePlus size={15} />
                        </button>
                        <button type="button" aria-label="Ответить" title="Ответить" onClick={() => onReply(m)}>
                          <Reply size={15} />
                        </button>
                        {mine && (
                          <button type="button" aria-label="Изменить" title="Изменить" onClick={() => onEdit(m)}>
                            <Pencil size={14} />
                          </button>
                        )}
                        {picker === m.id && (
                          <div className="msg__picker">
                            {MESSAGE_REACTIONS.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                className={own === emoji ? "is-mine" : ""}
                                onClick={() => {
                                  onReact(m.id, emoji);
                                  setPicker(null);
                                }}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------- меню сообщения

function MessageMenu({
  rect,
  mine,
  current,
  onClose,
  onReact,
  onReply,
  onEdit,
  onCopy,
}: {
  rect: DOMRect;
  mine: boolean;
  current?: string;
  onClose(): void;
  onReact(emoji: string): void;
  onReply(): void;
  onEdit(): void;
  onCopy(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Когда отпускаешь палец после долгого нажатия, браузер присылает «клик» — он попал бы
  // в фон и тут же закрыл меню (или нажал реакцию под пальцем). Первые полсекунды клики игнорируем.
  const openedAt = useRef(performance.now());
  const tooSoon = () => performance.now() - openedAt.current < 500;

  // Меню рядом с сообщением: снизу, если хватает места, иначе сверху; не вылезает за экран.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const left = Math.min(Math.max(8, mine ? rect.right - width : rect.left), vw - width - 8);
    const below = rect.bottom + 8;
    const top = below + height < vh - 8 ? below : Math.max(8, rect.top - height - 8);
    setPos({ left, top });
  }, [rect, mine]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="msg-menu-backdrop"
        onClick={() => !tooSoon() && onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!tooSoon()) onClose();
        }}
      />
      <div
        ref={ref}
        className="msg-menu"
        role="menu"
        onClickCapture={(e) => {
          if (tooSoon()) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
      >
        <div className="msg-menu__reactions">
          {MESSAGE_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className={current === emoji ? "is-mine" : ""} onClick={() => onReact(emoji)} aria-label={`Реакция ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
        <div className="msg-menu__actions">
          <button type="button" role="menuitem" onClick={onReply}>
            <Reply size={17} /> Ответить
          </button>
          {mine && (
            <button type="button" role="menuitem" onClick={onEdit}>
              <Pencil size={16} /> Изменить
            </button>
          )}
          <button type="button" role="menuitem" onClick={onCopy}>
            <Copy size={16} /> Копировать
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------- поле ввода

function Composer({
  replyTo,
  editing,
  lastOwn,
  onCancelContext,
  onEditLast,
  onSend,
  onReact,
  onFocusChange,
}: {
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  lastOwn: ChatMessage | null;
  onCancelContext(): void;
  onEditLast(m: ChatMessage): void;
  onSend(text: string): void;
  onReact(emoji: string): void;
  onFocusChange(focused: boolean): void;
}) {
  const [text, setText] = useState("");
  const [picker, setPicker] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const draft = useRef("");

  // Начали ответ или правку — фокус в поле; при правке подставляем текст сообщения.
  useEffect(() => {
    if (editing) {
      draft.current = text;
      setText(editing.text);
    }
    if (editing || replyTo) input.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, replyTo?.id]);

  const cancel = () => {
    if (editing) setText(draft.current);
    onCancelContext();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText(editing ? draft.current : "");
    // Как в мессенджере: клавиатура остаётся открытой, можно сразу писать следующее.
    input.current?.focus({ preventScroll: true });
  };

  // Кнопки рядом с полем не должны забирать у него фокус. Иначе на телефоне первое касание
  // только закрывает клавиатуру, раскладка прыгает, кнопка уезжает из-под пальца —
  // и сообщение отправляется лишь со второго раза. Отменяем именно mousedown: на нём браузер
  // меняет фокус, а отмена pointerdown в Safari гасит и сам клик.
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && (editing || replyTo)) {
      e.preventDefault();
      cancel();
    } else if (e.key === "ArrowUp" && !text && lastOwn && !editing) {
      // Как в Telegram Desktop: стрелка вверх в пустом поле — править своё последнее.
      e.preventDefault();
      onEditLast(lastOwn);
    }
  };

  const context = editing ?? replyTo;

  return (
    <div className="composer-wrap">
      {picker && (
        <div className="reaction-picker" role="toolbar" aria-label="Реакции">
          {REACTIONS.map((emoji) => (
            <button key={emoji} type="button" onClick={() => onReact(emoji)} aria-label={`Реакция ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      {context && (
        <div className="composer-context">
          {editing ? <Pencil size={16} /> : <Reply size={17} />}
          <div className="composer-context__text">
            <strong>{editing ? "Редактирование" : `Ответ ${context.name}`}</strong>
            <span>{context.text}</span>
          </div>
          <button type="button" aria-label="Отменить" onClick={cancel}>
            <X size={16} />
          </button>
        </div>
      )}
      <form className="composer" onSubmit={submit}>
        <button
          type="button"
          className={`composer__emoji${picker ? " is-on" : ""}`}
          aria-label="Реакции"
          aria-expanded={picker}
          onMouseDown={keepFocus}
          onClick={() => setPicker((v) => !v)}
        >
          <Smile size={20} />
        </button>
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setPicker(false);
            onFocusChange(true);
          }}
          onBlur={() => onFocusChange(false)}
          placeholder={editing ? "Измени сообщение…" : "Написать сообщение…"}
          maxLength={1000}
          enterKeyHint={editing ? "done" : "send"}
          autoComplete="off"
        />
        <button
          type="submit"
          className="composer__send"
          aria-label={editing ? "Сохранить" : "Отправить"}
          disabled={!text.trim()}
          onMouseDown={keepFocus}
        >
          {editing ? <Pencil size={17} /> : <SendHorizontal size={18} />}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- всплывающие сообщения

/**
 * Когда чат закрыт, новые сообщения на несколько секунд всплывают поверх видео
 * полупрозрачными плашками. Они не ловят нажатия и не мешают смотреть.
 */
export function ChatToasts({ messages, selfUid }: { messages: ChatMessage[]; selfUid: string }) {
  const [visible, setVisible] = useState<ChatMessage[]>([]);
  // Запоминаем id последнего показанного сообщения: длина истории перестаёт расти
  // после обрезки до 200, так что считать по длине нельзя.
  const lastSeen = useRef(messages[messages.length - 1]?.id);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    const index = messages.findIndex((m) => m.id === lastSeen.current);
    // Пачка сообщений без известной точки отсчёта — это загрузка истории при входе, её не всплываем.
    const historyLoad = index === -1 && messages.length > 1;
    const fresh = historyLoad ? [] : messages.slice(index + 1).filter((m) => m.authorUid !== selfUid);
    lastSeen.current = messages[messages.length - 1]?.id;
    if (!fresh.length) return;
    setVisible((list) => [...list, ...fresh].slice(-3));
    const ids = new Set(fresh.map((m) => m.id));
    timers.current.push(window.setTimeout(() => setVisible((list) => list.filter((m) => !ids.has(m.id))), 6000));
  }, [messages, selfUid]);

  if (!visible.length) return null;
  return (
    <div className="chat-toasts" aria-live="polite">
      {visible.map((m) => (
        <div key={m.id} className="chat-toast">
          <Avatar person={m} size={24} />
          <div>
            <span className="chat-toast__name" style={{ color: m.color }}>
              {m.name}
            </span>
            <span className="chat-toast__text">{m.text}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

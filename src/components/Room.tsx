import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ellipsis,
  Maximize,
  MessageCircle,
  Mic,
  MicOff,
  Minimize,
  MousePointerClick,
  Pause,
  PhoneOff,
  Play,
  Plus,
  Smile,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { REACTIONS, type Participant, type RoomInfo } from "../../shared/protocol.ts";
import { closeRoom } from "../api.ts";
import { isTouch, useAutoHide, useLayout, useWakeLock, type Layout } from "../hooks/useDevice.ts";
import { useHyperbeam } from "../hooks/useHyperbeam.ts";
import { useRoomSession, type Profile, type RoomSession } from "../hooks/useRoomSession.ts";
import {
  canFullscreenPage,
  enterPageFullscreen,
  enterVideoFullscreen,
  exitPageFullscreen,
  isPageFullscreen,
  onFullscreenChange,
  streamVideo,
} from "../lib/fullscreen.ts";
import { prepareOverlayFullscreen, type OverlayFeed, type OverlayPlayer } from "../lib/overlayFullscreen.ts";
import { load, save } from "../lib/storage.ts";
import { ChatArea, ChatToasts } from "./Chat.tsx";
import { InviteSheet, LeaveSheet, MoreSheet, type Settings } from "./Sheets.tsx";
import { Stage, type PlayerKey } from "./Stage.tsx";
import { Avatar, IconButton, Slider, plural } from "./ui.tsx";
import { PeoplePopover } from "./People.tsx";

interface Props {
  room: RoomInfo & { adminToken?: string };
  isHost: boolean;
  shareUrl: string;
  tunnel?: string;
  tunnelProtected?: boolean;
  profile: Profile;
  initialMic: boolean;
  onEnded(reason: string): void;
  onLeave(): void;
}

type SheetKind = "more" | "people" | "invite" | "leave" | null;

const DEFAULT_SETTINGS: Settings = { volume: 0.9, voiceVolume: 1, duck: true, chatAlpha: 0.42 };

function normalizeUrl(input: string): string {
  if (/^[a-z]+:\/\//i.test(input)) return input;
  if (/^[^\s]+\.[^\s]{2,}$/.test(input)) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

export function Room(props: Props) {
  const { room, isHost } = props;
  const deviceLayout = useLayout();
  useWakeLock(true);

  const session = useRoomSession(props.profile, props.initialMic, props.onEnded);
  const { participants, selfId, speaking, toast } = session;

  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...load("settings", {}) }));
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 1100 && !isTouch());
  const [sheet, setSheet] = useState<SheetKind>(null);
  // Пауза только у себя: картинка замирает, звук сайта выключается, остальные смотрят дальше.
  const [localPaused, setLocalPaused] = useState(false);
  const [picker, setPicker] = useState(false);
  // Режим «Управление» нужен только на сенсорных экранах — там он защищает от случайных касаний.
  // Мышью случайно не нажмёшь, поэтому на компьютере облачный браузер управляется всегда.
  const [touch] = useState(isTouch);
  const [controlMode, setControlMode] = useState(false);
  const [typing, setTyping] = useState(false);
  const [fullscreen, setFullscreen] = useState(isPageFullscreen);
  // В полноэкранном режиме — только видео: кадр по центру, управление поверх и прячется,
  // в каком бы положении ни был телефон.
  const layout: Layout = fullscreen ? "landscape" : deviceLayout;
  const [readUpTo, setReadUpTo] = useState<string | undefined>(undefined);
  const hbRef = useRef<HTMLDivElement>(null);

  const self = session.self;
  const canControl = isHost || (self ? self.canControl : room.options.guestControl);
  const controlActive = canControl && (!touch || controlMode);

  const { hb, state: streamState, rtt: hbRtt, retry: retryStream } = useHyperbeam(
    hbRef,
    room.demo
      ? null
      : {
          embedUrl: room.embedUrl,
          adminToken: room.adminToken,
          volume: settings.volume,
          onEnded: (reason) => {
            if (isHost) void closeRoom().catch(() => props.onEnded(reason));
            else props.onEnded(reason);
          },
          onWarning: (seconds) => seconds && toast(`Облачная сессия закроется через ${seconds} с`, "warn"),
          onNotice: (text) => toast(text, "warn"),
        },
  );

  // ---- связь Hyperbeam ↔ наше состояние

  useEffect(() => {
    if (hb && selfId) session.reportHyperbeamUser(hb.userId);
  }, [hb, selfId, session.reportHyperbeamUser]);

  const othersSpeaking = useMemo(() => [...speaking].some((id) => id !== selfId), [speaking, selfId]);

  useEffect(() => {
    if (!hb) return;
    hb.volume = localPaused ? 0 : settings.duck && othersSpeaking ? settings.volume * 0.35 : settings.volume;
  }, [hb, settings.volume, settings.duck, othersSpeaking, localPaused]);

  // Поток Hyperbeam — прямой эфир: на паузе кадры просто не принимаются, а после неё
  // показ сразу идёт с актуальной точки, без «догоняния».
  useEffect(() => {
    if (!hb) return;
    hb.videoPaused = localPaused;
    if (!localPaused) void streamVideo(hbRef.current)?.play().catch(() => {});
  }, [hb, localPaused]);

  useEffect(() => session.setVoiceVolume(settings.voiceVolume), [settings.voiceVolume, session.setVoiceVolume]);

  useEffect(() => {
    if (!canControl && controlMode) setControlMode(false);
  }, [canControl, controlMode]);

  useEffect(() => {
    if (hb) hb.disableInput = !controlActive;
  }, [hb, controlActive]);

  // На телефоне один раз подсказываем, как нажимать на сайте.
  useEffect(() => {
    if (!touch || !hb || !canControl || load("controlHintShown", false)) return;
    save("controlHintShown", true);
    toast("Чтобы нажимать на сайте, включи «Управление» — значок курсора");
  }, [touch, hb, canControl, toast]);

  // Пока набираешь сообщение, клавиатура не должна печатать в облачный браузер.
  useEffect(() => {
    if (hb) hb.delegateKeyboard = !typing;
  }, [hb, typing]);

  useEffect(() => save("settings", settings), [settings]);

  // Quick Tunnel мог переподключиться с новым адресом — старая ссылка у гостей больше не работает.
  // Сравниваем только публичные адреса: пока туннель переподключается, shareUrl ненадолго
  // становится адресом в Wi-Fi — это не повод говорить, что ссылка сменилась.
  const lastPublic = useRef(props.shareUrl.startsWith("https://") ? props.shareUrl : null);
  useEffect(() => {
    if (!isHost || !props.shareUrl.startsWith("https://") || props.shareUrl === lastPublic.current) return;
    const changed = lastPublic.current !== null;
    lastPublic.current = props.shareUrl;
    toast(
      changed ? "Адрес туннеля сменился — отправь новую ссылку (кнопка +)" : "Публичная ссылка готова — можно звать из любой сети",
      changed ? "warn" : "info",
    );
  }, [props.shareUrl, isHost, toast]);

  useEffect(() => {
    return onFullscreenChange(() => setFullscreen(isPageFullscreen()));
  }, []);

  // ---- непрочитанные (только когда чат спрятан)

  const lastId = session.messages[session.messages.length - 1]?.id;
  const chatVisible = layout === "portrait" || chatOpen;
  useEffect(() => {
    if (chatVisible) setReadUpTo(lastId);
  }, [chatVisible, lastId]);
  const unread = useMemo(() => {
    if (chatVisible) return 0;
    const index = session.messages.findIndex((m) => m.id === readUpTo);
    return session.messages.slice(index + 1).filter((m) => m.authorUid !== session.selfUid).length;
  }, [chatVisible, session.messages, readUpTo, session.selfUid]);

  // ---- слои управления

  // Слои поверх видео с автоскрытием — только у горизонтального телефона.
  // На компьютере панели стоят в чёрных полосах над и под видео и ничего не перекрывают.
  const overlayMode = layout === "landscape";
  // В вертикальном режиме прячутся только кнопки плеера поверх видео, шапка и чат остаются.
  const ui = useAutoHide(!sheet && !typing && !picker && streamState !== "connecting");

  // После поворота телефона сразу показываем управление, чтобы не гадать, куда нажимать.
  const showUi = ui.show;
  useEffect(() => showUi(), [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const pressKey = useCallback(
    (key: PlayerKey) => {
      if (!hb) return toast(room.demo ? "В демо-режиме клавиши плеера не работают" : "Трансляция ещё подключается");
      if (!canControl) return toast("Ведущий пока не дал тебе управление");
      const locked = hb.disableInput;
      if (locked) hb.disableInput = false;
      hb.sendEvent({ type: "keydown", key });
      window.setTimeout(() => {
        hb.sendEvent({ type: "keyup", key });
        if (locked) hb.disableInput = true;
      }, 40);
    },
    [hb, canControl, room.demo, toast],
  );

  const browser = useCallback(
    async (action: "back" | "forward" | "reload" | "reconnect" | { url: string }) => {
      if (!hb) return toast("Облачный браузер недоступен в демо-режиме");
      // Если видео застряло на спиннере, а сеть в порядке — пересоздаём медиасоединение с Hyperbeam.
      if (action === "reconnect") return retryStream();
      try {
        if (action === "back") await hb.tabs.goBack();
        else if (action === "forward") await hb.tabs.goForward();
        else if (action === "reload") await hb.tabs.reload();
        else await hb.tabs.update({ url: normalizeUrl(action.url) });
      } catch {
        toast("Браузер не выполнил команду", "error");
      }
    },
    [hb, toast, retryStream],
  );

  const toggleControl = () => {
    if (!canControl) return toast("Ведущий пока не дал тебе управление");
    setControlMode((v) => {
      toast(v ? "Режим просмотра: касания не попадают в браузер" : "Управление включено: касания идут в браузер");
      return !v;
    });
  };

  // iPhone: заранее готовим видео с наложенным чатом и реакциями для нативного полного экрана.
  // Safari разрешает открыть его только синхронно в момент нажатия — поэтому не в обработчике.
  const overlayRef = useRef<OverlayPlayer | null>(null);
  const feedRef = useRef<OverlayFeed>({ messages: [], reactions: [], selfUid: "" });
  feedRef.current = { messages: session.messages, reactions: session.reactions, selfUid: session.selfUid };
  useEffect(() => {
    if (!hb || streamState !== "playing" || canFullscreenPage()) return;
    let source: HTMLVideoElement | null = null;
    const prepare = () => {
      const video = streamVideo(hbRef.current);
      if (!video?.videoWidth || video === source) return;
      // кадры приходят чуть позже «playing», а после переподключения видео-элемент может смениться
      overlayRef.current?.dispose();
      source = video;
      overlayRef.current = prepareOverlayFullscreen(video, () => feedRef.current);
    };
    prepare();
    const timer = window.setInterval(prepare, 1500);
    return () => {
      clearInterval(timer);
      overlayRef.current?.dispose();
      overlayRef.current = null;
    };
  }, [hb, streamState]);

  // Что пауза только у тебя, объясняет плашка на видео — отдельный тост не нужен.
  const toggleLocalPause = () => setLocalPaused((paused) => !paused);

  const toggleFullscreen = async () => {
    try {
      if (isPageFullscreen()) return await exitPageFullscreen();
      // Android, iPad, компьютер: разворачиваем всю страницу — панели браузера пропадают.
      // Поворот не навязываем: картинка займёт экран в том положении, в каком держат телефон.
      if (canFullscreenPage()) return await enterPageFullscreen();
    } catch {
      // браузер отказал — пробуем видео-плеер ниже
    }
    // iPhone: Safari даёт полный экран только видео — открываем в нативном плеере iOS наше
    // видео с чатом и реакциями поверх кадра, а если оно не готово — исходное видео трансляции.
    const events = { onExit: ui.show, onPause: () => setLocalPaused(true), onPlay: () => setLocalPaused(false) };
    const overlay = overlayRef.current;
    if (overlay?.ready() && overlay.enter(events)) return;
    const video = streamVideo(hbRef.current);
    if (video && enterVideoFullscreen(video, events)) return;
    toast(
      room.demo
        ? "В демо-режиме нет видео для полного экрана"
        : "Полный экран не поддерживается — открой ссылку по https:// или добавь сайт на экран «Домой»",
      "warn",
    );
  };

  const leave = () => {
    setSheet(null);
    props.onLeave();
  };

  /** Ведущий закрывает без пароля, остальные — общим паролем. Ошибку покажет шторка. */
  const closeForAll = async (password?: string) => {
    await closeRoom(password);
    setSheet(null);
  };

  const react = (emoji: string) => {
    session.react(emoji);
    if (layout !== "portrait") setPicker(false);
  };

  const patchSettings = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const closeSheet = useCallback(() => setSheet(null), []);

  const roomStyle = { ["--chat-alpha" as string]: settings.chatAlpha };
  const classes = [
    "room",
    `room--${layout}`,
    overlayMode && !ui.visible ? "is-idle" : "",
    chatOpen ? "chat-open" : "",
    typing ? "is-typing" : "",
  ].join(" ");

  const chatProps = {
    messages: session.messages,
    selfUid: session.selfUid,
    onSend: session.sendChat,
    onEdit: session.editMessage,
    onReactMessage: session.reactMessage,
    onFloatReaction: session.react,
    onFocusChange: setTyping,
  };

  const stage = (
    <Stage
      hbRef={hbRef}
      demo={room.demo}
      streamState={streamState}
      controlMode={controlActive}
      showControlPill={touch}
      overlayVisible={ui.visible}
      reactions={session.reactions}
      onTap={ui.toggle}
      onKey={pressKey}
      onExitControl={() => setControlMode(false)}
      onRetry={retryStream}
      localPaused={localPaused}
      onResume={() => setLocalPaused(false)}
    >
      {layout === "portrait" && (
        <div className={`stage-corner${ui.visible ? " is-visible" : ""}`}>
          <IconButton label={localPaused ? "Продолжить" : "Пауза у себя"} size="sm" onClick={toggleLocalPause}>
            {localPaused ? <Play size={16} /> : <Pause size={16} />}
          </IconButton>
          <IconButton
            label={settings.volume === 0 ? "Включить звук" : "Выключить звук"}
            size="sm"
            onClick={() => patchSettings({ volume: settings.volume === 0 ? 0.9 : 0 })}
          >
            {settings.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </IconButton>
          {touch && (
            <IconButton label="Управление браузером" size="sm" tone={controlActive ? "active" : "glass"} onClick={toggleControl}>
              <MousePointerClick size={16} />
            </IconButton>
          )}
          <IconButton label="На весь экран" size="sm" onClick={toggleFullscreen}>
            <Maximize size={16} />
          </IconButton>
        </div>
      )}
    </Stage>
  );

  return (
    <div className={classes} style={roomStyle} onPointerMove={touch ? undefined : ui.show}>
      <TopBar
        layout={layout}
        session={session}
        isHost={isHost}
        streamState={room.demo ? "demo" : streamState}
        stream={room.stream}
        rtt={hbRtt ?? session.rtt}
        onPeople={() => setSheet("people")}
        onInvite={() => setSheet("invite")}
      />

      {/* Сцена всегда в одном и том же контейнере: при повороте телефона меняется только класс.
          Если бы React пересоздал её, Hyperbeam остался бы привязан к удалённому элементу — чёрный экран. */}
      <div className={layout === "portrait" ? "stage-slot" : "theater"}>{stage}</div>

      {layout === "portrait" ? (
        <>
          <ChatArea variant="portrait" {...chatProps} />
          <nav className="dock" aria-label="Управление">
            <IconButton
              label={session.micOn ? "Выключить микрофон" : "Включить микрофон"}
              tone={session.micOn ? "solid" : "glass"}
              onClick={session.toggleMic}
            >
              {session.micOn ? <Mic size={20} /> : <MicOff size={20} />}
            </IconButton>
            <button type="button" className="dock__people" onClick={() => setSheet("people")} aria-label="Участники">
              <AvatarRow participants={participants} speaking={speaking} max={4} size={34} />
            </button>
            <IconButton label="Ещё" onClick={() => setSheet("more")}>
              <Ellipsis size={20} />
            </IconButton>
            <IconButton label={isHost ? "Завершить" : "Выйти"} tone="danger" onClick={() => setSheet("leave")}>
              <PhoneOff size={20} />
            </IconButton>
          </nav>
        </>
      ) : (
        <>
          <div className="side-rail">
            <IconButton
              label="Чат"
              tone={chatOpen ? "active" : "glass"}
              badge={unread}
              onClick={() => setChatOpen((v) => !v)}
            >
              <MessageCircle size={20} />
            </IconButton>
            <IconButton label="Участники" onClick={() => setSheet("people")}>
              <Users size={20} />
            </IconButton>
          </div>

          {chatOpen && (
            <aside className="chat-panel" aria-label="Чат">
              <header className="chat-panel__head">
                <span>Чат</span>
                <IconButton label="Свернуть чат" tone="ghost" size="sm" onClick={() => setChatOpen(false)}>
                  <Minimize size={16} />
                </IconButton>
              </header>
              <ChatArea variant="panel" {...chatProps} />
            </aside>
          )}
          {!chatOpen && <ChatToasts messages={session.messages} selfUid={session.selfUid} />}

          <div className="control-bar">
            <div className="control-bar__group">
              <IconButton
                label={session.micOn ? "Выключить микрофон" : "Включить микрофон"}
                tone={session.micOn ? "solid" : "glass"}
                onClick={session.toggleMic}
              >
                {session.micOn ? <Mic size={20} /> : <MicOff size={20} />}
              </IconButton>
              <div className="picker-anchor">
                <IconButton label="Реакции" tone={picker ? "active" : "glass"} onClick={() => setPicker((v) => !v)}>
                  <Smile size={20} />
                </IconButton>
                {picker && (
                  <div className="reaction-picker reaction-picker--float">
                    {REACTIONS.map((emoji) => (
                      <button key={emoji} type="button" onClick={() => react(emoji)} aria-label={`Реакция ${emoji}`}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <IconButton label={localPaused ? "Продолжить" : "Пауза у себя"} tone={localPaused ? "active" : "glass"} onClick={toggleLocalPause}>
                {localPaused ? <Play size={20} /> : <Pause size={20} />}
              </IconButton>
              <div className="volume">
                <IconButton
                  label={settings.volume === 0 ? "Включить звук" : "Выключить звук"}
                  tone="ghost"
                  onClick={() => patchSettings({ volume: settings.volume === 0 ? 0.9 : 0 })}
                >
                  {settings.volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </IconButton>
                <Slider label="Громкость видео" value={settings.volume} onChange={(volume) => patchSettings({ volume })} />
              </div>
            </div>

            <button type="button" className="control-bar__people" onClick={() => setSheet("people")} aria-label="Участники">
              <AvatarRow participants={participants} speaking={speaking} max={5} size={38} />
            </button>

            <div className="control-bar__group">
              {touch && (
                <IconButton label="Управление браузером" tone={controlActive ? "active" : "glass"} onClick={toggleControl}>
                  <MousePointerClick size={20} />
                </IconButton>
              )}
              {layout === "desktop" && (
                <IconButton
                  label="Чат"
                  tone={chatOpen ? "active" : "glass"}
                  badge={unread}
                  onClick={() => setChatOpen((v) => !v)}
                >
                  <MessageCircle size={20} />
                </IconButton>
              )}
              <IconButton label={fullscreen ? "Свернуть" : "На весь экран"} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
              </IconButton>
              <IconButton label="Ещё" onClick={() => setSheet("more")}>
                <Ellipsis size={20} />
              </IconButton>
              <IconButton label={isHost ? "Завершить" : "Выйти"} tone="danger" onClick={() => setSheet("leave")}>
                <PhoneOff size={20} />
              </IconButton>
            </div>
          </div>
        </>
      )}

      {sheet === "more" && (
        <MoreSheet
          isHost={isHost}
          micOn={session.micOn}
          controlMode={controlActive}
          canControl={canControl}
          showControlToggle={touch}
          settings={settings}
          browserAvailable={!room.demo}
          onClose={closeSheet}
          onToggleMic={session.toggleMic}
          onToggleControl={toggleControl}
          onSettings={patchSettings}
          onNavigate={(url) => void browser({ url })}
          onBrowser={(a) => void browser(a)}
          onKey={pressKey}
          onLeave={() => setSheet("leave")}
        />
      )}
      {sheet === "people" && (
        <PeoplePopover
          participants={participants}
          selfId={selfId}
          isHost={isHost}
          speaking={speaking}
          onClose={closeSheet}
          onSetControl={session.setControl}
          onInvite={() => setSheet("invite")}
        />
      )}
      {sheet === "invite" && (
        <InviteSheet url={props.shareUrl} tunnel={props.tunnel} guarded={props.tunnelProtected} onClose={closeSheet} onCopied={() => toast("Ссылка скопирована")} />
      )}
      {sheet === "leave" && <LeaveSheet isHost={isHost} onClose={closeSheet} onLeave={leave} onCloseForAll={closeForAll} />}

      <div className="toasts" aria-live="polite">
        {session.toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone ?? "info"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- шапка

function TopBar(props: {
  layout: Layout;
  session: RoomSession;
  isHost: boolean;
  streamState: string;
  stream: RoomInfo["stream"];
  rtt: number | null;
  onPeople(): void;
  onInvite(): void;
}) {
  const { session } = props;
  const count = session.participants.length;
  const quality = props.rtt === null ? "ok" : props.rtt < 120 ? "good" : props.rtt < 260 ? "ok" : "bad";
  const live = props.streamState === "playing" || props.streamState === "demo";

  return (
    <header className="topbar">
      <button type="button" className="topbar__title" onClick={props.onPeople}>
        <strong>Совместный просмотр</strong>
        <span className="topbar__sub">
          <i className={`dot dot--${session.socketState === "open" ? "on" : "warn"}`} />
          {session.socketState === "open"
            ? `${count} ${plural(count, ["участник", "участника", "участников"])}`
            : "Переподключение…"}
        </span>
      </button>

      <div className="topbar__right">
        {props.stream && (
          <span className="quality-badge" title={`${props.stream.width}×${props.stream.height}, ${props.stream.fps} fps`}>
            {props.stream.height}p
          </span>
        )}
        <span className={`net net--${live ? quality : "bad"}`} title="Задержка до облачного браузера">
          <span className="net__bars">
            <i />
            <i />
            <i />
          </span>
          {props.streamState === "demo" ? "демо" : props.rtt !== null ? `${props.rtt} мс` : "…"}
        </span>
        {/* Адрес у всех общий, поэтому позвать друга может любой участник. */}
        <button type="button" className="avatar-stack" onClick={props.onPeople} aria-label="Участники">
          <AvatarRow participants={session.participants} speaking={session.speaking} max={3} size={30} />
          <span className="avatar-stack__plus" aria-label="Пригласить">
            <Plus size={16} />
          </span>
        </button>
      </div>
    </header>
  );
}

function AvatarRow({
  participants,
  speaking,
  max,
  size,
}: {
  participants: Participant[];
  speaking: Set<string>;
  max: number;
  size: number;
}) {
  const shown = participants.slice(0, max);
  const rest = participants.length - shown.length;
  return (
    <span className="avatar-row">
      {shown.map((p) => (
        <Avatar key={p.id} person={p} size={size} speaking={speaking.has(p.id)} showMic />
      ))}
      {rest > 0 && (
        <span className="avatar avatar--more" style={{ width: size, height: size, fontSize: size * 0.36 }}>
          +{rest}
        </span>
      )}
    </span>
  );
}

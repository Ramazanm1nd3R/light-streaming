import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Loader2, Lock, Mic, MicOff, Play, Tv } from "lucide-react";
import type { QualityMode, Region, RoomOptions, StatusResponse } from "../../shared/protocol.ts";
import type { Profile } from "../hooks/useRoomSession.ts";
import { load, save } from "../lib/storage.ts";
import { Avatar, Logo, Switch } from "./ui.tsx";

export const COLORS = ["#7c8cff", "#ff7aa8", "#ffb35c", "#5fd4a0", "#5cc8ff", "#c38bff", "#ff6b6b", "#e6e36a"];

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="screen">
      <div className="screen__glow" />
      <div className="screen__card">
        <div className="brand">
          <Logo size={30} />
          <span>Light Streaming</span>
        </div>
        {children}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- имя, цвет, микрофон

function useProfileState(fallbackName: string) {
  const saved = load<Profile | null>("profile", null);
  const [name, setName] = useState(saved?.name ?? "");
  const [color, setColor] = useState(saved?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [mic, setMic] = useState(load("micOnJoin", true));
  const commit = (): { profile: Profile; mic: boolean } => {
    const profile = { name: name.trim() || fallbackName, color };
    save("profile", profile);
    save("micOnJoin", mic);
    return { profile, mic };
  };
  return { name, setName, color, setColor, mic, setMic, commit };
}

function ProfileFields({ state, placeholder }: { state: ReturnType<typeof useProfileState>; placeholder: string }) {
  return (
    <>
      <div className="profile-row">
        <Avatar person={{ name: state.name || "?", color: state.color }} size={48} />
        <label className="field field--grow">
          <span>Как тебя показать остальным</span>
          <input
            value={state.name}
            onChange={(e) => state.setName(e.target.value)}
            maxLength={32}
            placeholder={placeholder}
            autoComplete="nickname"
          />
        </label>
      </div>
      <div className="swatches" role="radiogroup" aria-label="Цвет">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === state.color}
            aria-label={c}
            className={`swatch${c === state.color ? " is-on" : ""}`}
            style={{ background: c }}
            onClick={() => state.setColor(c)}
          />
        ))}
      </div>
      <button type="button" className={`mic-toggle${state.mic ? " is-on" : ""}`} onClick={() => state.setMic((v) => !v)}>
        {state.mic ? <Mic size={18} /> : <MicOff size={18} />}
        {state.mic ? "С включённым микрофоном" : "Без микрофона"}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- общая страница

/**
 * Единственная страница сервиса. Комната одна: если её нет — создаёшь,
 * если есть — входишь. Адрес знают только свои, поэтому отдельных приглашений нет.
 */
export function Lobby(props: {
  status: StatusResponse;
  onCreate(options: RoomOptions, profile: Profile, mic: boolean): Promise<void>;
  onJoin(profile: Profile, mic: boolean): void;
  onClose(password?: string): Promise<void>;
}) {
  const { status } = props;
  return (
    <Shell>
      {status.room ? <RoomCard {...props} /> : <CreateCard {...props} />}
      <ShareBox status={status} />
    </Shell>
  );
}

const PRESETS = [
  { label: "YouTube", url: "https://www.youtube.com" },
  { label: "Google", url: "https://www.google.com" },
  { label: "Twitch", url: "https://www.twitch.tv" },
  { label: "Кинопоиск", url: "https://www.kinopoisk.ru" },
];

const QUALITY: { value: QualityMode; label: string; hint: string }[] = [
  { value: "smooth", label: "Плавно", hint: "Лучше для аниме и фильмов" },
  { value: "sharp", label: "Чётко", hint: "Мелкий текст, ×3 трафика" },
  { value: "blocky", label: "Экономно", hint: "Для слабого интернета" },
];

function CreateCard({ status, onCreate }: Parameters<typeof Lobby>[0]) {
  const profile = useProfileState("Ведущий");
  const saved = load<Partial<RoomOptions>>("roomOptions", {});
  const [startUrl, setStartUrl] = useState(saved.startUrl ?? "https://www.youtube.com");
  const [quality, setQuality] = useState<QualityMode>(saved.quality ?? "smooth");
  const [region, setRegion] = useState<Region>(saved.region ?? status.defaults.region);
  const [fps, setFps] = useState<30 | 60>(saved.fps ?? 30);
  const [guestControl, setGuestControl] = useState(saved.guestControl ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const options: RoomOptions = { startUrl, quality, region, fps, guestControl };
    save("roomOptions", options);
    const { profile: p, mic } = profile.commit();
    setBusy(true);
    setError(null);
    try {
      await onCreate(options, p, mic);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="screen__title">Что смотрим сегодня?</h1>
      <p className="muted">Сейчас комнаты нет — создай её, и остальные смогут зайти по этой же ссылке.</p>

      {status.demo && (
        <div className="note note--accent">
          Демо-режим: ключ Hyperbeam не задан. Интерфейс, чат и голос работают, вместо браузера будет заглушка.
        </div>
      )}

      <form className="form" onSubmit={submit}>
        <ProfileFields state={profile} placeholder="Ведущий" />

        <label className="field">
          <span>Стартовая страница</span>
          <input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} inputMode="url" autoCapitalize="off" />
        </label>
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.url}
              type="button"
              className={`chip${startUrl === p.url ? " chip--on" : ""}`}
              onClick={() => setStartUrl(p.url)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <details className="disclosure">
          <summary>
            Настройки трансляции <ChevronDown size={16} />
          </summary>
          <div className="disclosure__body">
            <div className="field">
              <span>Качество картинки</span>
              <div className="segmented">
                {QUALITY.map((q) => (
                  <button key={q.value} type="button" className={quality === q.value ? "is-on" : ""} onClick={() => setQuality(q.value)}>
                    {q.label}
                  </button>
                ))}
              </div>
              <small className="muted">{QUALITY.find((q) => q.value === quality)?.hint}</small>
            </div>
            <div className="field-row">
              <div className="field">
                <span>Кадров в секунду</span>
                <div className="segmented">
                  {([30, 60] as const).map((v) => (
                    <button key={v} type="button" className={fps === v ? "is-on" : ""} onClick={() => setFps(v)}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span>Сервер</span>
                <div className="segmented">
                  {(["EU", "NA", "AS"] as const).map((v) => (
                    <button key={v} type="button" className={region === v ? "is-on" : ""} onClick={() => setRegion(v)}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="row row--plain">
              <span>
                Гости могут управлять браузером
                <small>Права можно менять прямо во время просмотра</small>
              </span>
              <Switch label="Гости могут управлять" checked={guestControl} onChange={setGuestControl} />
            </div>
          </div>
        </details>

        {error && <div className="note note--error">{error}</div>}

        <button type="submit" className="btn btn--primary btn--wide btn--lg" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
          {busy ? "Запускаю облачный браузер…" : "Создать комнату"}
        </button>
      </form>
    </>
  );
}

function minutesAgo(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин назад`;
}

function RoomCard({ status, onJoin, onClose }: Parameters<typeof Lobby>[0]) {
  const room = status.room!;
  const profile = useProfileState(status.isHost ? "Ведущий" : "Гость");
  const [closing, setClosing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = status.people;

  const join = (e: FormEvent) => {
    e.preventDefault();
    const { profile: p, mic } = profile.commit();
    onJoin(p, mic);
  };

  const close = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onClose(status.isHost ? undefined : password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="live-card">
        <span className="live-badge">
          <i className="dot dot--on" /> Идёт просмотр
        </span>
        <h1 className="screen__title">{status.isHost ? "Твоя комната открыта" : `${room.hostName} зовёт смотреть`}</h1>
        <p className="muted">
          Ведущий — {room.hostName} · открыта {minutesAgo(room.createdAt)}
        </p>
        <div className="live-card__people">
          {people.length ? (
            <>
              <span className="avatar-row">
                {people.slice(0, 6).map((p, i) => (
                  <Avatar key={i} person={p} size={32} />
                ))}
              </span>
              <span className="muted">{people.map((p) => p.name).join(", ")}</span>
            </>
          ) : (
            <span className="muted">Внутри пока никого нет</span>
          )}
        </div>
      </div>

      <form className="form" onSubmit={join}>
        <ProfileFields state={profile} placeholder={status.isHost ? "Ведущий" : "Твоё имя"} />
        <button type="submit" className="btn btn--primary btn--wide btn--lg">
          <Tv size={18} /> {status.isHost ? "Вернуться в комнату" : "Войти в комнату"}
        </button>
      </form>

      <div className="danger-zone">
        {!closing ? (
          <button type="button" className="link-button" onClick={() => setClosing(true)}>
            <Lock size={14} /> {status.isHost ? "Завершить комнату" : "Комната повисла? Закрыть её"}
          </button>
        ) : (
          <form className="form" onSubmit={close}>
            <p className="muted">
              {status.isHost
                ? "Облачный браузер выключится, у всех появится «Просмотр завершён»."
                : "Если ведущий вылетел и комната осталась открытой, её можно закрыть общим паролем."}
            </p>
            {!status.isHost && (
              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
              </label>
            )}
            {error && <div className="note note--error">{error}</div>}
            <div className="confirm">
              <button type="button" className="btn btn--glass" onClick={() => setClosing(false)}>
                Отмена
              </button>
              <button type="submit" className="btn btn--danger" disabled={busy || (!status.isHost && !password)}>
                {busy ? <Loader2 className="spin" size={16} /> : null} Закрыть комнату
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

/** Адрес, который можно отправить своим, — он же единственный вход в сервис. */
function ShareBox({ status }: { status: StatusResponse }) {
  const [copied, setCopied] = useState(false);
  const isPublic = status.shareUrl.startsWith("https://");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // буфер обмена недоступен (http в локальной сети) — адрес видно и так
    }
  };
  const via = status.tunnelProvider === "tailscale" ? "Tailscale Funnel" : "Cloudflare";
  const text =
    status.tunnel === "ready"
      ? status.tunnelProtected
        ? "Работает из любой сети, вход по коду из письма"
        : status.tunnelProvider === "cloudflare"
          ? "Работает из любой сети; адрес меняется при каждом запуске"
          : "Работает из любой сети; адрес постоянный"
      : status.tunnel === "starting"
        ? `Поднимаю публичный адрес через ${via}…`
        : "Пока только эта Wi-Fi сеть";
  return (
    <div className="share-box">
      <span className="share-box__label">Ссылка для своих</span>
      <button type="button" className="share-box__url" onClick={copy} title="Скопировать">
        <span>{status.shareUrl}</span>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <span className={`tunnel tunnel--${isPublic ? "ready" : status.tunnel}`}>{text}</span>
      {status.tunnelHint && <Hint text={status.tunnelHint} />}
    </div>
  );
}

/** Подсказка туннеля: ссылки в ней кликабельны (например, «разреши Funnel»). */
function Hint({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/\S+)/);
  return (
    <p className="note note--accent tunnel-hint">
      {parts.map((part, i) =>
        part.startsWith("https://") ? (
          <a key={i} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

// ---------------------------------------------------------------- статусы

export function StatusScreen({
  title,
  text,
  action,
  waiting,
}: {
  title: string;
  text: string;
  action?: { label: string; onClick(): void };
  waiting?: boolean;
}) {
  return (
    <Shell>
      <h1 className="screen__title center">{title}</h1>
      <p className="muted center">{text}</p>
      {waiting && (
        <p className="waiting">
          <Loader2 className="spin" size={16} /> Пробую переподключиться…
        </p>
      )}
      {action && (
        <button type="button" className="btn btn--primary btn--wide" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </Shell>
  );
}

export function Splash() {
  return (
    <main className="screen screen--splash">
      <Logo size={44} />
    </main>
  );
}

export function usePoll(active: boolean, fn: () => void, ms = 4000): void {
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(fn, ms);
    return () => clearInterval(timer);
  }, [active, fn, ms]);
}

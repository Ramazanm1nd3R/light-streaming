import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Globe,
  Keyboard,
  Lock,
  Mic,
  MicOff,
  MousePointerClick,
  PhoneOff,
  RefreshCw,
  RotateCw,
  Share2,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { PlayerKey } from "./Stage.tsx";
import { Sheet, Slider, Switch } from "./ui.tsx";

// ---------------------------------------------------------------- Меню

export interface Settings {
  volume: number;
  voiceVolume: number;
  duck: boolean;
  chatAlpha: number;
}

export function MoreSheet(props: {
  isHost: boolean;
  micOn: boolean;
  controlMode: boolean;
  canControl: boolean;
  showControlToggle: boolean;
  settings: Settings;
  browserAvailable: boolean;
  onClose(): void;
  onToggleMic(): void;
  onToggleControl(): void;
  onSettings(patch: Partial<Settings>): void;
  onNavigate(url: string): void;
  onBrowser(action: "back" | "forward" | "reload" | "reconnect"): void;
  onKey(key: PlayerKey): void;
  onLeave(): void;
}) {
  const { isHost, micOn, controlMode, canControl, settings } = props;
  const [url, setUrl] = useState("");
  const muted = settings.volume === 0;

  const go = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    props.onNavigate(url.trim());
    setUrl("");
    props.onClose();
  };

  return (
    <Sheet title="Управление" onClose={props.onClose}>
      <div className="quick-grid">
        <button type="button" className={`quick${micOn ? " quick--on" : ""}`} onClick={props.onToggleMic}>
          <span className="quick__icon">{micOn ? <Mic size={20} /> : <MicOff size={20} />}</span>
          <span className="quick__label">Микрофон</span>
          <span className="quick__state">{micOn ? "Вкл." : "Выкл."}</span>
        </button>
        <button
          type="button"
          className={`quick${muted ? "" : " quick--on"}`}
          onClick={() => props.onSettings({ volume: muted ? 0.8 : 0 })}
        >
          <span className="quick__icon">{muted ? <VolumeX size={20} /> : <Volume2 size={20} />}</span>
          <span className="quick__label">Звук видео</span>
          <span className="quick__state">{Math.round(settings.volume * 100)}%</span>
        </button>
        {props.showControlToggle && (
        <button
          type="button"
          className={`quick${controlMode ? " quick--on" : ""}`}
          onClick={props.onToggleControl}
          disabled={!canControl}
        >
          <span className="quick__icon">
            <MousePointerClick size={20} />
          </span>
          <span className="quick__label">Управление</span>
          <span className="quick__state">{!canControl ? "Нет прав" : controlMode ? "Вкл." : "Выкл."}</span>
        </button>
        )}
      </div>

      <div className="rows">
        <label className="row">
          <span>Громкость видео</span>
          <Slider label="Громкость видео" value={settings.volume} onChange={(volume) => props.onSettings({ volume })} />
        </label>
        <label className="row">
          <span>Громкость голосов</span>
          <Slider
            label="Громкость голосов"
            value={settings.voiceVolume}
            onChange={(voiceVolume) => props.onSettings({ voiceVolume })}
          />
        </label>
        <div className="row">
          <span>
            Приглушать видео, когда кто-то говорит
            <small>Чтобы не перекрикивать серию</small>
          </span>
          <Switch label="Приглушать видео" checked={settings.duck} onChange={(duck) => props.onSettings({ duck })} />
        </div>
        <label className="row">
          <span>
            Плотность фона чата
            <small>Меньше — сильнее видно видео за панелью</small>
          </span>
          <Slider
            label="Плотность фона чата"
            min={0}
            max={0.9}
            value={settings.chatAlpha}
            onChange={(chatAlpha) => props.onSettings({ chatAlpha })}
          />
        </label>
      </div>

      {props.browserAvailable && (
        <>
          <h3 className="sheet__section">Облачный браузер</h3>
          {/* Переходы, назад/вперёд, обновление и клавиши плеера меняют сайт у всех — только с правами.
              Переподключить видео можно всегда: это касается только своего видео. */}
          {canControl ? (
            <>
              <form className="urlbar" onSubmit={go}>
                <Globe size={16} />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Открыть ссылку или найти…"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  enterKeyHint="go"
                />
                <button type="submit" className="urlbar__go" disabled={!url.trim()}>
                  Открыть
                </button>
              </form>
              <div className="chips">
                <button type="button" className="chip" onClick={() => props.onBrowser("back")}>
                  <ArrowLeft size={15} /> Назад
                </button>
                <button type="button" className="chip" onClick={() => props.onBrowser("forward")}>
                  <ArrowRight size={15} /> Вперёд
                </button>
                <button type="button" className="chip" onClick={() => props.onBrowser("reload")}>
                  <RotateCw size={15} /> Обновить
                </button>
                <button type="button" className="chip" onClick={() => props.onBrowser("reconnect")}>
                  <RefreshCw size={15} /> Переподключить видео
                </button>
              </div>
              <div className="chips">
                <span className="chips__hint">
                  <Keyboard size={14} /> Клавиши плеера:
                </span>
                <button type="button" className="chip" onClick={() => props.onKey("f")}>
                  F — во весь кадр
                </button>
                <button type="button" className="chip" onClick={() => props.onKey("m")}>
                  M — звук
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="note">Открывать сайты, листать и управлять плеером может тот, кому ведущий дал управление.</p>
              <div className="chips">
                <button type="button" className="chip" onClick={() => props.onBrowser("reconnect")}>
                  <RefreshCw size={15} /> Переподключить видео
                </button>
              </div>
            </>
          )}
        </>
      )}

      <div className="sheet__footer">
        <button type="button" className="btn btn--danger btn--wide" onClick={props.onLeave}>
          <PhoneOff size={18} />
          {isHost ? "Выйти или завершить" : "Выйти"}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Выход

/**
 * Ведущий может выйти, оставив комнату открытой (пустая закроется сама), или завершить её.
 * Гость просто выходит — а если комната повисла, закрывает её общим паролем.
 */
export function LeaveSheet(props: {
  isHost: boolean;
  onClose(): void;
  onLeave(): void;
  onCloseForAll(password?: string): Promise<void>;
}) {
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeForAll = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onCloseForAll(props.isHost ? undefined : password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={props.isHost ? "Выйти из комнаты" : "Выйти из просмотра?"} onClose={props.onClose} className="sheet--small">
      <p className="muted">
        {props.isHost
          ? "Можно просто выйти — комната останется открытой, и ты вернёшься ведущим. Или завершить её для всех."
          : "Ты сможешь вернуться по той же ссылке, пока комната открыта."}
      </p>
      <div className="confirm confirm--stack">
        <button type="button" className="btn btn--glass" onClick={props.onClose}>
          Остаться
        </button>
        <button type="button" className={`btn ${props.isHost ? "btn--glass" : "btn--danger"}`} onClick={props.onLeave}>
          Выйти
        </button>
      </div>
      {props.isHost ? (
        <button type="button" className="btn btn--danger btn--wide" onClick={() => void closeForAll()} disabled={busy}>
          <PhoneOff size={16} /> Завершить для всех
        </button>
      ) : !askPassword ? (
        <button type="button" className="link-button" onClick={() => setAskPassword(true)}>
          <Lock size={14} /> Закрыть комнату для всех (нужен пароль)
        </button>
      ) : (
        <form className="form" onSubmit={closeForAll}>
          <label className="field">
            <span>Пароль комнаты</span>
            <input
              type="password"
              inputMode="numeric"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </label>
          <button type="submit" className="btn btn--danger btn--wide" disabled={busy || !password}>
            <PhoneOff size={16} /> Закрыть для всех
          </button>
        </form>
      )}
      {error && <div className="note note--error">{error}</div>}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Приглашение

export function InviteSheet({
  url,
  tunnel,
  guarded,
  onClose,
  onCopied,
}: {
  url: string | null;
  tunnel?: string;
  guarded?: boolean;
  onClose(): void;
  onCopied(): void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isPublic = Boolean(url && /^https:/.test(url));

  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#0b0d12", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [url]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const area = document.createElement("textarea");
      area.value = url;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    onCopied();
    window.setTimeout(() => setCopied(false), 1800);
  };

  const share = () => {
    if (url) void navigator.share?.({ title: "Light Streaming", text: "Смотрим вместе 🍿", url }).catch(() => {});
  };

  return (
    <Sheet title="Пригласить" onClose={onClose} className="sheet--invite">
      {!url ? (
        <p className="muted">Ссылка появится, как только комната будет готова…</p>
      ) : (
        <>
          {qr && <img className="qr" src={qr} alt="QR-код ссылки-приглашения" width={180} height={180} />}
          <p className="muted center">Наведи камеру телефона на код или отправь ссылку</p>
          <div className="invite-link">
            <span>{url}</span>
          </div>
          <div className="invite-actions">
            <button type="button" className="btn btn--primary" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Скопировано" : "Скопировать"}
            </button>
            {"share" in navigator && (
              <button type="button" className="btn btn--glass" onClick={share}>
                <Share2 size={16} /> Поделиться
              </button>
            )}
          </div>
          {isPublic && (
            <p className="note">
              {guarded
                ? "Ссылка работает из любой сети. Cloudflare попросит ввести код из письма — пустит только разрешённые email."
                : "Ссылка работает из любой сети, пока запущен сервер на ноутбуке."}
            </p>
          )}
          {!isPublic && (
            <p className="note">
              {tunnel === "starting"
                ? "Поднимаю публичный адрес через Cloudflare — через пару секунд ссылка обновится."
                : tunnel === "missing"
                  ? "Сейчас ссылка работает только в твоей Wi-Fi сети. Для доступа откуда угодно: brew install cloudflared и перезапусти сервер."
                  : "Ссылка работает только в локальной сети. Задай PUBLIC_URL или включи туннель."}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

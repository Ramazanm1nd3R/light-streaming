import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Crown, MicOff, X } from "lucide-react";
import type { Participant } from "../../shared/protocol.ts";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
}

export function Avatar({
  person,
  size = 36,
  speaking = false,
  showMic = false,
}: {
  person: Pick<Participant, "name" | "color"> & Partial<Pick<Participant, "micOn" | "isHost">>;
  size?: number;
  speaking?: boolean;
  showMic?: boolean;
}) {
  return (
    <span
      className={`avatar${speaking ? " avatar--speaking" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.38, ["--c" as string]: person.color }}
      title={person.name}
    >
      {initials(person.name)}
      {showMic && person.micOn === false && (
        <span className="avatar__badge" aria-label="Микрофон выключен">
          <MicOff size={Math.max(9, size * 0.28)} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

export function HostCrown() {
  return <Crown className="crown" size={14} strokeWidth={2.4} aria-label="Ведущий" />;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tone?: "glass" | "solid" | "danger" | "active" | "ghost";
  size?: "sm" | "md" | "lg";
  badge?: number | boolean;
};

export function IconButton({ label, tone = "glass", size = "md", badge, className = "", children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`ibtn ibtn--${tone} ibtn--${size} ${className}`}
      {...rest}
    >
      {children}
      {badge ? <span className="ibtn__badge">{typeof badge === "number" ? (badge > 9 ? "9+" : badge) : ""}</span> : null}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " switch--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

export function Slider({
  value,
  onChange,
  label,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  value: number;
  onChange(v: number): void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      className="slider"
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ["--pct" as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/**
 * Шторка. В вертикальном режиме выезжает снизу и занимает только нижнюю часть —
 * видео сверху остаётся видимым. В горизонтальном — компактная панель справа.
 * Фон за шторкой не затемняется: смотреть можно и с открытым меню.
 */
export function Sheet({ title, onClose, children, className = "" }: { title: string; onClose(): void; children: ReactNode; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-dismiss" onClick={onClose} />
      <section className={`sheet ${className}`} role="dialog" aria-label={title}>
        <div className="sheet__grip" />
        <header className="sheet__head">
          <h2>{title}</h2>
          <IconButton label="Закрыть" tone="ghost" size="sm" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="sheet__body">{children}</div>
      </section>
    </>
  );
}

/** Знак: кружка с паром и кнопкой воспроизведения — стриминг на чилле, с кофейком. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="ls-mug" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a7b3ff" />
          <stop offset="1" stopColor="#5a6bff" />
        </linearGradient>
      </defs>
      <g stroke="#ffd3ad" strokeWidth="1.7" strokeLinecap="round" fill="none">
        <path d="M11.2 9.8c-1.5-1.4 1.5-2.7 0-4.3" />
        <path d="M16.4 9.8c-1.5-1.4 1.5-2.7 0-4.3" />
      </g>
      <path d="M23.2 15.2h1.3a3.6 3.6 0 0 1 0 7.2h-1.3" stroke="url(#ls-mug)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <rect x="4" y="12" width="20" height="15.5" rx="5.5" fill="url(#ls-mug)" />
      <path d="M12.2 16.6v6.3c0 .65.72 1.05 1.27.7l4.95-3.15c.5-.32.5-1.08 0-1.4l-4.95-3.15c-.55-.35-1.27.05-1.27.7Z" fill="#fff" />
    </svg>
  );
}

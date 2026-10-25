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

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="lsg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fa2ff" />
          <stop offset="1" stopColor="#4d63ff" />
        </linearGradient>
      </defs>
      <rect x="2" y="6" width="28" height="20" rx="7" fill="url(#lsg)" />
      <path d="M13.5 11.8v8.4c0 .6.7 1 1.2.7l6.6-4.2c.5-.3.5-1.1 0-1.4l-6.6-4.2c-.5-.3-1.2.1-1.2.7Z" fill="#fff" />
    </svg>
  );
}

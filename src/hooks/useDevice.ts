import { useEffect, useState } from "react";

export type Layout = "portrait" | "landscape" | "desktop";

function current(): Layout {
  const portrait = window.matchMedia("(orientation: portrait)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (portrait && window.innerWidth < 900) return "portrait";
  if (coarse || window.innerHeight < 560) return "landscape";
  return "desktop";
}

/**
 * Три режима интерфейса:
 *  portrait  — телефон вертикально: видео сверху, чат живёт в свободном месте под ним, ничего не перекрывает;
 *  landscape — телефон горизонтально: видео на весь экран, всё остальное — полупрозрачные слои, которые прячутся;
 *  desktop   — большой экран: чат можно закрепить сбоку, видео при этом ужимается, а не перекрывается.
 */
export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(current);
  useEffect(() => {
    const update = () => setLayout(current());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return layout;
}

export const isTouch = () => window.matchMedia("(pointer: coarse)").matches;

/**
 * Реальная видимая высота. На iPhone при открытой клавиатуре 100vh не меняется,
 * а visualViewport — меняется: так поле ввода не уезжает под клавиатуру, а видео не прыгает.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
      if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);
}

/** Экран не гаснет во время просмотра (iOS 16.4+, Chrome). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch {
        // батарея на исходе или нет разрешения — не страшно
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [active]);
}

/** Слои управления прячутся, если пользователь ничего не трогает. */
export function useAutoHide(enabled: boolean, delay = 3500) {
  const [visible, setVisible] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), delay);
    return () => clearTimeout(timer);
  }, [enabled, visible, tick, delay]);

  return {
    visible,
    show: () => {
      setVisible(true);
      setTick((t) => t + 1);
    },
    hide: () => setVisible(false),
    toggle: () => setVisible((v) => !v),
  };
}

// Полноэкранный режим во всех браузерах.
//
// Android, iPad и компьютеры поддерживают Fullscreen API для любого элемента — разворачиваем
// всю страницу, и пропадают панели браузера. iPhone так не умеет: Safari разрешает полный
// экран только видео-элементу (нативный плеер iOS). Hyperbeam рисует картинку в обычном
// <video> внутри shadow DOM контейнера — его и отдаём нативному плееру: открывается в любом
// положении телефона, без панелей Safari, с кнопкой «картинка в картинке».

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export type IosVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: string) => void;
};

const doc = document as WebkitDocument;

export function canFullscreenPage(): boolean {
  return Boolean(document.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

export function isPageFullscreen(): boolean {
  return Boolean(document.fullscreenElement || doc.webkitFullscreenElement);
}

export async function enterPageFullscreen(): Promise<void> {
  const root = document.documentElement as WebkitElement;
  if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
  else await root.webkitRequestFullscreen?.();
}

export async function exitPageFullscreen(): Promise<void> {
  if (document.exitFullscreen) await document.exitFullscreen();
  else await doc.webkitExitFullscreen?.();
}

export function onFullscreenChange(listener: () => void): () => void {
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);
  return () => {
    document.removeEventListener("fullscreenchange", listener);
    document.removeEventListener("webkitfullscreenchange", listener);
  };
}

/** <video> облачного браузера, если Hyperbeam рисует через него (в Safari по http бывает canvas). */
export function streamVideo(container: HTMLElement | null): IosVideo | null {
  return (container?.shadowRoot?.querySelector("video") as IosVideo | null) ?? null;
}

/**
 * Нативный полный экран iOS для исходного видео трансляции (запасной путь, если видео
 * с наложенным чатом не готово). Паузу здесь с паузой у себя не связываем: SDK Hyperbeam
 * сам сразу запускает своё видео снова, и пауза с продолжением начинали бы бороться.
 * После выхода iOS может поставить видео на паузу — сразу продолжаем показ.
 */
export function enterVideoFullscreen(video: IosVideo, onExit: () => void): boolean {
  if (!video.webkitEnterFullscreen) return false;
  const resume = () => {
    void video.play().catch(() => {});
    onExit();
  };
  video.addEventListener("webkitendfullscreen", resume, { once: true });
  video.webkitEnterFullscreen();
  return true;
}

// Мини-плеер «картинка в картинке».
//
// Chrome и Edge на компьютере умеют Document Picture-in-Picture: окно поверх всех окон, в котором
// можно показать любую разметку, — туда идёт видео, мини-чат, реакции, микрофон и выход.
// Остальные браузеры (Safari, телефоны) выносят в такое окно только <video> — для них есть
// видео с нарисованными поверх кадра сообщениями и реакциями (overlayFullscreen.ts).

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

type PipVideo = HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void };

export const documentPip = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

export function canDocumentPip(): boolean {
  return Boolean(documentPip);
}

export function canVideoPip(): boolean {
  return Boolean(document.pictureInPictureEnabled) || typeof (HTMLVideoElement.prototype as PipVideo).webkitSetPresentationMode === "function";
}

/** Окно мини-плеера — пустой документ: переносим туда стили страницы, чтобы работали наши классы. */
export function copyStyles(target: Document): void {
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = target.createElement("style");
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      target.head.appendChild(style);
    } catch {
      // стиль с другого домена (шрифты Google) — правила не прочитать, подключаем ссылкой
      if (!sheet.href) continue;
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      target.head.appendChild(link);
    }
  }
}

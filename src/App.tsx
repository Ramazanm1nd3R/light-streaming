import { useCallback, useEffect, useState } from "react";
import type { RoomOptions, StatusResponse } from "../shared/protocol.ts";
import { closeRoom, createRoom, fetchStatus } from "./api.ts";
import { useViewportHeight } from "./hooks/useDevice.ts";
import type { Profile } from "./hooks/useRoomSession.ts";
import { Room } from "./components/Room.tsx";
import { Lobby, Splash, StatusScreen, usePoll } from "./components/Screens.tsx";

type Phase =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "lobby" }
  | { kind: "joined"; profile: Profile; mic: boolean; roomId: string }
  | { kind: "ended"; reason: string };

export function App() {
  useViewportHeight();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus();
      setStatus(next);
      setPhase((p) => (p.kind === "loading" || p.kind === "offline" ? { kind: "lobby" } : p));
      return next;
    } catch {
      setPhase((p) => (p.kind === "joined" ? p : { kind: "offline" }));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // На общей странице список участников живой; в комнате — держим свежим адрес туннеля.
  const inRoom = phase.kind === "joined";
  usePoll(phase.kind !== "loading", refresh, inRoom ? 8000 : 3000);

  const room = status?.room ?? null;

  // Комнату закрыли, пока мы были внутри (а сокет этого не заметил) — возвращаемся.
  useEffect(() => {
    if (phase.kind === "joined" && status && (!room || room.id !== phase.roomId)) {
      setPhase({ kind: "ended", reason: "Комната закрыта" });
    }
  }, [phase, status, room]);

  const create = async (options: RoomOptions, profile: Profile, mic: boolean) => {
    try {
      const created = await createRoom({ ...options, hostName: profile.name });
      await refresh();
      // Клик «Создать» уже был жестом пользователя — можно сразу в комнату, звук разрешён.
      setPhase({ kind: "joined", profile, mic, roomId: created.id });
    } catch (err) {
      // Кто-то успел создать комнату раньше — общая страница покажет её.
      await refresh();
      throw err;
    }
  };

  const join = (profile: Profile, mic: boolean) => {
    if (room) setPhase({ kind: "joined", profile, mic, roomId: room.id });
  };

  const close = async (password?: string) => {
    await closeRoom(password);
    await refresh();
  };

  const onEnded = useCallback(
    (reason: string) => {
      setPhase({ kind: "ended", reason });
      void refresh();
    },
    [refresh],
  );

  if (phase.kind === "loading" || (!status && phase.kind !== "offline")) return <Splash />;

  if (phase.kind === "offline" || !status) {
    return <StatusScreen title="Нет связи" text="Ноутбук с сервисом выключен или пропал интернет." waiting />;
  }

  if (phase.kind === "joined" && room && room.id === phase.roomId) {
    return (
      <Room
        key={room.id}
        room={room}
        isHost={status.isHost}
        shareUrl={status.shareUrl}
        tunnel={status.tunnel}
        tunnelProtected={status.tunnelProtected}
        profile={phase.profile}
        initialMic={phase.mic}
        onEnded={onEnded}
        onLeave={() => setPhase({ kind: "lobby" })}
      />
    );
  }

  if (phase.kind === "ended") {
    return (
      <StatusScreen
        title="Просмотр завершён"
        text={phase.reason}
        action={{ label: room ? "Открыта новая комната — перейти" : "На главную", onClick: () => setPhase({ kind: "lobby" }) }}
      />
    );
  }

  return <Lobby status={status} onCreate={create} onJoin={join} onClose={close} />;
}

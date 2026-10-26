import { useEffect } from "react";
import { UserPlus } from "lucide-react";
import type { Participant } from "../../shared/protocol.ts";
import { Avatar, HostCrown, Switch, plural } from "./ui.tsx";

/**
 * Список участников выпадает сверху, из шапки, — полупрозрачный и без затемнения:
 * видео и чат остаются видны. Внизу — кнопка, чтобы позвать ещё кого-то.
 */
export function PeoplePopover(props: {
  participants: Participant[];
  selfId: string;
  isHost: boolean;
  speaking: Set<string>;
  onClose(): void;
  onSetControl(id: string, value: boolean): void;
  onInvite(): void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = [...props.participants].sort((a, b) => Number(b.isHost) - Number(a.isHost) || a.joinedAt - b.joinedAt);
  const count = props.participants.length;

  return (
    <>
      <div className="people-pop-dismiss" onClick={onClose} />
      <section className="people-pop" role="dialog" aria-label="Участники">
        <header className="people-pop__head">
          В комнате · {count} {plural(count, ["участник", "участника", "участников"])}
        </header>
        <ul className="people-pop__list">
          {sorted.map((p) => {
            const talking = props.speaking.has(p.id);
            return (
              <li key={p.id} className="person">
                <Avatar person={p} size={36} speaking={talking} showMic />
                <div className="person__info">
                  <span className="person__name">
                    {p.name}
                    {p.id === props.selfId && <em> (вы)</em>}
                    {p.isHost && <HostCrown />}
                  </span>
                  <span className="person__status">
                    {talking ? "Говорит" : p.micOn ? "Микрофон включён" : "Микрофон выключен"}
                    {!p.isHost && (p.canControl ? " · может управлять" : " · только смотрит")}
                  </span>
                </div>
                {props.isHost && !p.isHost && (
                  <Switch label={`Управление для ${p.name}`} checked={p.canControl} onChange={(v) => props.onSetControl(p.id, v)} />
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" className="people-pop__invite" onClick={props.onInvite}>
          <UserPlus size={17} /> Добавить участника
        </button>
      </section>
    </>
  );
}

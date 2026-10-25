import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "../api.ts";
import { Realtime, type SocketState } from "../lib/realtime.ts";
import { SELF_SPEAKER, Voice } from "../lib/voice.ts";
import { load, save } from "../lib/storage.ts";
import type { ChatMessage, Participant, ServerMessage } from "../../shared/protocol.ts";

export interface Profile {
  name: string;
  color: string;
}

export interface FloatingReaction {
  id: number;
  emoji: string;
  x: number;
}

export interface Toast {
  id: number;
  text: string;
  tone?: "info" | "warn" | "error";
}

let seq = 0;

/** Секретный ключ этого браузера: по нему сервер узнаёт автора сообщений и после переподключения. */
function clientKey(): string {
  let key = load<string | null>("clientKey", null);
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    key = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
    save("clientKey", key);
  }
  return key;
}

export function useRoomSession(profile: Profile, initialMic: boolean, onEnded: (reason: string) => void) {
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [selfId, setSelfId] = useState("");
  const [selfUid, setSelfUid] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [micOn, setMicOn] = useState(false);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [rtt, setRtt] = useState<number | null>(null);

  const rtRef = useRef<Realtime | null>(null);
  const voiceRef = useRef<Voice | null>(null);
  const micRef = useRef(false);
  const selfRef = useRef("");
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++seq;
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3600);
  }, []);

  const spawnReaction = useCallback((emoji: string) => {
    const id = ++seq;
    setReactions((list) => [...list.slice(-24), { id, emoji, x: 8 + Math.random() * 84 }]);
    window.setTimeout(() => setReactions((list) => list.filter((r) => r.id !== id)), 2600);
  }, []);

  useEffect(() => {
    const voice = new Voice({
      signal: (to, data) => rtRef.current?.send({ t: "signal", to, data }),
      speaking: (ids) => setSpeaking(ids),
      micError: (message) => toast(message, "error"),
    });
    voice.unlockAudio();
    voiceRef.current = voice;

    const handle = (msg: ServerMessage) => {
      switch (msg.t) {
        case "welcome":
          selfRef.current = msg.selfId;
          setSelfId(msg.selfId);
          setSelfUid(msg.selfUid);
          setParticipants(msg.participants);
          setMessages(msg.history);
          voice.reset(msg.selfId, msg.ice.iceServers);
          for (const p of msg.participants) if (p.id !== msg.selfId) voice.connectTo(p.id);
          break;
        case "joined":
          setParticipants((list) => [...list.filter((p) => p.id !== msg.participant.id), msg.participant]);
          toast(`${msg.participant.name} подключился`);
          break;
        case "left":
          setParticipants((list) => {
            const gone = list.find((p) => p.id === msg.id);
            if (gone) toast(`${gone.name} вышел`);
            return list.filter((p) => p.id !== msg.id);
          });
          voice.removePeer(msg.id);
          break;
        case "updated":
          setParticipants((list) => list.map((p) => (p.id === msg.participant.id ? msg.participant : p)));
          break;
        case "chat":
          setMessages((list) => [...list.slice(-199), msg.message]);
          break;
        case "chat-update":
          setMessages((list) => list.map((m) => (m.id === msg.message.id ? msg.message : m)));
          break;
        case "reaction":
          spawnReaction(msg.emoji);
          break;
        case "signal":
          void voice.handleSignal(msg.from, msg.data);
          break;
        case "room-ended":
          onEndedRef.current(msg.reason);
          break;
        case "pong":
          setRtt(Math.round(performance.now() - msg.at));
          break;
        case "error":
          toast(msg.message, "error");
          break;
      }
    };

    const rt = new Realtime(
      wsUrl(),
      () => ({ t: "hello", name: profile.name, color: profile.color, micOn: micRef.current, key: clientKey() }),
      handle,
      setSocketState,
    );
    rtRef.current = rt;

    if (initialMic) {
      void voice.setMic(true).then((on) => {
        micRef.current = on;
        setMicOn(on);
        rt.send({ t: "mic", on });
      });
    }

    return () => {
      rt.close();
      voice.destroy();
      rtRef.current = null;
      voiceRef.current = null;
    };
    // Профиль фиксируется при входе в комнату.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMic = useCallback(async () => {
    const voice = voiceRef.current;
    if (!voice) return;
    voice.unlockAudio();
    const on = await voice.setMic(!micRef.current);
    micRef.current = on;
    setMicOn(on);
    rtRef.current?.send({ t: "mic", on });
  }, []);

  const sendChat = useCallback((text: string, replyTo?: string) => {
    rtRef.current?.send({ t: "chat", text, replyTo });
  }, []);

  const editMessage = useCallback((id: string, text: string) => {
    rtRef.current?.send({ t: "edit", id, text });
  }, []);

  const reactMessage = useCallback((id: string, emoji: string) => {
    rtRef.current?.send({ t: "react", id, emoji });
  }, []);

  const react = useCallback(
    (emoji: string) => {
      rtRef.current?.send({ t: "reaction", emoji });
    },
    [],
  );

  const setControl = useCallback((participantId: string, canControl: boolean) => {
    rtRef.current?.send({ t: "set-control", participantId, canControl });
  }, []);

  const reportHyperbeamUser = useCallback((hbUserId: string) => {
    rtRef.current?.send({ t: "hb-user", hbUserId });
  }, []);

  const setVoiceVolume = useCallback((v: number) => voiceRef.current?.setVolume(v), []);

  // Индикатор речи хранит "self" для себя — переводим в реальный id.
  const speakingIds = useMemo(() => {
    const ids = new Set(speaking);
    if (ids.delete(SELF_SPEAKER) && selfId) ids.add(selfId);
    return ids;
  }, [speaking, selfId]);

  const self = participants.find((p) => p.id === selfId) ?? null;

  return {
    socketState,
    selfId,
    selfUid,
    self,
    participants,
    messages,
    speaking: speakingIds,
    micOn,
    reactions,
    toasts,
    rtt,
    toast,
    toggleMic,
    sendChat,
    editMessage,
    reactMessage,
    react,
    setControl,
    reportHyperbeamUser,
    setVoiceVolume,
  };
}

export type RoomSession = ReturnType<typeof useRoomSession>;

import type { SignalData } from "../../shared/protocol.ts";

/**
 * Голосовой канал: P2P mesh на WebRTC (для 2–4 человек сервер не нужен вовсе).
 * Сигнализация идёт через наш WebSocket, медиа — напрямую между устройствами.
 *
 * Схема:
 *  • у каждой пары один аудио-transceiver, микрофон подставляется через replaceTrack —
 *    включение/выключение микрофона не требует пересогласования;
 *  • когда микрофон выключен, трек останавливается полностью: на iPhone это возвращает
 *    аудиосессию в режим воспроизведения, и звук видео снова звучит в полном качестве;
 *  • «perfect negotiation» снимает гонки офферов, ICE restart чинит связь после смены сети.
 */

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  restartTimer: number | undefined;
}

export interface VoiceEvents {
  signal(to: string, data: SignalData): void;
  speaking(ids: Set<string>): void;
  micError(message: string): void;
}

const SELF = "self";
const SPEAKING_THRESHOLD = 0.035;

export class Voice {
  private peers = new Map<string, Peer>();
  private localTrack: MediaStreamTrack | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private ctx: AudioContext | null = null;
  private meterTimer: number | undefined;
  private speaking = new Set<string>();
  private outputVolume = 1;
  private selfId = "";
  private iceServers: RTCIceServer[] = [];

  constructor(private readonly events: VoiceEvents) {}

  /** Вызывать из обработчика нажатия: iOS разрешает звук только после жеста пользователя. */
  unlockAudio(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    }
    void this.ctx.resume();
    if (this.meterTimer === undefined) this.meterTimer = window.setInterval(() => this.measure(), 120);
  }

  reset(selfId: string, iceServers: RTCIceServer[]): void {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.selfId = selfId;
    this.iceServers = iceServers;
  }

  /** Новичок сам звонит всем, кто уже в комнате. */
  connectTo(peerId: string): void {
    if (peerId === this.selfId || this.peers.has(peerId)) return;
    const peer = this.createPeer(peerId);
    const transceiver = peer.pc.addTransceiver("audio", { direction: "sendrecv" });
    void this.attachTrack(transceiver.sender);
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    const peer = this.peers.get(from) ?? this.createPeer(from);
    const { pc } = peer;
    try {
      if (data.kind === "description") {
        const description = data.description;
        const collision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          // Отвечающая сторона тоже отправляет свой голос в том же transceiver.
          for (const t of pc.getTransceivers()) {
            if (t.receiver.track.kind === "audio" && t.direction !== "sendrecv") t.direction = "sendrecv";
            await this.attachTrack(t.sender);
          }
          await pc.setLocalDescription();
          this.events.signal(from, { kind: "description", description: pc.localDescription!.toJSON() });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn("[voice] signal", err);
    }
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    clearTimeout(peer.restartTimer);
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.peers.delete(peerId);
    this.speaking.delete(peerId);
  }

  async setMic(on: boolean): Promise<boolean> {
    if (!on) {
      this.localTrack?.stop();
      this.localTrack = null;
      this.localAnalyser = null;
      await this.forEachSender((s) => s.replaceTrack(null));
      return false;
    }
    if (this.localTrack) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.localTrack = stream.getAudioTracks()[0];
      this.localTrack.contentHint = "speech";
      this.localAnalyser = this.makeAnalyser(new MediaStream([this.localTrack]));
      await this.forEachSender((s) => this.attachTrack(s));
      return true;
    } catch (err) {
      const name = (err as DOMException).name;
      this.events.micError(
        name === "NotAllowedError"
          ? "Нет доступа к микрофону — разреши его в настройках браузера"
          : location.protocol !== "https:" && location.hostname !== "localhost"
            ? "Микрофон работает только по HTTPS — открой публичную ссылку"
            : "Не удалось включить микрофон",
      );
      return false;
    }
  }

  setVolume(volume: number): void {
    this.outputVolume = volume;
    // На iOS громкость <audio> задаётся только кнопками телефона — там это no-op.
    for (const peer of this.peers.values()) peer.audio.volume = volume;
  }

  destroy(): void {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.localTrack?.stop();
    clearInterval(this.meterTimer);
    void this.ctx?.close();
  }

  // ---------- внутреннее ----------

  private createPeer(peerId: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.volume = this.outputVolume;
    document.body.appendChild(audio);

    const peer: Peer = {
      pc,
      polite: this.selfId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      audio,
      analyser: null,
      restartTimer: undefined,
    };
    this.peers.set(peerId, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.events.signal(peerId, { kind: "description", description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn("[voice] negotiation", err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => this.events.signal(peerId, { kind: "candidate", candidate: candidate?.toJSON() ?? null });
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      peer.analyser = this.makeAnalyser(stream);
    };
    pc.onconnectionstatechange = () => {
      clearTimeout(peer.restartTimer);
      if (pc.connectionState === "failed") {
        pc.restartIce();
      } else if (pc.connectionState === "disconnected") {
        // Короткий обрыв (смена сети) часто проходит сам — даём шанс, потом рестарт ICE.
        peer.restartTimer = window.setTimeout(() => pc.restartIce(), 3000);
      }
    };
    return peer;
  }

  private async attachTrack(sender: RTCRtpSender): Promise<void> {
    await sender.replaceTrack(this.localTrack);
    if (!this.localTrack) return;
    try {
      // Голос важнее картинки: просим браузер приоритизировать аудио при перегрузке сети.
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].priority = "high";
      params.encodings[0].networkPriority = "high";
      params.encodings[0].maxBitrate = 48_000;
      await sender.setParameters(params);
    } catch {
      // не все браузеры позволяют — не критично
    }
  }

  private async forEachSender(fn: (sender: RTCRtpSender) => Promise<void>): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const peer of this.peers.values()) {
      for (const t of peer.pc.getTransceivers()) {
        if (t.receiver.track.kind === "audio" && t.currentDirection !== "stopped") tasks.push(fn(t.sender));
      }
    }
    await Promise.allSettled(tasks);
  }

  private makeAnalyser(stream: MediaStream): AnalyserNode | null {
    if (!this.ctx) return null;
    try {
      const source = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  private level(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.sqrt(sum / data.length);
  }

  private measure(): void {
    const next = new Set<string>();
    if (this.localTrack?.enabled && this.level(this.localAnalyser) > SPEAKING_THRESHOLD) next.add(SELF);
    for (const [id, peer] of this.peers) {
      if (this.level(peer.analyser) > SPEAKING_THRESHOLD) next.add(id);
    }
    const changed = next.size !== this.speaking.size || [...next].some((id) => !this.speaking.has(id));
    if (changed) {
      this.speaking = next;
      this.events.speaking(new Set(next));
    }
  }
}

export const SELF_SPEAKER = SELF;

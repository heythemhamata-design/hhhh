"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ApexLiveVoiceState = "idle" | "listening" | "thinking" | "speaking";

type LiveVoiceSession = {
  socket: WebSocket;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  mute: GainNode;
  activeSources: Set<AudioBufferSourceNode>;
  playbackCursor: number;
  turnComplete: boolean;
  stopped: boolean;
  ready: boolean;
  readyTimer: number | null;
  rejectReady: (error: Error) => void;
};

const LIVE_VOICE_URL = "ws://127.0.0.1:8020/live?lang=ar-DZ";
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const READY_TIMEOUT_MS = 25_000;

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "لم يُسمح باستعمال الميكروفون. اسمح بالوصول إليه من إعدادات الموقع ثم أعد المحاولة.";
  }
  if (error instanceof Error) return error.message.slice(0, 240);
  return "تعذّر تشغيل الاتصال الصوتي.";
}

export function useApexLiveVoice() {
  const [state, setState] = useState<ApexLiveVoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<LiveVoiceSession | null>(null);
  const startingRef = useRef(false);
  const generationRef = useRef(0);

  const cleanupSession = useCallback((session: LiveVoiceSession, sendClose: boolean) => {
    if (session.stopped) return;

    if (!session.ready) {
      session.rejectReady(new Error("Voice session closed before it became ready."));
    }

    session.stopped = true;
    if (session.readyTimer !== null) {
      window.clearTimeout(session.readyTimer);
      session.readyTimer = null;
    }

    if (sendClose && session.socket.readyState === WebSocket.OPEN) {
      try {
        session.socket.send(JSON.stringify({ type: "close" }));
      } catch {
        // The socket may already be closing; local resource cleanup still proceeds.
      }
    }

    try {
      if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
        session.socket.close(1000, "APEX voice stopped");
      }
    } catch {
      // Ignore close races.
    }

    session.processor.onaudioprocess = null;
    try { session.source.disconnect(); } catch { /* already disconnected */ }
    try { session.processor.disconnect(); } catch { /* already disconnected */ }
    try { session.mute.disconnect(); } catch { /* already disconnected */ }

    for (const source of session.activeSources) {
      try { source.stop(); } catch { /* source already ended */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    session.activeSources.clear();

    for (const track of session.stream.getTracks()) track.stop();
    if (session.context.state !== "closed") {
      void session.context.close().catch(() => undefined);
    }

    if (sessionRef.current === session) sessionRef.current = null;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    const session = sessionRef.current;
    if (session) cleanupSession(session, true);
    setState("idle");
  }, [cleanupSession]);

  const start = useCallback(async () => {
    if (startingRef.current || sessionRef.current) return;

    startingRef.current = true;
    const generation = ++generationRef.current;
    setError(null);
    setState("thinking");

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let session: LiveVoiceSession | null = null;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("المتصفح لا يدعم الوصول إلى الميكروفون. افتح MONSTER عبر localhost.");
      }

      // Start both operations directly from the user's click so browser activation is retained.
      context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
      const resumePromise = context.resume();
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: INPUT_SAMPLE_RATE },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // Await the microphone first so a later AudioContext resume failure cannot
      // leave a successfully opened MediaStream unassigned and therefore unclosed.
      stream = await streamPromise;
      await resumePromise;

      if (generationRef.current !== generation) {
        for (const track of stream.getTracks()) track.stop();
        await context.close();
        return;
      }

      if (context.sampleRate !== INPUT_SAMPLE_RATE) {
        throw new Error(`المتصفح فتح AudioContext بمعدل ${context.sampleRate}Hz؛ المطلوب 16000Hz.`);
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(1024, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;

      const socket = new WebSocket(LIVE_VOICE_URL);
      socket.binaryType = "arraybuffer";

      let resolveReady!: () => void;
      let rejectReady!: (reason: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      session = {
        socket,
        stream,
        context,
        source,
        processor,
        mute,
        activeSources: new Set<AudioBufferSourceNode>(),
        playbackCursor: context.currentTime,
        turnComplete: false,
        stopped: false,
        ready: false,
        readyTimer: null,
        rejectReady,
      };
      sessionRef.current = session;

      const playPcmChunk = (data: ArrayBuffer) => {
        if (!session || session.stopped || data.byteLength < 2 || data.byteLength % 2 !== 0) return;

        const frameCount = data.byteLength / 2;
        const view = new DataView(data);
        const samples = new Float32Array(frameCount);
        for (let i = 0; i < frameCount; i += 1) {
          samples[i] = view.getInt16(i * 2, true) / 32768;
        }

        // Gemini Live returns raw 16-bit little-endian PCM at 24 kHz (no WAV header).
        const audioBuffer = session.context.createBuffer(1, frameCount, OUTPUT_SAMPLE_RATE);
        audioBuffer.copyToChannel(samples, 0);
        const player = session.context.createBufferSource();
        player.buffer = audioBuffer;
        player.connect(session.context.destination);

        const playAt = Math.max(session.playbackCursor, session.context.currentTime + 0.015);
        session.playbackCursor = playAt + audioBuffer.duration;
        session.activeSources.add(player);
        player.onended = () => {
          session?.activeSources.delete(player);
          try { player.disconnect(); } catch { /* already disconnected */ }
          if (session && !session.stopped && session.turnComplete && session.activeSources.size === 0) {
            setState("listening");
          }
        };
        player.start(playAt);
        setState("speaking");
      };

      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          playPcmChunk(event.data);
          return;
        }

        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then(playPcmChunk).catch(() => {
            setError("تعذّرت قراءة حزمة الصوت الواردة.");
          });
          return;
        }

        if (typeof event.data !== "string") return;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }

        switch (payload.type) {
          case "ready":
            if (session && !session.ready) {
              session.ready = true;
              if (session.readyTimer !== null) {
                window.clearTimeout(session.readyTimer);
                session.readyTimer = null;
              }
              resolveReady();
            }
            break;

          case "input_transcript":
            if (payload.final === true) {
              if (session) session.turnComplete = false;
              setState("thinking");
            }
            break;

          case "output_transcript":
            setState("speaking");
            break;

          case "interrupted":
            if (session) {
              session.turnComplete = false;
              session.playbackCursor = session.context.currentTime;
              for (const player of session.activeSources) {
                try { player.stop(); } catch { /* already ended */ }
              }
              session.activeSources.clear();
            }
            setState("listening");
            break;

          case "turn_complete":
            if (session) {
              session.turnComplete = true;
              if (session.activeSources.size === 0) setState("listening");
            }
            break;

          case "error": {
            const detail = typeof payload.message === "string"
              ? payload.message.slice(0, 240)
              : "Voice server returned an error.";
            setError(detail);
            if (!session?.ready) {
              rejectReady(new Error(detail));
            } else if (session) {
              cleanupSession(session, true);
              setState("idle");
            }
            break;
          }
        }
      };

      socket.onerror = () => {
        const failure = new Error("تعذّر الاتصال بخادم Gemini Live على 127.0.0.1:8020.");
        if (!session?.ready) {
          rejectReady(failure);
        } else if (session) {
          setError(failure.message);
          cleanupSession(session, true);
          setState("idle");
        }
      };

      socket.onclose = () => {
        if (!session || session.stopped) return;
        if (!session.ready) rejectReady(new Error("Voice WebSocket closed before ready."));
        cleanupSession(session, false);
        setError("انقطع اتصال خادم الصوت.");
        setState("idle");
      };

      session.readyTimer = window.setTimeout(() => {
        if (session && !session.ready) {
          rejectReady(new Error("انتهت مهلة الاتصال بخادم Gemini Live (25 ثانية)."));
        }
      }, READY_TIMEOUT_MS);

      await readyPromise;

      if (generationRef.current !== generation || session.stopped) {
        cleanupSession(session, true);
        return;
      }

      processor.onaudioprocess = (audioEvent: AudioProcessingEvent) => {
        if (session?.stopped || socket.readyState !== WebSocket.OPEN) return;

        const input = audioEvent.inputBuffer.getChannelData(0);
        const pcm = new ArrayBuffer(input.length * 2);
        const view = new DataView(pcm);

        for (let i = 0; i < input.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[i]));
          view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }

        try {
          socket.send(pcm);
        } catch {
          setError("تعذّر إرسال الصوت إلى خادم Gemini Live.");
          if (session) {
            cleanupSession(session, false);
            setState("idle");
          }
        }
      };

      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      setState("listening");
    } catch (caught) {
      if (session) {
        cleanupSession(session, true);
      } else {
        if (stream) for (const track of stream.getTracks()) track.stop();
        if (context && context.state !== "closed") {
          await context.close().catch(() => undefined);
        }
      }

      if (generationRef.current === generation) {
        setError(errorMessage(caught));
        setState("idle");
      }
    } finally {
      startingRef.current = false;
    }
  }, [cleanupSession]);

  useEffect(() => () => {
    generationRef.current += 1;
    const session = sessionRef.current;
    if (session) cleanupSession(session, true);
  }, [cleanupSession]);

  return { state, error, start, stop };
}

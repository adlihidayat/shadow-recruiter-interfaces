"use client";

import React, { useEffect, useState, useRef, use } from "react";
import styles from "./page.module.css";

export default function InterviewPage({ params }: { params: Promise<{ room_id: string }> }) {
  const { room_id } = use(params);
  const [status, setStatus] = useState<"idle" | "validating" | "ready" | "connecting" | "connected" | "error">("idle");
  const [agentState, setAgentState] = useState<"LISTENING" | "PROCESSING" | "AI_SPEAKING" | "IDLE" | "EVAL">("IDLE");
  const [jwt, setJwt] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // VAD state
  const isSpeakingRef = useRef<boolean>(false);
  const silenceStartRef = useRef<number>(0);
  const SILENCE_THRESHOLD = -50; // dB
  const SILENCE_DURATION = 1500; // ms to trigger SILENCE_DETECTED

  useEffect(() => {
    const validateRoom = async () => {
      setStatus("validating");
      try {
        // Updated route to /session/
        const res = await fetch(`http://localhost:8000/api/v1/session/${room_id}/validate`);
        if (res.ok) {
          const data = await res.json();
          if (data.valid && data.token) {
            setJwt(data.token);
            setStatus("ready");
          } else {
            setStatus("error");
          }
        } else {
          setStatus("error");
        }
      } catch (err) {
        console.error("Validation error:", err);
        setStatus("error");
      }
    };
    validateRoom();

    return () => {
      cleanup();
    };
  }, [room_id]);

  const cleanup = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (currentSourceRef.current) {
      currentSourceRef.current.stop();
      currentSourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const playNextInQueue = async () => {
    if (isPlayingRef.current || playbackQueueRef.current.length === 0) return;
    
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;

    isPlayingRef.current = true;
    const chunk = playbackQueueRef.current.shift();
    if (!chunk) {
      isPlayingRef.current = false;
      return;
    }

    try {
      const audioBuffer = await audioCtx.decodeAudioData(chunk);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      currentSourceRef.current = source;

      source.onended = () => {
        currentSourceRef.current = null;
        isPlayingRef.current = false;
        if (playbackQueueRef.current.length > 0) {
          playNextInQueue();
        }
      };
      source.start(0);
    } catch (err) {
      console.error("Error decoding audio data:", err);
      isPlayingRef.current = false;
      playNextInQueue();
    }
  };

  const handleAbortPlayback = () => {
    playbackQueueRef.current = [];
    if (currentSourceRef.current) {
      currentSourceRef.current.onended = null;
      currentSourceRef.current.stop();
      currentSourceRef.current = null;
    }
    isPlayingRef.current = false;
  };

  const startInterview = async () => {
    if (!jwt) return;
    setStatus("connecting");

    try {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Setup Analyser for VAD
      const source = audioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);
      
      // Start VAD Loop
      requestAnimationFrame(vadLoop);

      // Setup WebSocket with session route
      const ws = new WebSocket(`ws://localhost:8000/api/v1/session/${room_id}?token=${jwt}`);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            
            // Handle State Broadcasts from Server
            if (data.type === "STATE_CHANGE") {
              setAgentState(data.state);
              if (data.state === "LISTENING") {
                handleAbortPlayback(); // Just in case
              }
            }
            
            if (data.type === "CONTROL") {
              if (data.action === "SESSION_READY") {
                setStatus("connected");
                startRecording();
              } else if (data.action === "TTS_DONE") {
                // Server tells us AI is done speaking
              }
            }
          } catch (e) {
            console.error("WS Text Error:", e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          playbackQueueRef.current.push(event.data);
          playNextInQueue();
        }
      };

      ws.onclose = () => setStatus("error");
      ws.onerror = () => setStatus("error");

    } catch (err) {
      console.error("Start Error:", err);
      setStatus("error");
    }
  };

  const vadLoop = () => {
    if (!analyserRef.current || status !== "connected") {
      requestAnimationFrame(vadLoop);
      return;
    }

    const dataArray = new Float32Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getFloatTimeDomainData(dataArray);
    
    // Calculate RMS volume
    let sumSquares = 0.0;
    for (const amplitude of dataArray) {
      sumSquares += amplitude * amplitude;
    }
    const volume = 20 * Math.log10(Math.sqrt(sumSquares / dataArray.length));

    const isCurrentlySpeaking = volume > SILENCE_THRESHOLD;

    if (isCurrentlySpeaking) {
      if (!isSpeakingRef.current) {
        isSpeakingRef.current = true;
        console.log("Speech Started");
        // BARGE_IN during AI_SPEAKING or PROCESSING
        if (agentState === "AI_SPEAKING" || agentState === "PROCESSING") {
          wsRef.current?.send(JSON.stringify({ type: "BARGE_IN" }));
          handleAbortPlayback();
        }
      }
      silenceStartRef.current = 0;
    } else {
      if (isSpeakingRef.current) {
        if (silenceStartRef.current === 0) {
          silenceStartRef.current = Date.now();
        } else if (Date.now() - silenceStartRef.current > SILENCE_DURATION) {
          isSpeakingRef.current = false;
          silenceStartRef.current = 0;
          console.log("Silence Detected");
          if (agentState === "LISTENING") {
            wsRef.current?.send(JSON.stringify({ type: "SILENCE_DETECTED" }));
          }
        }
      }
    }

    requestAnimationFrame(vadLoop);
  };

  const startRecording = () => {
    if (!mediaStreamRef.current || !wsRef.current) return;
    mediaRecorderRef.current = new MediaRecorder(mediaStreamRef.current, { mimeType: "audio/webm" });
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN && !isMicMuted) {
        wsRef.current.send(event.data);
      }
    };
    mediaRecorderRef.current.start(250);
  };

  const toggleMic = () => {
    setIsMicMuted((prev) => {
      const newState = !prev;
      mediaStreamRef.current?.getAudioTracks().forEach(track => track.enabled = !newState);
      return newState;
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.mainArea}>
        <div className={`${styles.participantBox} ${agentState === "AI_SPEAKING" ? styles.speaking : ""}`}>
          <div className={styles.avatar}>🤖</div>
          <div className={styles.nameTag}>AI Recruiter</div>
          <div className={styles.statusTag}>
            {status === "connected" ? agentState : status}
          </div>
        </div>
      </div>
      
      <div className={styles.controls}>
        {status !== "connected" && status !== "connecting" && (
          <button 
            className={`${styles.btn} ${styles.startBtn}`}
            onClick={startInterview}
            disabled={status !== "ready"}
          >
            {status === "validating" ? "Validating Room..." : 
             status === "idle" ? "Waiting..." : 
             status === "error" ? "Connection Error" : "Start Interview"}
          </button>
        )}

        {status === "connecting" && (
          <button className={`${styles.btn} ${styles.startBtn}`} disabled>
            Connecting...
          </button>
        )}

        {status === "connected" && (
          <>
            <button 
              className={`${styles.micBtn} ${!isMicMuted ? styles.active : ''}`}
              onClick={toggleMic}
            >
              {isMicMuted ? "🔇" : "🎙️"}
            </button>
            <button className={`${styles.btn} ${styles.endBtn}`} onClick={cleanup}>
              End Call
            </button>
          </>
        )}
      </div>
    </div>
  );
}

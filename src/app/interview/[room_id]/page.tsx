"use client";

import React, { useEffect, useState, useRef, use } from "react";
import styles from "./page.module.css";

export default function InterviewPage({ params }: { params: Promise<{ room_id: string }> }) {
  const { room_id } = use(params);
  const [status, setStatus] = useState<"idle" | "validating" | "ready" | "connecting" | "connected" | "error">("idle");
  const [agentState, setAgentState] = useState<"listening" | "speaking" | "waiting">("waiting");
  const [jwt, setJwt] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    // Step 1: Validate room and get JWT when user visits page
    const validateRoom = async () => {
      setStatus("validating");
      try {
        const res = await fetch(`http://localhost:8000/api/v1/interview/${room_id}/validate`);
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
    setAgentState("speaking");

    const chunk = playbackQueueRef.current.shift();
    if (!chunk) {
      isPlayingRef.current = false;
      return;
    }

    try {
      // Decode the raw binary chunk. 
      // Note: This expects complete playable chunks like full wav files or mp3 chunks.
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
        } else {
          setAgentState("listening");
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
    // Clear playback queue
    playbackQueueRef.current = [];
    
    // Stop current playback
    if (currentSourceRef.current) {
      currentSourceRef.current.onended = null;
      currentSourceRef.current.stop();
      currentSourceRef.current = null;
    }
    
    isPlayingRef.current = false;
    setAgentState("listening");
  };

  const startInterview = async () => {
    if (!jwt) return;
    setStatus("connecting");

    try {
      // Setup Audio Context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Request Microphone Permissions
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Setup WebSocket
      const ws = new WebSocket(`ws://localhost:8000/api/v1/interview/${room_id}?token=${jwt}`);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        console.log("WebSocket connected");
        // Wait for SESSION_READY before sending audio
      };

      ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "SESSION_READY") {
              setStatus("connected");
              setAgentState("listening");
              startRecording();
            } else if (data.type === "CONTROL" && data.action === "abort_playback") {
              handleAbortPlayback();
            }
          } catch (e) {
            console.error("Failed to parse WebSocket message:", e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          // Received binary audio chunk from server
          playbackQueueRef.current.push(event.data);
          playNextInQueue();
        }
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        setStatus("error");
        cleanup();
      };
      
      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setStatus("error");
        cleanup();
      };

    } catch (err) {
      console.error("Failed to start interview:", err);
      setStatus("error");
    }
  };

  const startRecording = () => {
    if (!mediaStreamRef.current || !wsRef.current) return;
    
    // We send audio in small intervals.
    // Some implementations use MediaRecorder, but sending raw chunks depends on the backend.
    // The backend uses silero-vad, so WebM/Opus blobs are standard for modern browsers.
    // If raw PCM is strictly required, AudioWorklet/ScriptProcessor is needed, but MediaRecorder is usually accepted.
    mediaRecorderRef.current = new MediaRecorder(mediaStreamRef.current, { mimeType: 'audio/webm' });
    
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN && !isMicMuted) {
        wsRef.current.send(event.data);
      }
    };
    
    // Send chunk every 250ms
    mediaRecorderRef.current.start(250);
  };

  const toggleMic = () => {
    setIsMicMuted((prev) => {
      const newState = !prev;
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach(track => {
          track.enabled = !newState;
        });
      }
      return newState;
    });
  };

  const endInterview = () => {
    cleanup();
    setStatus("idle");
    setAgentState("waiting");
  };

  return (
    <div className={styles.container}>
      <div className={styles.mainArea}>
        <div className={`${styles.participantBox} ${agentState === 'speaking' ? styles.speaking : ''}`}>
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
              title={isMicMuted ? "Unmute" : "Mute"}
            >
              {isMicMuted ? '🔇' : '🎙️'}
            </button>
            <button 
              className={`${styles.btn} ${styles.endBtn}`}
              onClick={endInterview}
            >
              End Call
            </button>
          </>
        )}
      </div>
    </div>
  );
}

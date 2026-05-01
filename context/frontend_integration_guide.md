# Shadow Recruiter: Frontend Integration Guide

This guide is designed to be given to the Antigravity frontend agent to explain exactly how to communicate with the Shadow Recruiter Python Backend.

## 💻 Local Development Architecture
**Yes, you can absolutely develop and test this entirely locally!**
You do NOT need to deploy to a real server yet. You can run both the FastAPI server and the Next.js/Vite frontend on `localhost`. 
- **Backend Base URL**: `http://localhost:3000`
- **WebSocket Base URL**: `ws://localhost:3000`

---

## 🔗 The Connection Flow

### Step 1: Room Validation & JWT Fetch
When the user navigates to `/interview/{room_id}`, before connecting to the microphone, the frontend must validate the room.

**Request:**
`GET http://localhost:3000/api/v1/interview/{room_id}/validate`

**Success Response (200 OK):**
```json
{
  "valid": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5c..."
}
```
*Note: This JWT expires in exactly 60 seconds. Do not fetch it until the user is actually on the page.*

### Step 2: Establish the WebSocket
Once the user clicks "Start Interview" (and grants microphone permissions), open a WebSocket connection passing the JWT as a query parameter.

**Connection URL:**
`ws://localhost:3000/api/v1/interview/{room_id}?token={jwt}`

**Listen for Handshake:**
Do not start sending audio immediately. Listen for the server to emit the initialization JSON:
```json
{
  "type": "SESSION_READY",
  "message": "Audio pipeline and agent are ready."
}
```

---

## 🎙️ Audio Streaming Protocol (CRITICAL RULES)

### 1. Sending Audio (Client -> Server)
- **Protocol**: Standard WebSockets over TCP. **Do NOT attempt to use WebRTC.**
- **Format**: Send raw binary chunks (e.g., `Blob` or `ArrayBuffer` from the microphone).
- **No JSON Wrapping**: Do not wrap outgoing audio in JSON (e.g., `{"audio": "base64..."}`). The backend strictly calls `websocket.receive_bytes()`. Send the raw binary frames directly into the socket.

### 2. Receiving Audio (Server -> Client)
- **Format**: The server will stream TTS generated audio back down the WebSocket.
- **Playback**: You will need to queue and play these incoming binary audio chunks sequentially in the browser using the Web Audio API (`AudioContext`).

### 3. Barge-in / Interruption (Server -> Client)
If the user starts speaking while the AI is talking, the server's Voice Activity Detection (VAD) will trigger an interruption.
- The server will immediately stop sending audio bytes.
- The server will send a JSON control signal down the WebSocket:
```json
{
  "type": "CONTROL",
  "action": "abort_playback"
}
```
- **Frontend Action**: When you receive `abort_playback`, you must immediately clear the frontend audio playback queue, stop the current `AudioBufferSourceNode`, and transition the UI back to a "Listening..." state.

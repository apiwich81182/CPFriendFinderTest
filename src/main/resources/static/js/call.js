(() => {
  "use strict";
  /* ------------------------------------------------------------------
   * Signaling layout
   *  - STOMP (Spring /ws): friend-call INVITE/ACCEPT/DECLINE/CANCEL,
   *    room presence (JOIN/MEDIA/LEAVE for the "who is in the call" list),
   *    and watchTopic() used by other pages.
   *  - Socket.IO microservice: everything WebRTC — room:join/leave,
   *    peer list, peer:state, offer / answer / ice-candidate.
   *    Peers are keyed by socket id (one RTCPeerConnection per remote socket).
   * ------------------------------------------------------------------ */
  /* ---------------- Logging ----------------
   * Everything is prefixed with [CPCall] so you can filter the console.
   * Turn off with: window.CP_CALL_DEBUG = false (before call.js loads)
   * or at runtime: CPCall.setDebug(false)
   */
  let DEBUG = window.CP_CALL_DEBUG !== false;
  const t0 = performance.now();
  function stamp() { return `[CPCall +${((performance.now() - t0) / 1000).toFixed(2)}s]`; }
  const log = {
    info: (...args) => { if (DEBUG) console.log(stamp(), ...args); },
    warn: (...args) => console.warn(stamp(), ...args),     // always shown
    error: (...args) => console.error(stamp(), ...args),   // always shown
  };
  function short(id) { return id == null ? String(id) : String(id).slice(0, 8); }
  function describeSdp(desc) { return desc ? `${desc.type} (${(desc.sdp || "").length}b)` : String(desc); }

  const SIGNAL_URL = window.CP_SIGNAL_URL || "https://webrtc-microservice-production.up.railway.app";
  const SOCKET_IO_SOURCES = [
    `${SIGNAL_URL}/socket.io/socket.io.js`,
    "https://cdn.jsdelivr.net/npm/socket.io-client@4.8.1/dist/socket.io.min.js",
  ];

  let stompClient = null;
  const wsWaiters = [];
  const topicWatches = new Map();
  function watchTopic(destination, callback) {
    const watch={destination,callback,subscription:null};
    topicWatches.set(watch,watch);
    const subscribe=()=>{watch.subscription=stompClient.subscribe(destination,callback);};
    if(stompClient?.connected)subscribe();else connectWS();
    return ()=>{watch.subscription?.unsubscribe();topicWatches.delete(watch);};
  }
  let me = null;
  let localStream = null;
  let currentRoomId = null;
  let currentMode = null;
  let activeCall = false;
  let currentCallFriendId = null;
  let incomingCallSubscription = null;
  const remoteAudios = new Map();
  let mediaGeneration = 0;
  let cameraTask = null;
  let displayStream = null, savedCameraTrack = null, sharingTask = null;
  let iceLoaded = false;
  const peers = new Map(); // socketId -> entry
  const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.relay.metered.ca:80" }] };
  // Always relay: every call goes through TURN (iceTransportPolicy = "relay"), never peer-to-peer.
  // Only a developer override can switch it off: window.CP_FORCE_RELAY = false before call.js loads.
  function forceRelay() { return window.CP_FORCE_RELAY !== false; }

  /* ---------------- Socket.IO signaling ---------------- */
  let signalSocket = null;
  let socketIoLoader = null;
  let joinedSignalRoom = null; // roomId we emitted room:join for on the current socket

  function loadSocketIo() {
    if (typeof window.io === "function") return Promise.resolve(window.io);
    if (socketIoLoader) return socketIoLoader;
    socketIoLoader = (async () => {
      for (const src of SOCKET_IO_SOURCES) {
        try {
          log.info("loading Socket.IO client from", src);
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src; script.async = true;
            script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error(`script load failed: ${src}`)); };
            document.head.append(script);
          });
          if (typeof window.io === "function") { log.info("Socket.IO client loaded from", src); return window.io; }
          log.warn("script loaded but window.io is missing:", src);
        } catch (error) { log.warn("Socket.IO client load failed:", error.message); }
      }
      socketIoLoader = null;
      log.error("could not load Socket.IO client from any source", SOCKET_IO_SOURCES);
      throw new Error("โหลดระบบสัญญาณโทรไม่สำเร็จ กรุณาลองใหม่");
    })();
    return socketIoLoader;
  }
  function roomMatches(roomId) { return currentRoomId != null && String(roomId) === String(currentRoomId); }
  async function connectSignal() {
    if (signalSocket?.connected) return signalSocket;
    const io = await loadSocketIo();
    if (!signalSocket) {
      log.info("connecting Socket.IO to", SIGNAL_URL);
      signalSocket = io(SIGNAL_URL, { transports: ["websocket", "polling"] });
      bindSignalEvents(signalSocket);
    }
    if (signalSocket.connected) return signalSocket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); log.error("Socket.IO connect timeout (15s)", SIGNAL_URL); reject(new Error("เชื่อมต่อระบบโทรไม่สำเร็จ กรุณาลองใหม่")); }, 15000);
      const onConnect = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); signalSocket.off("connect", onConnect); };
      signalSocket.on("connect", onConnect);
      signalSocket.connect();
    });
    return signalSocket;
  }
  function signalEmit(event, payload) {
    if (!signalSocket?.connected) { log.warn(`signal NOT sent (socket disconnected): ${event}`, payload); return false; }
    signalSocket.emit(event, payload);
    return true;
  }
  function joinSignalRoom() {
    if (!activeCall || !currentRoomId || !signalSocket?.connected) {
      log.warn("room:join skipped", { activeCall, currentRoomId, socketConnected: !!signalSocket?.connected });
      return;
    }
    log.info(`room:join room=${currentRoomId} as user=${me?.id} socket=${signalSocket.id}`);
    joinedSignalRoom = currentRoomId;
    signalSocket.emit("room:join", {
      roomId: String(currentRoomId),
      userId: me?.id,
      name: displayName(me),
      imageUrl: me?.imageUrl || me?.image_url || null,
    });
    publishMediaState();
  }
  function leaveSignalRoom() {
    if (joinedSignalRoom && signalSocket?.connected) { log.info(`room:leave room=${joinedSignalRoom}`); signalSocket.emit("room:leave"); }
    joinedSignalRoom = null;
  }
  function displayName(user) {
    return (`${user?.firstname || ""} ${user?.lastname || ""}`).trim() || user?.name || user?.username || "";
  }
  function applyPeerState(entry, state) {
    if (!state) return;
    if (state.userId != null) entry.userId = String(state.userId);
    if (state.name) entry.name = state.name;
    if ("cam" in state || "videoEnabled" in state) entry.videoEnabled = state.cam === true || state.videoEnabled === true;
    if ("screen" in state || "screenSharing" in state) entry.screenSharing = state.screen === true || state.screenSharing === true;
    if ("mic" in state) entry.micEnabled = state.mic === true;
    if (state.mode) entry.mode = state.mode;
  }
  function summarizePayload(event, args) {
    const p = args[0];
    if (!p || typeof p !== "object") return args;
    if (event.startsWith("webrtc:")) {
      const d = p.data;
      const detail = event === "webrtc:ice-candidate" ? (d?.candidate ? d.candidate.split(" ").slice(4, 8).join(" ") : "end-of-candidates") : describeSdp(d);
      return [{ from: short(p.from), to: short(p.to), data: detail }];
    }
    return args;
  }
  function bindSignalEvents(socket) {
    // Log every Socket.IO event in both directions.
    socket.onAny((event, ...args) => log.info(`⬇ socket ${event}`, ...summarizePayload(event, args)));
    socket.onAnyOutgoing?.((event, ...args) => log.info(`⬆ socket ${event}`, ...summarizePayload(event, args)));
    socket.io.on("reconnect_attempt", n => log.warn(`Socket.IO reconnect attempt #${n}`));
    socket.io.on("reconnect", n => log.info(`Socket.IO reconnected after ${n} attempt(s)`));
    socket.io.on("reconnect_failed", () => log.error("Socket.IO reconnect failed"));
    socket.io.on("error", error => log.error("Socket.IO manager error:", error));
    socket.on("connect", () => {
      log.info(`Socket.IO connected id=${socket.id} transport=${socket.io.engine?.transport?.name}`);
      socket.io.engine?.on("upgrade", transport => log.info("Socket.IO transport upgraded to", transport.name));
      // A reconnect gives us a new socket id; the server forgot the old one,
      // so drop stale peer connections and join again.
      if (activeCall && currentRoomId) { log.warn("socket (re)connected during a call → rebuilding peers and re-joining"); closeAllPeers(); joinSignalRoom(); }
    });
    socket.on("disconnect", reason => { log.warn("Socket.IO disconnected:", reason); joinedSignalRoom = null; });
    socket.on("connect_error", error => log.error("Socket.IO connect_error:", error?.message || error, error?.description || "", error?.context || ""));
    socket.on("room:error", ({ message } = {}) => {
      log.error("room:error from server:", message);
      window.dispatchEvent(new CustomEvent("cp-call-error", { detail: { message: message || "เข้าห้องโทรไม่สำเร็จ" } }));
    });
    socket.on("room:users", ({ roomId, users } = {}) => {
      if (!activeCall || !localStream || !roomMatches(roomId)) { (activeCall ? log.warn : log.info)("room:users ignored", { roomId, currentRoomId, activeCall, hasLocalStream: !!localStream }); return; }
      const list = Array.isArray(users) ? users.filter(user => user?.id && user.id !== socket.id) : [];
      log.info(`room:users → ${list.length} other peer(s)`, list.map(user => ({ socket: short(user.id), userId: user.userId, name: user.name })));
      if (list.some(user => user.userId == null)) log.warn("some users in room:users have no userId — UI will show socket ids instead");
      const known = new Set(list.map(user => String(user.id)));
      for (const id of [...peers.keys()]) if (!known.has(id)) removePeer(id);
      for (const user of list) {
        const entry = peers.get(String(user.id)) || createPeer(user.id, user);
        applyPeerState(entry, user);
      }
      refreshMediaViews();
    });
    socket.on("peer:joined", ({ roomId, peer } = {}) => {
      if (!activeCall || !localStream || !roomMatches(roomId) || !peer?.id || peer.id === socket.id) { (activeCall ? log.warn : log.info)("peer:joined ignored", { roomId, currentRoomId, activeCall, peer }); return; }
      log.info(`peer joined socket=${short(peer.id)} user=${peer.userId} name=${peer.name}`);
      const entry = peers.get(String(peer.id)) || createPeer(peer.id, peer);
      applyPeerState(entry, peer);
      publishMediaState();
      refreshMediaViews();
    });
    socket.on("peer:left", ({ roomId, peerId } = {}) => {
      if (!activeCall || !roomMatches(roomId) || !peerId) { (activeCall ? log.warn : log.info)("peer:left ignored", { roomId, currentRoomId, peerId }); return; }
      const entry = peers.get(String(peerId));
      const userId = entry?.userId || String(peerId);
      log.info(`peer left socket=${short(peerId)} user=${userId} (remaining ${peers.size - (entry ? 1 : 0)})`);
      removePeer(peerId);
      if (!peers.size && currentCallFriendId) window.dispatchEvent(new CustomEvent("cp-call-ended", { detail: { userId, reason: "LEAVE" } }));
    });
    socket.on("peer:state", ({ roomId, from, state } = {}) => {
      if (!activeCall || !roomMatches(roomId) || !from || from === socket.id) { (activeCall ? log.warn : log.info)("peer:state ignored", { roomId, currentRoomId, from }); return; }
      const entry = peers.get(String(from));
      if (!entry) { log.warn(`peer:state from unknown socket ${short(from)} (no peer yet)`, state); return; }
      applyPeerState(entry, state);
      // Receiving a friend's camera never opens this user's camera.
      if ((entry.mode === "VIDEO" || entry.videoEnabled) && currentMode !== "VIDEO") { currentMode = "VIDEO"; emitMode("remote"); }
      refreshMediaViews();
      window.dispatchEvent(new CustomEvent("cp-call-media-state", { detail: { userId: entry.userId || String(from), videoEnabled: entry.videoEnabled === true } }));
    });
    socket.on("webrtc:offer", ({ from, data } = {}) => queueSignal(from, "offer", data));
    socket.on("webrtc:answer", ({ from, data } = {}) => queueSignal(from, "answer", data));
    socket.on("webrtc:ice-candidate", ({ from, data } = {}) => queueSignal(from, "ice", data));
  }

  /* ---------------- STOMP (Spring) ---------------- */
  async function loadIceConfig() {
    // ICE servers always come from the Railway signaling server (Metered TURN).
    const rtcConfigUrl = `${SIGNAL_URL}/api/rtc-config`;
    try {
      const response = await fetch(rtcConfigUrl, { cache: "no-store" });
      const config = response.ok ? await response.json() : null;
      if (Array.isArray(config?.iceServers) && config.iceServers.length) { ICE_CONFIG.iceServers = config.iceServers; log.info(`ICE config loaded from ${rtcConfigUrl}`); }
      else log.error(`${rtcConfigUrl} HTTP ${response.status} / no iceServers`, config);
    } catch (error) { log.error(`${rtcConfigUrl} failed (Railway down or blocked?):`, error); }
    const urls = ICE_CONFIG.iceServers.flatMap(server => [].concat(server.urls));
    const hasTurn = urls.some(url => /^turns?:/.test(url));
    log.info("ICE servers:", urls, hasTurn ? "(TURN present)" : "(NO TURN)");
    if (forceRelay()) {
      if (hasTurn) log.info("relay-only mode: every call goes through TURN (iceTransportPolicy=relay)");
      else log.error(`relay-only mode but NO TURN server from ${rtcConfigUrl} → calls cannot connect`);
    }
    // Only cache a config that has TURN; otherwise try Railway again on the next call.
    iceLoaded = hasTurn;
  }
  async function loadMe() {
    if (me?.id) { if (!iceLoaded) await loadIceConfig(); return me; }
    const response = await fetch("/api/users/me", { headers: { Accept: "application/json" }, credentials: "include" });
    if (!response.ok) { log.error(`/api/users/me failed: HTTP ${response.status}`); throw new Error("ไม่สามารถโหลดข้อมูลผู้ใช้ปัจจุบันได้"); }
    me = await response.json();
    me.id ||= me.userId;
    log.info("current user", { id: me.id, name: displayName(me) });
    if (!iceLoaded) await loadIceConfig();
    if (!me.id) { log.error("/api/users/me has no id/userId", me); throw new Error("ไม่พบ user id"); }
    return me;
  }
  function connectWS(onConnected) {
    if (stompClient?.connected) { onConnected?.(); return; }
    if (onConnected) wsWaiters.push(onConnected);
    if (stompClient) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const brokerURL = `${scheme}://${location.host}/ws`;
    log.info("STOMP connecting to", brokerURL);
    stompClient = new StompJs.Client({ brokerURL, reconnectDelay: 5000, debug: () => {} });
    stompClient.onStompError = (frame) => log.error("STOMP error:", frame.headers?.message || frame.body);
    stompClient.onWebSocketError = (error) => log.error("STOMP WebSocket error (403 = origin rejected, 401 = not logged in):", error?.type || error);
    stompClient.onDisconnect = () => log.warn("STOMP disconnected");
    stompClient.onConnect = () => {
      log.info("STOMP connected");
      subscribeIncomingCalls();
      for(const watch of topicWatches.values())watch.subscription=stompClient.subscribe(watch.destination,watch.callback);
      window.dispatchEvent(new CustomEvent("cp-ws-connected"));
      // Re-announce presence for the room list after a STOMP reconnect.
      if (activeCall && currentRoomId) { wsPublish(`/app/rooms/${currentRoomId}/call`, { type: "JOIN" }); publishPresenceMedia(); }
      wsWaiters.splice(0).forEach(callback => callback());
    };
    stompClient.onWebSocketClose = (event) => { log.warn(`STOMP WebSocket closed code=${event?.code} reason=${event?.reason || "-"}`); window.dispatchEvent(new CustomEvent("cp-ws-disconnected")); };
    stompClient.activate();
  }
  function waitForWS() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; log.error("STOMP connect timeout (15s)"); reject(new Error("เชื่อมต่อระบบโทรไม่สำเร็จ กรุณาลองใหม่")); }, 15000);
      connectWS(() => { if (settled) return; settled = true; clearTimeout(timer); resolve(); });
    });
  }
  function wsPublish(destination, body) {
    if (!stompClient?.connected) { log.warn(`STOMP NOT sent (disconnected): ${destination}`, body); return false; }
    log.info(`⬆ stomp ${destination}`, body?.type || "", body);
    stompClient.publish({ destination, body: JSON.stringify(body) });
    return true;
  }
  function publish(destination, body) {
    if (!wsPublish(destination, body)) throw new Error("การเชื่อมต่อระบบโทรขาดหาย กรุณาลองใหม่");
  }

  /* ---------------- Media state ---------------- */
  function cameraEnabled() {
    return !!localStream?.getVideoTracks().some(track => track.readyState === "live" && track.enabled);
  }
  function micEnabled() {
    return !!localStream?.getAudioTracks().some(track => track.readyState === "live" && track.enabled);
  }
  function publishPresenceMedia() {
    if (currentRoomId) wsPublish(`/app/rooms/${currentRoomId}/call`, { type: "MEDIA", payload: JSON.stringify({ mode: currentMode, videoEnabled: cameraEnabled(), screenSharing: !!displayStream }) });
  }
  function publishMediaState() {
    if (!currentRoomId) return;
    signalEmit("peer:state", { userId: me?.id, mic: micEnabled(), cam: cameraEnabled(), screen: !!displayStream, mode: currentMode });
    publishPresenceMedia();
  }
  function emitMode(reason) {
    window.dispatchEvent(new CustomEvent("cp-call-mode-changed", { detail: { mode: currentMode, reason, localCameraEnabled: cameraEnabled() } }));
  }
  function play(element) {
    element?.play()?.catch(error => {
      const target = `#${element.id || element.tagName}`;
      if (error.name === "AbortError") log.info(`play() on ${target} interrupted by a newer stream (harmless)`);
      else if (error.name === "NotAllowedError") log.warn(`play() on ${target} blocked by autoplay policy — click anywhere on the page to start audio/video`);
      else log.warn(`play() on ${target} failed:`, error);
    });
  }
  function showLocalStream(stream) {
    const video = document.getElementById("videoCallLocalVideo");
    if (!video) return;
    const enabled = cameraEnabled();
    video.srcObject = stream;
    video.muted = true;
    video.style.display = enabled ? "block" : "none";
    const placeholder = video.parentElement?.querySelector(".local-video-placeholder");
    if (placeholder) placeholder.style.display = enabled ? "none" : "flex";
    if (enabled) play(video);
  }
  function showRemoteStream(stream, peerKey = "default") {
    let audio = remoteAudios.get(String(peerKey));
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = remoteAudios.size ? `remoteCallAudio-${peerKey}` : "remoteCallAudio";
      audio.autoplay = true; audio.setAttribute("aria-hidden", "true"); audio.style.display = "none";
      document.body.append(audio); remoteAudios.set(String(peerKey), audio);
    }
    audio.srcObject = stream; play(audio);
  }
  function showRemoteVideo(stream, enabled = true) {
    const video = document.getElementById("videoCallRemoteVideo");
    if (!video) return;
    video.srcObject = stream;
    // Audio plays once through remoteCallAudio, not twice through both elements.
    video.muted = true;
    const hasVideo = !!stream?.getVideoTracks().some(track => track.readyState === "live" && !track.muted);
    const visible = enabled && hasVideo;
    video.style.display = visible ? "block" : "none";
    const placeholder = video.parentElement?.querySelector(".video-placeholder");
    if (placeholder) placeholder.style.display = visible ? "none" : "flex";
    const image = document.getElementById("videoCallRemoteImage");
    if (image) image.style.display = "block";
    if (visible) play(video);
  }
  function refreshMediaViews() {
    showLocalStream(localStream);
    const entries = [...peers.values()];
    for (const [key, entry] of peers) {
      const tracks = entry.pc.getTransceivers().filter(transceiver =>
        ["sendrecv", "recvonly"].includes(transceiver.currentDirection) && transceiver.receiver.track.readyState === "live"
      ).map(transceiver => transceiver.receiver.track);
      if (tracks.length) {
        for (const track of entry.remoteStream.getTracks()) if (!tracks.includes(track)) entry.remoteStream.removeTrack(track);
        for (const track of tracks) if (!entry.remoteStream.getTracks().includes(track)) entry.remoteStream.addTrack(track);
        if (tracks.some(track => track.kind === "audio")) showRemoteStream(entry.remoteStream, key);
      }
    }
    const remote = entries.find(entry => entry.remoteStream?.getVideoTracks().length) || entries[0];
    showRemoteVideo(remote?.remoteStream || null, remote?.videoEnabled !== false);
    // UI code (room-call.js / friend.js) identifies participants by user id.
    window.dispatchEvent(new CustomEvent("cp-call-streams", {detail: [...peers].map(([key, entry]) => ({userId: entry.userId || key, socketId: key, stream:entry.remoteStream, videoEnabled:entry.videoEnabled !== false, screenSharing:entry.screenSharing === true}))}));
  }

  /* ---------------- Peer connections (perfect negotiation) ---------------- */
  function createPeer(socketId, meta = null) {
    if (!localStream) throw new Error("ยังไม่มี local media stream");
    const key = String(socketId);
    if (peers.has(key)) return peers.get(key);
    const pc = new RTCPeerConnection({ ...ICE_CONFIG, iceTransportPolicy: forceRelay() ? "relay" : "all" });
    const entry = {
      pc, socketId: key, userId: meta?.userId != null ? String(meta.userId) : null, name: meta?.name || null,
      // Socket ids are unique per connection, so exactly one side is polite.
      polite: String(signalSocket?.id) > key,
      makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false,
      pendingCandidates: [], remoteStream: new MediaStream(), videoEnabled: null, screenSharing: false,
      signalQueue: Promise.resolve(),
    };
    peers.set(key, entry);
    const tag = `peer ${short(key)}${entry.userId ? `/${entry.userId.slice(0, 8)}` : ""}`;
    entry.tag = tag;
    log.info(`${tag} created (${entry.polite ? "polite" : "impolite"}, my socket=${short(signalSocket?.id)})`);
    const counts = { host: 0, srflx: 0, relay: 0, prflx: 0 };
    pc.onicecandidate = event => {
      if (event.candidate) {
        counts[event.candidate.type] = (counts[event.candidate.type] || 0) + 1;
        signalEmit("webrtc:ice-candidate", { to: key, data: event.candidate.toJSON() });
      } else {
        log.info(`${tag} local ICE gathering done`, counts, counts.relay ? "" : "← no relay candidates (TURN not used/working)");
      }
    };
    pc.onicecandidateerror = event => {
      // 701 = STUN/TURN server unreachable; 401 = TURN auth failed.
      log.warn(`${tag} ICE candidate error ${event.errorCode} ${event.errorText} url=${event.url}`);
    };
    pc.onsignalingstatechange = () => log.info(`${tag} signalingState → ${pc.signalingState}`);
    pc.onicegatheringstatechange = () => log.info(`${tag} iceGatheringState → ${pc.iceGatheringState}`);
    pc.ontrack = event => {
      const stream = entry.remoteStream;
      // Glare rollback can replace a receiver track. Keep one stable stream and
      // prevent late mute events on the old track from restoring obsolete media.
      for (const oldTrack of stream.getTracks().filter(track => track.kind === event.track.kind && track !== event.track)) stream.removeTrack(oldTrack);
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      log.info(`${tag} ontrack ${event.track.kind} id=${short(event.track.id)} muted=${event.track.muted}`);
      const refresh = () => {
        if (!activeCall || !peers.has(key) || !stream.getTracks().includes(event.track)) return;
        showRemoteStream(stream, key);
        if (event.track.kind === "video" && !event.track.muted && entry.videoEnabled !== false && currentMode !== "VIDEO") {
          currentMode = "VIDEO"; emitMode("remote");
        }
        refreshMediaViews();
      };
      event.track.onunmute = () => { log.info(`${tag} remote ${event.track.kind} unmuted (media flowing)`); refresh(); };
      event.track.onmute = () => { log.info(`${tag} remote ${event.track.kind} muted (no media)`); refresh(); };
      event.track.onended = () => { log.info(`${tag} remote ${event.track.kind} ended`); refresh(); };
      refresh();
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      (state === "failed" ? log.error : state === "disconnected" ? log.warn : log.info)(`${tag} connectionState → ${state}`);
      if (state === "connected") { logSelectedRoute(entry); window.dispatchEvent(new CustomEvent("cp-call-connected", { detail: { userId: entry.userId || key, mode: currentMode } })); }
      if (state === "failed") window.dispatchEvent(new CustomEvent("cp-call-error", { detail: { message: "เชื่อมต่อสื่อไม่สำเร็จ กรุณาลองโทรใหม่" } }));
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      (state === "failed" ? log.error : state === "disconnected" ? log.warn : log.info)(`${tag} iceConnectionState → ${state}`);
      if (state === "failed") { log.warn(`${tag} ICE failed → restartIce()`); pc.restartIce?.(); }
    };
    pc.onnegotiationneeded = async () => {
      if (!currentRoomId || !peers.has(key)) { log.warn(`${tag} negotiationneeded ignored (no room / peer removed)`); return; }
      // Pick one initial offerer. Avoid rolling back newly-created media tracks
      // when both participants discover each other at nearly the same time.
      if (!pc.remoteDescription && entry.polite) { log.info(`${tag} negotiationneeded: polite & no remote yet → waiting for the other side's offer`); return; }
      try {
        entry.makingOffer = true;
        log.info(`${tag} negotiationneeded → creating offer (state=${pc.signalingState})`);
        await pc.setLocalDescription();
        if (currentRoomId && peers.has(key)) signalEmit("webrtc:offer", { to: key, data: pc.localDescription });
        else log.warn(`${tag} offer created but peer/room gone, not sent`);
      } catch (error) { log.error(`${tag} สร้าง OFFER ไม่สำเร็จ:`, error); }
      finally { entry.makingOffer = false; }
    };
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    return entry;
  }
  async function logSelectedRoute(entry) {
    try {
      const stats = await entry.pc.getStats();
      let pair = null;
      stats.forEach(report => { if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId); });
      if (!pair) stats.forEach(report => { if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pair = report; });
      if (!pair) { log.warn(`${entry.tag} connected but no selected candidate pair in stats`); return; }
      const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
      log.info(`${entry.tag} route: local ${local?.candidateType}/${local?.protocol} ${local?.address || ""} ⇄ remote ${remote?.candidateType}/${remote?.protocol} ${remote?.address || ""}`,
        // In relay-only mode the browser cannot use any other path; "prflx" here only means the
        // other side's relay address was learned from a connectivity check before its candidate arrived.
        local?.candidateType === "relay" || remote?.candidateType === "relay" || forceRelay() ? "(via TURN relay)" : "(direct / STUN)");
    } catch (error) { log.warn(`${entry.tag} getStats failed:`, error); }
  }
  function removePeer(socketId) {
    const key = String(socketId);
    const entry = peers.get(key);
    if (!entry) { log.info(`removePeer ${short(key)}: not found`); return; }
    log.info(`${entry.tag} removed / closed`);
    peers.delete(key);
    const audio = remoteAudios.get(key); if (audio) {audio.srcObject=null; audio.remove(); remoteAudios.delete(key);}
    entry.pc.onicecandidate = entry.pc.ontrack = entry.pc.onnegotiationneeded = null;
    entry.pc.close();
    refreshMediaViews();
  }
  function closeAllPeers() {
    for (const key of [...peers.keys()]) removePeer(key);
  }
  function queueSignal(from, kind, data) {
    if (!activeCall || !localStream || !from || !data) { log.warn(`webrtc ${kind} dropped`, { activeCall, hasLocalStream: !!localStream, from, hasData: !!data }); return; }
    const key = String(from);
    // An offer may arrive before room:users / peer:joined; create the peer on demand.
    const entry = peers.get(key) || (kind === "offer" ? (log.info(`offer from unknown socket ${short(key)} → creating peer`), createPeer(key)) : null);
    if (!entry) { log.warn(`webrtc ${kind} from unknown socket ${short(key)} dropped (no peer)`); return; }
    entry.signalQueue = entry.signalQueue
      .then(() => handleWebRTCSignal(entry, kind, data))
      .catch(error => {
        // Previously hidden when ignoreOffer was true — now always logged.
        (entry.ignoreOffer ? log.warn : log.error)(`${entry.tag} WebRTC ${kind} error${entry.ignoreOffer ? " (while ignoring a colliding offer)" : ""}:`, error, "state:", entry.pc.signalingState);
      });
  }
  async function handleWebRTCSignal(entry, kind, data) {
    const pc = entry.pc;
    if (!currentRoomId || peers.get(entry.socketId) !== entry) { log.warn(`${entry.tag} ${kind} skipped: peer replaced or call ended`); return; }
    if (kind === "ice") {
      if (entry.ignoreOffer) { log.info(`${entry.tag} remote ICE ignored (we ignored their colliding offer)`); return; }
      if (pc.remoteDescription && !entry.isSettingRemoteAnswerPending) await pc.addIceCandidate(data);
      else { entry.pendingCandidates.push(data); log.info(`${entry.tag} remote ICE queued (${entry.pendingCandidates.length}) — no remote description yet`); }
      return;
    }
    const description = data;
    const readyForOffer = !entry.makingOffer && (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (offerCollision) log.warn(`${entry.tag} offer collision (makingOffer=${entry.makingOffer}, state=${pc.signalingState}) → ${entry.ignoreOffer ? "impolite: IGNORE their offer" : "polite: rollback & accept their offer"}`);
    if (entry.ignoreOffer) return;
    // An answer is only valid while our own offer is pending; drop stale/duplicate ones.
    if (description.type === "answer" && pc.signalingState !== "have-local-offer") {
      log.warn(`${entry.tag} ข้าม ANSWER ที่ไม่ตรงสถานะ (state=${pc.signalingState}) — duplicate or stale answer`);
      return;
    }
    log.info(`${entry.tag} setRemoteDescription(${describeSdp(description)}) state=${pc.signalingState}`);
    entry.isSettingRemoteAnswerPending = description.type === "answer";
    try { await pc.setRemoteDescription(description); }
    finally { entry.isSettingRemoteAnswerPending = false; }
    if (description.type === "offer") {
      await pc.setLocalDescription();
      log.info(`${entry.tag} answer created`);
      signalEmit("webrtc:answer", { to: entry.socketId, data: pc.localDescription });
    }
    const pending = entry.pendingCandidates.splice(0);
    if (pending.length) log.info(`${entry.tag} flushing ${pending.length} queued remote ICE candidate(s)`);
    for (const candidate of pending) {
      try { await pc.addIceCandidate(candidate); }
      catch (error) { (entry.ignoreOffer ? log.info : log.warn)(`${entry.tag} addIceCandidate (queued) failed:`, error); }
    }
    refreshMediaViews();
  }

  /* ---------------- Call lifecycle ---------------- */
  async function startMedia(mode) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("การโทรต้องเปิดผ่าน HTTPS หรือ localhost และอนุญาตไมค์/กล้อง");
    const generation = mediaGeneration;
    const wantsVideo = mode === "VIDEO";
    const existingVideo = localStream?.getVideoTracks().find(track => track.readyState === "live");
    let acquired = null;
    const constraints = !localStream ? { audio: true, video: wantsVideo } : (wantsVideo && !existingVideo ? { audio: false, video: true } : null);
    if (constraints) {
      log.info("getUserMedia", constraints);
      try { acquired = await navigator.mediaDevices.getUserMedia(constraints); }
      catch (error) { log.error(`getUserMedia failed: ${error.name} — ${error.message}`, "(NotAllowedError = permission denied, NotFoundError = no device, NotReadableError = device in use)"); throw error; }
      log.info("got local tracks:", acquired.getTracks().map(track => `${track.kind}:${track.label || "?"}`));
    }
    if (generation !== mediaGeneration) { log.warn("media acquired after the call ended → stopping tracks"); acquired?.getTracks().forEach(track => track.stop()); throw new Error("สายนี้สิ้นสุดแล้ว"); }
    if (!localStream) localStream = acquired;
    else if (acquired) {
      // Reuse a previously negotiated sender when a camera device was lost.
      for (const oldTrack of localStream.getVideoTracks().filter(track => track.readyState === "ended")) localStream.removeTrack(oldTrack);
      for (const track of acquired.getVideoTracks()) {
        localStream.addTrack(track);
        for (const {pc} of peers.values()) {
          const sender = pc.getSenders().find(sender => sender.track?.kind === "video");
          if (sender) await sender.replaceTrack(track);
          else pc.addTrack(track, localStream);
        }
      }
    }
    if (wantsVideo) localStream.getVideoTracks().forEach(track => { track.enabled = true; });
    currentMode = wantsVideo ? "VIDEO" : "VOICE";
    showLocalStream(localStream);
    return localStream;
  }
  // Connect both channels, mark the call active and enter the signaling room.
  async function enterCallRoom(roomId, generation) {
    log.info(`entering call room ${roomId}`);
    await Promise.all([waitForWS(), connectSignal()]);
    if (generation !== mediaGeneration || String(currentRoomId) !== String(roomId)) { log.warn(`enterCallRoom aborted: call changed while connecting (room=${currentRoomId})`); throw new Error("สายนี้สิ้นสุดแล้ว"); }
    activeCall = true;
    log.info(`call active in room ${roomId} mode=${currentMode}`);
    joinSignalRoom();
    wsPublish(`/app/rooms/${roomId}/call`, { type: "JOIN" }); // presence only
    publishPresenceMedia();
  }
  async function joinRoomCall(roomId, mode) {
    if (!roomId) throw new Error("ไม่พบ roomId");
    await loadMe();
    currentRoomId = roomId;
    const generation = mediaGeneration;
    try {
      await startMedia(mode);
      await enterCallRoom(roomId, generation);
    } catch (error) { if (generation === mediaGeneration) leaveCall(false); throw error; }
  }
  function leaveCall(notifyPeer = true) {
    const roomId = currentRoomId;
    if (roomId || activeCall || localStream) log.info(`leaveCall room=${roomId} notifyPeer=${notifyPeer} peers=${peers.size}`);
    if (roomId && activeCall) {
      leaveSignalRoom();
      if (notifyPeer) wsPublish(`/app/rooms/${roomId}/call`, { type: "LEAVE" });
    }
    activeCall = false;
    mediaGeneration += 1;
    cameraTask = null;
    displayStream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    savedCameraTrack?.stop(); displayStream = savedCameraTrack = null;
    const oldPeers = [...peers.values()]; peers.clear(); oldPeers.forEach(({pc}) => { pc.onicecandidate = pc.ontrack = pc.onnegotiationneeded = null; pc.close(); });
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    for (const id of ["videoCallLocalVideo", "videoCallRemoteVideo"]) {
      const video = document.getElementById(id); if (video) { video.srcObject = null; video.style.display = "none"; }
    }
    for (const audio of remoteAudios.values()) { audio.srcObject = null; audio.remove(); } remoteAudios.clear();
    currentRoomId = currentMode = currentCallFriendId = null;
    refreshMediaViews();
  }
  function toggleMicrophone() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    publishMediaState();
    return track.enabled;
  }
  async function upgradeToVideo() {
    if (!activeCall) throw new Error("รอให้รับสายและเชื่อมต่อก่อนเปิดกล้อง");
    if (cameraTask) return cameraTask;
    const task = (async () => {
      await startMedia("VIDEO");
      publishMediaState(); emitMode("local"); refreshMediaViews();
      return cameraEnabled();
    })();
    cameraTask = task;
    try { return await task; } finally { if (cameraTask === task) cameraTask = null; }
  }
  async function toggleCamera() {
    if (displayStream) throw new Error("หยุดแชร์จอก่อนเปลี่ยนกล้อง");
    const track = localStream?.getVideoTracks().find(track => track.readyState === "live");
    if (!track) return upgradeToVideo();
    track.enabled = !track.enabled;
    publishMediaState(); refreshMediaViews();
    return track.enabled;
  }
  async function startScreenShare() {
    if (!activeCall) throw new Error("เข้าร่วมคอลก่อนแชร์จอ");
    if (displayStream) return;
    if (sharingTask) return sharingTask;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("แชร์จอต้องใช้เบราว์เซอร์บนคอมพิวเตอร์ผ่าน HTTPS หรือ localhost");
    const generation = mediaGeneration;
    // The browser picker must open directly from the user's click.
    const picked = navigator.mediaDevices.getDisplayMedia({video:true, audio:false, preferCurrentTab:true});
    const task = (async () => {
      const captured = await picked;
      if (!activeCall || generation !== mediaGeneration) {captured.getTracks().forEach(track=>track.stop()); return;}
      const track = captured.getVideoTracks()[0];
      savedCameraTrack = localStream.getVideoTracks()[0] || null;
      displayStream = captured;
      try {
        if (savedCameraTrack) localStream.removeTrack(savedCameraTrack);
        localStream.addTrack(track);
        for (const {pc} of peers.values()) {
          const sender = pc.getSenders().find(sender=>sender.track?.kind==='video');
          if (sender) await sender.replaceTrack(track); else pc.addTrack(track,localStream);
        }
        track.onended = () => stopScreenShare().catch(error=>window.dispatchEvent(new CustomEvent('cp-call-error',{detail:{message:error.message}})));
        currentMode = 'VIDEO'; publishMediaState(); refreshMediaViews(); emitMode('screen');
      } catch (error) {await stopScreenShare(); throw error;}
    })();
    sharingTask = task;
    try {await task;} finally {if(sharingTask===task)sharingTask=null;}
  }
  async function stopScreenShare() {
    if (!displayStream) return;
    const captured=displayStream, screen=captured.getVideoTracks()[0], camera=savedCameraTrack;
    displayStream=savedCameraTrack=null;
    screen.onended=null;
    if(localStream){localStream.removeTrack(screen);if(camera?.readyState==='live')localStream.addTrack(camera);}
    try {
      for(const {pc} of peers.values()) {const sender=pc.getSenders().find(sender=>sender.track===screen);if(sender)await sender.replaceTrack(camera?.readyState==='live'?camera:null);}
    } finally {captured.getTracks().forEach(track=>track.stop());publishMediaState();refreshMediaViews();emitMode('screen-ended');}
  }
  async function startFriendCall(friendId, roomId, mode) {
    if (currentRoomId) throw new Error("มีสายกำลังโทรอยู่ กรุณาวางสายก่อน");
    if (!friendId || !roomId) throw new Error("กรุณาเลือกเพื่อนก่อนโทร");
    await loadMe();
    currentCallFriendId = friendId; currentRoomId = roomId; currentMode = mode === "VIDEO" ? "VIDEO" : "VOICE";
    const generation = mediaGeneration;
    try {
      // Ask for device permission before ringing, so failed permissions don't leave the other party waiting.
      await startMedia(currentMode);
      await waitForWS();
      connectSignal().catch(error => log.warn("Socket.IO warm-up failed (will retry when the call is accepted):", error.message)); // warm up; joinRoomCall waits for it after ACCEPT
      if (generation !== mediaGeneration) throw new Error("สายนี้สิ้นสุดแล้ว");
      publish("/app/call", { type: "INVITE", toUserId: friendId, roomId, mode: currentMode });
    } catch (error) { if (generation === mediaGeneration) leaveCall(false); throw error; }
  }
  async function acceptFriendCall(signal) {
    if (!signal?.fromUserId || !signal?.roomId) throw new Error("ข้อมูลสายเรียกเข้าไม่ครบ");
    await loadMe();
    currentRoomId = signal.roomId; currentCallFriendId = signal.fromUserId;
    const generation = mediaGeneration;
    try {
      await startMedia(signal.mode === "VIDEO" ? "VIDEO" : "VOICE");
      // Join the signaling room before ACCEPT so the caller finds us when it joins.
      await enterCallRoom(signal.roomId, generation);
      publish("/app/call", { type: "ACCEPT", toUserId: signal.fromUserId, roomId: signal.roomId, mode: currentMode });
    } catch (error) { if (generation === mediaGeneration) leaveCall(false); throw error; }
  }
  async function declineFriendCall(signal) {
    if (!signal?.fromUserId) return;
    await loadMe(); await waitForWS();
    publish("/app/call", { type: "DECLINE", toUserId: signal.fromUserId, roomId: signal.roomId || null });
  }
  async function cancelFriendCall(signal = null) {
    const target = signal?.fromUserId || currentCallFriendId;
    const roomId = signal?.roomId || currentRoomId;
    if (!target) return false;
    await loadMe(); await waitForWS();
    publish("/app/call", { type: "CANCEL", toUserId: target, roomId });
    leaveCall(false);
    return true;
  }
  function subscribeIncomingCalls() {
    if (!stompClient?.connected || !me?.id) return;
    incomingCallSubscription?.unsubscribe();
    log.info(`STOMP subscribe /topic/call/${me.id}`);
    incomingCallSubscription = stompClient.subscribe(`/topic/call/${me.id}`, frame => {
      try {
        const signal = JSON.parse(frame.body);
        log.info(`⬇ stomp call ${signal?.type}`, signal);
        window.dispatchEvent(new CustomEvent("cp-call-signal", { detail: signal }));
      }
      catch (error) { log.error("อ่าน incoming call ไม่ได้:", error, frame.body); }
    });
  }
  window.addEventListener("pagehide", () => { log.info("pagehide → leaving call and closing sockets"); leaveCall(); stompClient?.deactivate(); signalSocket?.disconnect(); });

  // Log every public call and any error it throws. Callers (friend.js, room-call.js)
  // often catch errors and only show a status text, so the stack would otherwise be lost.
  const QUIET = new Set(["refreshMediaViews", "showRemoteVideo", "wsPublish", "connectWS", "loadMe", "watchTopic", "subscribeIncomingCalls"]);
  function traced(name, fn) {
    return function (...args) {
      if (!QUIET.has(name)) log.info(`CPCall.${name}(`, ...args, ")");
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === "function") {
          return result.catch(error => { log.error(`CPCall.${name} failed:`, error); throw error; });
        }
        return result;
      } catch (error) { log.error(`CPCall.${name} failed:`, error); throw error; }
    };
  }
  const api = { watchTopic, connectWS, wsPublish, loadMe, subscribeIncomingCalls, startMedia, joinRoomCall, leaveCall, toggleMicrophone, toggleCamera, upgradeToVideo, refreshMediaViews, startFriendCall, acceptFriendCall, declineFriendCall, cancelFriendCall, showRemoteVideo,
    startScreenShare, stopScreenShare };
  for (const [name, fn] of Object.entries(api)) api[name] = traced(name, fn);
  window.CPCall = { ...api, isScreenSharing: () => !!displayStream, getLocalStream: () => localStream, getCurrentRoomId: () => currentRoomId, getCurrentMode: () => currentMode, getCurrentFriendId: () => currentCallFriendId, isActive: () => activeCall, isBusy: () => !!currentRoomId, isCameraEnabled: cameraEnabled,
    setDebug: on => { DEBUG = !!on; console.log("[CPCall] debug", DEBUG ? "ON" : "OFF"); },
    isForceRelay: forceRelay,
    // Quick snapshot for the console: CPCall.dump()
    dump: () => {
      const snapshot = {
        room: currentRoomId, mode: currentMode, activeCall, friend: currentCallFriendId,
        stomp: !!stompClient?.connected, socket: signalSocket?.connected ? signalSocket.id : "disconnected",
        local: localStream?.getTracks().map(track => `${track.kind}:${track.enabled ? "on" : "off"}:${track.readyState}`) || [],
        peers: [...peers.values()].map(entry => ({ socket: entry.socketId, userId: entry.userId, polite: entry.polite, signaling: entry.pc.signalingState, ice: entry.pc.iceConnectionState, conn: entry.pc.connectionState, remoteTracks: entry.remoteStream.getTracks().map(track => `${track.kind}:${track.muted ? "muted" : "live"}`) })),
      };
      console.log("[CPCall] dump", snapshot); console.table(snapshot.peers);
      return snapshot;
    },
  };
  log.info(`call.js loaded (signal server ${SIGNAL_URL}) — run CPCall.dump() for a snapshot, CPCall.setDebug(false) to silence`);
})();

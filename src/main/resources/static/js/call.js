(() => {
  "use strict";
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
  let roomCallSubscription = null;
  let incomingCallSubscription = null;
  const remoteAudios = new Map();
  let mediaGeneration = 0;
  let cameraTask = null;
  let displayStream = null, savedCameraTrack = null, sharingTask = null;
  let meTask = null, iceTask = null, iceExpiresAt = 0;
  let audioResumeButton = null;
  const blockedAudios = new Set();
  const peers = new Map();
  const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.relay.metered.ca:80" }] };

  async function loadMe() {
    if (!me?.id) {
      if (!meTask) meTask = (async () => {
        const response = await fetch("/api/users/me", { headers: { Accept: "application/json" }, credentials: "include" });
        if (!response.ok) throw new Error("ไม่สามารถโหลดข้อมูลผู้ใช้ปัจจุบันได้");
        const user = await response.json();
        user.id ||= user.userId;
        if (!user.id) throw new Error("ไม่พบ user id");
        me = user;
      })();
      try { await meTask; } finally { meTask = null; }
    }
    return me;
  }
  async function loadIceConfig() {
    if (Date.now() < iceExpiresAt) return;
    if (!iceTask) iceTask = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch("/api/call/ice-config", {credentials:"include", cache:"no-store", signal:controller.signal});
        if (!response.ok) throw new Error(`โหลดการเชื่อมต่อเสียง/วิดีโอไม่สำเร็จ (HTTP ${response.status}) กรุณาตรวจเซิร์ฟเวอร์ TURN แล้วลองใหม่`);
        const config = await response.json();
        if (!Array.isArray(config.iceServers) || !config.iceServers.length) throw new Error("เซิร์ฟเวอร์ยังไม่ได้ตั้งค่าการเชื่อมต่อเสียง/วิดีโอ");
        ICE_CONFIG.iceServers = config.iceServers;
        const expires = Date.parse(config.expiresAt);
        iceExpiresAt = Math.min(Date.now()+60000, Number.isFinite(expires) ? expires-30000 : Infinity);
      } catch (error) {
        if (error.name === "AbortError") throw new Error("โหลดการเชื่อมต่อเสียง/วิดีโอนานเกินไป กรุณาลองอีกครั้ง");
        throw error;
      } finally { clearTimeout(timer); }
    })();
    try { await iceTask; } finally { iceTask = null; }
  }
  function hasRelayConfigured() {
    return ICE_CONFIG.iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url || "")));
  }
  async function getDiagnostics() {
    // Deliberately omit URLs, addresses, SDP, usernames, credentials and user IDs.
    const connections = [];
    for (const {pc} of peers.values()) {
      const item = {connectionState:pc.connectionState, iceConnectionState:pc.iceConnectionState, signalingState:pc.signalingState, audioPacketsReceived:0, audioBytesReceived:0};
      try {
        const stats = await pc.getStats();
        const transport = [...stats.values()].find(s=>s.type==="transport" && s.selectedCandidatePairId);
        const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(s=>s.type==="candidate-pair" && s.state==="succeeded" && s.nominated);
        if (pair) {
          const local=stats.get(pair.localCandidateId), remote=stats.get(pair.remoteCandidateId);
          item.selectedPair={localType:local?.candidateType,remoteType:remote?.candidateType,protocol:local?.protocol,relayProtocol:local?.relayProtocol};
        }
        for (const stat of stats.values()) if(stat.type==="inbound-rtp" && stat.kind==="audio") {
          item.audioPacketsReceived += stat.packetsReceived || 0; item.audioBytesReceived += stat.bytesReceived || 0;
        }
      } catch (_) {}
      connections.push(item);
    }
    return {active:activeCall, mode:currentMode, signalingConnected:!!stompClient?.connected, relayConfigured:hasRelayConfigured(), connections};
  }
  function connectWS(onConnected) {
    if (stompClient?.connected) { onConnected?.(); return; }
    if (onConnected) wsWaiters.push(onConnected);
    if (stompClient) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    stompClient = new StompJs.Client({ brokerURL: `${scheme}://${location.host}/ws`, reconnectDelay: 5000, debug: () => {} });
    stompClient.onStompError = (frame) => console.error("Call STOMP error:", frame.headers?.message || frame.body);
    stompClient.onWebSocketError = (error) => console.error("Call WebSocket error:", error);
    stompClient.onConnect = () => {
      subscribeIncomingCalls();
      for(const watch of topicWatches.values())watch.subscription=stompClient.subscribe(watch.destination,watch.callback);
      window.dispatchEvent(new CustomEvent("cp-ws-connected"));
      if (activeCall && currentRoomId) {
        subscribeRoomCall(currentRoomId);
        wsPublish(`/app/rooms/${currentRoomId}/call`, { type: "JOIN" });
        publishMediaState();
      }
      wsWaiters.splice(0).forEach(callback => callback());
    };
    stompClient.onWebSocketClose = () => window.dispatchEvent(new CustomEvent("cp-ws-disconnected"));
    stompClient.activate();
  }
  function waitForWS() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("เชื่อมต่อระบบโทรไม่สำเร็จ กรุณาลองใหม่")); }, 15000);
      connectWS(() => { if (settled) return; settled = true; clearTimeout(timer); resolve(); });
    });
  }
  function wsPublish(destination, body) {
    if (!stompClient?.connected) return false;
    stompClient.publish({ destination, body: JSON.stringify(body) });
    return true;
  }
  function publish(destination, body) {
    if (!wsPublish(destination, body)) throw new Error("การเชื่อมต่อระบบโทรขาดหาย กรุณาลองใหม่");
  }
  function cameraEnabled() {
    return !!localStream?.getVideoTracks().some(track => track.readyState === "live" && track.enabled);
  }
  function publishMediaState() {
    if (currentRoomId) wsPublish(`/app/rooms/${currentRoomId}/call`, { type: "MEDIA", payload: JSON.stringify({ mode: currentMode, videoEnabled: cameraEnabled(), screenSharing: !!displayStream }) });
  }
  function emitMode(reason) {
    window.dispatchEvent(new CustomEvent("cp-call-mode-changed", { detail: { mode: currentMode, reason, localCameraEnabled: cameraEnabled() } }));
  }
  function play(element) { element?.play()?.catch(() => {}); }
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
  function updateAudioResume() {
    for (const audio of blockedAudios) if (!audio.isConnected || !audio.paused) blockedAudios.delete(audio);
    if (blockedAudios.size && !audioResumeButton) {
      audioResumeButton = document.createElement("button");
      audioResumeButton.type = "button"; audioResumeButton.className = "cp-call-audio-resume";
      audioResumeButton.textContent = "ไม่ได้ยินเสียง? กดเพื่อเปิดเสียงคอล";
      audioResumeButton.addEventListener("click", () => {
        // Invoke play synchronously within the user gesture for every blocked peer.
        for (const audio of [...blockedAudios]) playRemoteAudio(audio);
      });
      document.body.append(audioResumeButton);
    }
    if (audioResumeButton) audioResumeButton.hidden = !blockedAudios.size;
  }
  function playRemoteAudio(audio) {
    audio.muted = false; audio.volume = 1;
    const attempt = audio.play();
    attempt?.then(() => { blockedAudios.delete(audio); updateAudioResume(); }).catch(error => {
      if (!activeCall || !audio.isConnected) return;
      if (error.name === "NotAllowedError") { blockedAudios.add(audio); updateAudioResume(); }
      else if (error.name !== "AbortError") window.dispatchEvent(new CustomEvent("cp-call-error", {detail:{message:"เล่นเสียงจากอีกฝั่งไม่สำเร็จ กรุณาออกจากคอลแล้วเข้าร่วมใหม่"}}));
    });
  }
  function showRemoteStream(stream, userId = "default") {
    if (!stream?.getAudioTracks().some(track => track.readyState === "live")) return;
    let audio = remoteAudios.get(String(userId));
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = remoteAudios.size ? `remoteCallAudio-${userId}` : "remoteCallAudio";
      audio.autoplay = true; audio.setAttribute("aria-hidden", "true"); audio.style.display = "none";
      document.body.append(audio); remoteAudios.set(String(userId), audio);
    }
    // Reassigning srcObject during every presence/video refresh interrupts audio.
    if (audio.srcObject !== stream) audio.srcObject = stream;
    if (audio.paused) playRemoteAudio(audio);
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
    for (const [userId, entry] of peers) {
      const tracks = entry.pc.getTransceivers().filter(transceiver =>
        ["sendrecv", "recvonly"].includes(transceiver.currentDirection) && transceiver.receiver.track.readyState === "live"
      ).map(transceiver => transceiver.receiver.track);
      if (tracks.length) {
        for (const track of entry.remoteStream.getTracks()) if (!tracks.includes(track)) entry.remoteStream.removeTrack(track);
        for (const track of tracks) if (!entry.remoteStream.getTracks().includes(track)) entry.remoteStream.addTrack(track);
        if (tracks.some(track => track.kind === "audio")) showRemoteStream(entry.remoteStream, userId);
      }
    }
    const remote = entries.find(entry => entry.remoteStream?.getVideoTracks().length) || entries[0];
    showRemoteVideo(remote?.remoteStream || null, remote?.videoEnabled !== false);
    window.dispatchEvent(new CustomEvent("cp-call-streams", {detail: [...peers].map(([userId, entry]) => ({userId, stream:entry.remoteStream, videoEnabled:entry.videoEnabled !== false, screenSharing:entry.screenSharing === true}))}));
  }
  function createPeer(userId) {
    if (!localStream) throw new Error("ยังไม่มี local media stream");
    const key = String(userId);
    if (peers.has(key)) return peers.get(key);
    const pc = new RTCPeerConnection(ICE_CONFIG);
    const entry = { pc, polite: String(me.id) < key, makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false, pendingCandidates: [], remoteStream: new MediaStream(), videoEnabled: null, signalQueue: Promise.resolve() };
    peers.set(key, entry);
    pc.onicecandidate = event => {
      if (event.candidate && currentRoomId) wsPublish(`/app/rooms/${currentRoomId}/call`, { type: "ICE", targetUserId: key, payload: JSON.stringify(event.candidate) });
    };
    pc.ontrack = event => {
      const stream = entry.remoteStream;
      // Glare rollback can replace a receiver track. Keep one stable stream and
      // prevent late mute events on the old track from restoring obsolete media.
      for (const oldTrack of stream.getTracks().filter(track => track.kind === event.track.kind && track !== event.track)) stream.removeTrack(oldTrack);
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      const refresh = () => {
        if (!activeCall || !peers.has(key) || !stream.getTracks().includes(event.track)) return;
        showRemoteStream(stream, key);
        if (event.track.kind === "video" && !event.track.muted && entry.videoEnabled !== false && currentMode !== "VIDEO") {
          currentMode = "VIDEO"; emitMode("remote");
        }
        refreshMediaViews();
      };
      event.track.onunmute = refresh;
      event.track.onmute = refresh;
      event.track.onended = refresh;
      refresh();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") window.dispatchEvent(new CustomEvent("cp-call-connected", { detail: { userId: key, mode: currentMode } }));
      if (pc.connectionState === "failed") window.dispatchEvent(new CustomEvent("cp-call-error", { detail: { message: hasRelayConfigured() ? "เชื่อมต่อเสียง/วิดีโอไม่สำเร็จ กรุณาตรวจ TURN และเครือข่าย แล้วโทรใหม่" : "เชื่อมต่อเสียง/วิดีโอไม่สำเร็จ เซิร์ฟเวอร์ยังไม่มี TURN สำหรับเครือข่ายที่ต้องใช้ตัวกลาง" } }));
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") pc.restartIce?.(); };
    pc.onnegotiationneeded = async () => {
      if (!currentRoomId || !peers.has(key)) return;
      // Pick one initial offerer. Avoid rolling back newly-created media tracks
      // when both participants receive JOIN at nearly the same time.
      if (!pc.remoteDescription && entry.polite) return;
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (currentRoomId && peers.has(key)) publish(`/app/rooms/${currentRoomId}/call`, { type: "OFFER", targetUserId: key, payload: JSON.stringify(pc.localDescription) });
      } catch (error) { console.error("สร้าง OFFER ไม่สำเร็จ:", error); }
      finally { entry.makingOffer = false; }
    };
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    return entry;
  }
  function removePeer(userId) {
    const key = String(userId);
    const entry = peers.get(key);
    if (!entry) return;
    peers.delete(key);
    const audio = remoteAudios.get(key); if (audio) {audio.srcObject=null; audio.remove(); blockedAudios.delete(audio); remoteAudios.delete(key); updateAudioResume();}
    entry.pc.close();
    refreshMediaViews();
  }
  async function handleWebRTCSignal(signal, entry) {
    const pc = entry.pc;
    const fromUserId = String(signal.fromUserId);
    if (!currentRoomId || !peers.has(fromUserId)) return;
    if (signal.type === "ICE") {
      if (!signal.payload || entry.ignoreOffer) return;
      const candidate = JSON.parse(signal.payload);
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else entry.pendingCandidates.push(candidate);
      return;
    }
    if (!signal.payload) return;
    const description = JSON.parse(signal.payload);
    const readyForOffer = !entry.makingOffer && (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;
    entry.isSettingRemoteAnswerPending = description.type === "answer";
    try { await pc.setRemoteDescription(description); }
    finally { entry.isSettingRemoteAnswerPending = false; }
    if (description.type === "offer") {
      await pc.setLocalDescription();
      if (currentRoomId) publish(`/app/rooms/${currentRoomId}/call`, { type: "ANSWER", targetUserId: fromUserId, payload: JSON.stringify(pc.localDescription) });
    }
    for (const candidate of entry.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
    refreshMediaViews();
  }
  function onCallSignal(signal) {
    if (!activeCall || !localStream || !signal || !me?.id) return;
    const fromUserId = signal.fromUserId == null ? null : String(signal.fromUserId);
    if (!fromUserId || fromUserId === String(me.id)) return;
    if (signal.targetUserId && String(signal.targetUserId) !== String(me.id)) return;
    if (signal.type === "LEAVE") {
      removePeer(fromUserId);
      if (!peers.size && currentCallFriendId) window.dispatchEvent(new CustomEvent("cp-call-ended", { detail: { userId: fromUserId, reason: "LEAVE" } }));
      return;
    }
    const entry = peers.get(fromUserId) || createPeer(fromUserId);
    if (signal.type === "JOIN") { publishMediaState(); return; }
    if (signal.type === "MEDIA") {
      if (!signal.payload) return;
      const state = JSON.parse(signal.payload);
      entry.videoEnabled = state.videoEnabled === true;
      entry.screenSharing = state.screenSharing === true;
      // Receiving a friend's camera never opens this user's camera.
      if ((state.mode === "VIDEO" || entry.videoEnabled) && currentMode !== "VIDEO") { currentMode = "VIDEO"; emitMode("remote"); }
      refreshMediaViews();
      window.dispatchEvent(new CustomEvent("cp-call-media-state", { detail: { userId: fromUserId, videoEnabled: entry.videoEnabled } }));
      return;
    }
    if (["OFFER", "ANSWER", "ICE"].includes(signal.type)) {
      entry.signalQueue = entry.signalQueue.then(() => handleWebRTCSignal(signal, entry)).catch(error => { if (!entry.ignoreOffer) console.error("WebRTC signal error:", error); });
    }
  }
  function unsubscribeRoomCall() { roomCallSubscription?.unsubscribe(); roomCallSubscription = null; }
  function subscribeRoomCall(roomId) {
    if (!stompClient?.connected || !roomId) return;
    unsubscribeRoomCall();
    roomCallSubscription = stompClient.subscribe(`/topic/rooms/${roomId}/call`, frame => {
      if (String(currentRoomId) !== String(roomId)) return;
      try { onCallSignal(JSON.parse(frame.body)); } catch (error) { console.error("อ่าน call signal ไม่ได้:", error); }
    });
  }
  async function startMedia(mode) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("การโทรต้องเปิดผ่าน HTTPS หรือ localhost และอนุญาตไมค์/กล้อง");
    const generation = mediaGeneration;
    const wantsVideo = mode === "VIDEO";
    const existingVideo = localStream?.getVideoTracks().find(track => track.readyState === "live");
    let acquired = null;
    if (!localStream) acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantsVideo });
    else if (wantsVideo && !existingVideo) acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    if (generation !== mediaGeneration) { acquired?.getTracks().forEach(track => track.stop()); throw new Error("สายนี้สิ้นสุดแล้ว"); }
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
  async function joinRoomCall(roomId, mode) {
    if (!roomId) throw new Error("ไม่พบ roomId");
    await loadMe();
    currentRoomId = roomId;
    const generation = mediaGeneration;
    try {
      await loadIceConfig();
      if (generation !== mediaGeneration) throw new Error("สายนี้สิ้นสุดแล้ว");
      await startMedia(mode);
      await waitForWS();
      if (generation !== mediaGeneration || currentRoomId !== roomId) throw new Error("สายนี้สิ้นสุดแล้ว");
      activeCall = true;
      subscribeRoomCall(roomId);
      publish(`/app/rooms/${roomId}/call`, { type: "JOIN" });
      publishMediaState();
    } catch (error) { if (generation === mediaGeneration) leaveCall(false); throw error; }
  }
  function leaveCall(notifyPeer = true) {
    const roomId = currentRoomId;
    if (notifyPeer && roomId && activeCall) wsPublish(`/app/rooms/${roomId}/call`, { type: "LEAVE" });
    activeCall = false;
    mediaGeneration += 1;
    cameraTask = null;
    displayStream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    savedCameraTrack?.stop(); displayStream = savedCameraTrack = null;
    unsubscribeRoomCall();
    const oldPeers = [...peers.values()]; peers.clear(); oldPeers.forEach(({pc}) => pc.close());
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    for (const id of ["videoCallLocalVideo", "videoCallRemoteVideo"]) {
      const video = document.getElementById(id); if (video) { video.srcObject = null; video.style.display = "none"; }
    }
    for (const audio of remoteAudios.values()) { audio.srcObject = null; audio.remove(); } remoteAudios.clear();
    blockedAudios.clear(); audioResumeButton?.remove(); audioResumeButton = null;
    currentRoomId = currentMode = currentCallFriendId = null;
    refreshMediaViews();
  }
  function toggleMicrophone() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled; return track.enabled;
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
      await loadIceConfig();
      if (generation !== mediaGeneration) throw new Error("สายนี้สิ้นสุดแล้ว");
      await startMedia(currentMode);
      await waitForWS();
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
      await loadIceConfig();
      if (generation !== mediaGeneration) throw new Error("สายนี้สิ้นสุดแล้ว");
      await startMedia(signal.mode === "VIDEO" ? "VIDEO" : "VOICE");
      await waitForWS();
      if (generation !== mediaGeneration) throw new Error("สายนี้สิ้นสุดแล้ว");
      activeCall = true;
      // Subscribe before ACCEPT: the caller may immediately publish an offer/JOIN.
      subscribeRoomCall(signal.roomId);
      publish("/app/call", { type: "ACCEPT", toUserId: signal.fromUserId, roomId: signal.roomId, mode: currentMode });
      publish(`/app/rooms/${signal.roomId}/call`, { type: "JOIN" });
      publishMediaState();
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
    const generation = mediaGeneration;
    await loadMe(); await waitForWS();
    publish("/app/call", { type: "CANCEL", toUserId: target, roomId });
    if (!signal && generation === mediaGeneration) leaveCall(false);
    return true;
  }
  function subscribeIncomingCalls() {
    if (!stompClient?.connected || !me?.id) return;
    incomingCallSubscription?.unsubscribe();
    incomingCallSubscription = stompClient.subscribe(`/topic/call/${me.id}`, frame => {
      try { window.dispatchEvent(new CustomEvent("cp-call-signal", { detail: JSON.parse(frame.body) })); }
      catch (error) { console.error("อ่าน incoming call ไม่ได้:", error); }
    });
  }
  window.addEventListener("pagehide", () => { leaveCall(); stompClient?.deactivate(); });
  window.CPCall = { getDiagnostics, watchTopic, connectWS, wsPublish, loadMe, subscribeIncomingCalls, startMedia, joinRoomCall, leaveCall, toggleMicrophone, toggleCamera, upgradeToVideo, refreshMediaViews, startFriendCall, acceptFriendCall, declineFriendCall, cancelFriendCall, showRemoteVideo,
    startScreenShare, stopScreenShare, isScreenSharing: () => !!displayStream, getLocalStream: () => localStream, getCurrentRoomId: () => currentRoomId, getCurrentMode: () => currentMode, getCurrentFriendId: () => currentCallFriendId, isActive: () => activeCall, isBusy: () => !!currentRoomId, isCameraEnabled: cameraEnabled };
})();

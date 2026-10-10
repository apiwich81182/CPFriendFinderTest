document.addEventListener("DOMContentLoaded", async () => {
  const friendSearch = document.getElementById("friendSearch");
  const friendList = document.getElementById("friendList");

  const chatUserImage = document.getElementById("chatUserImage");
  const chatUserName = document.getElementById("chatUserName");
  const chatUserYear = document.getElementById("chatUserYear");
  const chatUserProfile = document.getElementById("chatUserProfile");

  const chatMessages = document.getElementById("chatMessages");
  const messageForm = document.getElementById("messageForm");
  const messageInput = document.getElementById("messageInput");

  const chatMoreButton = document.getElementById("chatMoreButton");
  const chatMoreMenu = document.getElementById("chatMoreMenu");
  const unfriendButton = document.getElementById("unfriendButton");

  const imageButton = document.getElementById("imageButton");
  const imageInput = document.getElementById("imageInput");

  let currentFriendId = null;
  let currentRoomId = null;
  let currentFriendName = "";
  let conversationGeneration = 0;
  const renderedMessageIds = new Set();
  let oldestMessageAt = null;
  let historyBusy = false;
  let sendingText = false;
  const olderMessagesButton = document.createElement("button");
  olderMessagesButton.type = "button";
  olderMessagesButton.className = "older-messages-button";
  olderMessagesButton.textContent = "โหลดข้อความก่อนหน้า";
  olderMessagesButton.hidden = true;
  chatMessages.before(olderMessagesButton);
  olderMessagesButton.addEventListener("click", () => loadMessages(true));
  let currentFriendImage = "/images/avatar-placeholder.svg";
  let currentUserId = null;

  let socket = null;
  let stompConnected = false;

  /*
   * =========================================================
   * CURRENT USER
   * =========================================================
   */

  async function loadCurrentUser() {
    try {
      const response = await fetch("/api/users/me", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(
          `โหลดข้อมูลผู้ใช้ปัจจุบันไม่สำเร็จ (${response.status})`,
        );
      }

      const user = await response.json();
      currentUserId = user.id || user.userId || user.user?.id || null;
    } catch (error) {
      console.error("โหลด current user ล้มเหลว:", error);
      currentUserId = null;
    }
  }

  /*
   * =========================================================
   * FRIENDS
   * =========================================================
   */

  async function loadFriends() {
    try {
      const response = await fetch("/api/friends", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`โหลดเพื่อนไม่สำเร็จ (${response.status})`);
      }

      const friends = await response.json();

      friendList.innerHTML = "";

      if (!friends || friends.length === 0) {
        friendList.innerHTML = `
          <div class="friend-empty">ยังไม่มีเพื่อน</div>
        `;

        clearChat();
        return;
      }

      friends.forEach((friend, index) => {
        const friendItem = createFriendItem(friend);

        friendList.appendChild(friendItem);

        if (index === 0) {
          friendItem.classList.add("active");
        }
      });

      let targetId = new URLSearchParams(location.search).get("friendId");
      const targetRoom = new URLSearchParams(location.search).get("roomId");
      if (!targetId && targetRoom) {
        const response = await fetch(`/api/chats/${encodeURIComponent(targetRoom)}`, {credentials: "include"});
        if (response.ok) {
          const detail = await response.json();
          targetId = detail.members?.find(member => String(member.userId) !== String(currentUserId))?.userId;
        }
      }
      targetId ||= sessionStorage.getItem(`cp-last-friend:${currentUserId}`);
      const firstFriend = [...friendList.querySelectorAll(".friend-list-item")].find(item => String(item.dataset.id) === String(targetId))
        || friendList.querySelector(".friend-list-item");

      if (firstFriend) {
        await loadConversation(firstFriend);
      }
    } catch (error) {
      console.error("โหลดรายชื่อเพื่อนล้มเหลว:", error);

      friendList.innerHTML = `
        <div class="friend-empty">
          ไม่สามารถโหลดรายชื่อเพื่อนได้
        </div>
      `;

      clearChat();
    }
  }

  function createFriendItem(friend) {
    const friendItem = document.createElement("div");

    friendItem.className = "friend-list-item";

    const friendId = friend.friendId || friend.id;

    const fullname =
      `${friend.firstname || ""} ${friend.lastname || ""}`.trim() ||
      "ไม่ระบุชื่อ";

    const image = friend.imageUrl || "/images/avatar-placeholder.svg";

    friendItem.dataset.id = friendId || "";
    friendItem.dataset.name = fullname;
    friendItem.dataset.year =
      friend.year !== null && friend.year !== undefined
        ? `ปี ${friend.year}`
        : "";

    friendItem.dataset.image = image;
    friendItem.dataset.interests = formatInterests(friend.interests);
    friendItem.dataset.bio = friend.bio || "";

    friendItem.innerHTML = `
      <img
        class="friend-list-avatar" width="38" height="38"
        src="${escapeHtml(image)}"
        alt="${escapeHtml(fullname)}"
      >

      <div class="friend-list-info">
        <div class="friend-list-name">
          ${escapeHtml(fullname)}
        </div>

        <div class="friend-list-year">
          ${escapeHtml(friendItem.dataset.year)}
        </div>
      </div>
    `;

    friendItem.addEventListener("click", () => {
      loadConversation(friendItem);
    });

    return friendItem;
  }

  /*
   * =========================================================
   * OPEN DIRECT ROOM
   * =========================================================
   */

  async function loadConversation(friend) {
    const friendId = friend.dataset.id;

    if (!friendId) {
      console.error("ไม่พบ friendId ของเพื่อน");
      return;
    }

    document.querySelectorAll(".friend-list-item").forEach((item) => {
      item.classList.remove("active");
    });

    friend.classList.add("active");

    const generation = ++conversationGeneration;
    disconnectRoomWebSocket();
    currentRoomId = null;
    renderedMessageIds.clear(); oldestMessageAt = null; historyBusy = false;
    olderMessagesButton.hidden = true;
    currentFriendId = friendId;
    sessionStorage.setItem(`cp-last-friend:${currentUserId}`, friendId);
    currentFriendName = friend.dataset.name || "เพื่อน";
    currentFriendImage = friend.dataset.image || "/images/avatar-placeholder.svg";

    chatUserName.textContent = currentFriendName;
    chatUserYear.textContent = friend.dataset.year || "";
    chatUserImage.src = currentFriendImage;

    /*
     * ข้อมูลสำหรับ Friend Profile Popup
     */
    chatUserProfile.dataset.profile = "";
    chatUserProfile.dataset.id = currentFriendId;
    chatUserProfile.dataset.name = currentFriendName;
    chatUserProfile.dataset.year = friend.dataset.year || "";
    chatUserProfile.dataset.image = currentFriendImage;
    chatUserProfile.dataset.interests = friend.dataset.interests || "";
    chatUserProfile.dataset.bio = friend.dataset.bio || "";
    chatUserProfile.dataset.status = "friend";

    chatMessages.innerHTML = `
      <div class="friend-empty">
        กำลังเปิดห้องแชท...
      </div>
    `;

    chatMoreMenu.classList.remove("show");

    try {
      /*
       * ถ้ามีห้องอยู่แล้ว Backend จะคืนห้องเดิม
       * ถ้ายังไม่มี Backend จะสร้างห้องใหม่
       */
      const response = await fetch(`/api/chats/direct/${friendId}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `เปิดห้องแชทไม่สำเร็จ (${response.status}) ${errorText}`,
        );
      }

      const room = await response.json();
      if (generation !== conversationGeneration) return;

      /*
       * ChatRoomSummaryResponse:
       *
       * {
       *   id,
       *   roomName,
       *   roomType,
       *   isPrivate,
       *   maxMembers,
       *   memberCount,
       *   unreadCount,
       *   interests,
       *   createdAt
       * }
       */

      currentRoomId = room.id;

      if (!currentRoomId) {
        throw new Error("Backend ไม่ส่ง room id กลับมา");
      }

      console.log("เปิด Direct Room:", currentRoomId);

      connectRoomWebSocket();
      await loadMessages();
    } catch (error) {
      if (generation !== conversationGeneration) return;
      console.error("เปิดห้องแชทล้มเหลว:", error);

      chatMessages.innerHTML = `
        <div class="friend-empty">
          ไม่สามารถเปิดห้องแชทได้
        </div>
      `;
    }
  }

  /*
   * =========================================================
   * LOAD MESSAGE HISTORY
   * =========================================================
   */

  async function loadMessages(older = false) {
    if (!currentRoomId || historyBusy) return;
    const roomId = currentRoomId, generation = conversationGeneration;
    historyBusy = true; olderMessagesButton.disabled = true;
    const scrollHeight = chatMessages.scrollHeight, scrollTop = chatMessages.scrollTop;
    try {
      const before = older && oldestMessageAt ? `&before=${encodeURIComponent(oldestMessageAt)}` : "";
      const response = await fetch(`/api/chats/${roomId}/messages?limit=50${before}`, {headers:{Accept:"application/json"},credentials:"include"});
      if (!response.ok) throw new Error(`โหลดข้อความไม่สำเร็จ (${response.status})`);
      const messages = await response.json();
      if (generation !== conversationGeneration) return;
      if (!older) {
        // Keep messages that arrived through WebSocket while history was loading.
        const live = [...chatMessages.querySelectorAll("[data-message-id]")];
        chatMessages.replaceChildren(); renderedMessageIds.clear();
        messages.forEach(appendMessage);
        for (const node of live) if (!renderedMessageIds.has(node.dataset.messageId)) {
          renderedMessageIds.add(node.dataset.messageId); chatMessages.append(node);
        }
      } else {
        const first = chatMessages.firstChild;
        for (const message of messages) {
          const node = appendMessage(message, false);
          if (node) chatMessages.insertBefore(node, first);
        }
      }
      if (messages[0]?.createdAt) oldestMessageAt = messages[0].createdAt;
      olderMessagesButton.hidden = messages.length < 50 || !oldestMessageAt;
      if (!chatMessages.children.length) {
        const empty = document.createElement("div"); empty.className = "friend-empty"; empty.textContent = "ยังไม่มีข้อความ"; chatMessages.append(empty);
      }
      if (older) chatMessages.scrollTop = scrollTop + chatMessages.scrollHeight - scrollHeight;
      else scrollToBottom();
    } catch (error) {
      if (generation !== conversationGeneration) return;
      if (!older) { chatMessages.replaceChildren(); const retry = document.createElement("button"); retry.textContent = "โหลดข้อความไม่สำเร็จ · ลองอีกครั้ง"; retry.addEventListener("click",()=>loadMessages()); chatMessages.append(retry); }
      else olderMessagesButton.textContent = "โหลดไม่สำเร็จ · ลองอีกครั้ง";
    } finally { if (generation === conversationGeneration) {historyBusy=false; olderMessagesButton.disabled=false;} }
  }

  /*
   * =========================================================
   * SEND TEXT MESSAGE
   * =========================================================
   */

  messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if(sendingText) return;
    const text = messageInput.value.trim();

    if (!text) {
      return;
    }

    if (!currentRoomId) {
      alert("ยังไม่ได้เปิดห้องแชท");
      return;
    }

    const sendingGeneration = conversationGeneration;
    const draft=messageInput.value;
    messageInput.value='';
    sendingText=true;
    try {
      const response = await fetch(`/api/chats/${currentRoomId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "include",

        body: JSON.stringify({
          content: text,
          messageType: "TEXT",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `ส่งข้อความไม่สำเร็จ (${response.status}) ${errorText}`,
        );
      }

      const message = await response.json();
      if (sendingGeneration !== conversationGeneration) return;

      // Render the persisted REST response immediately; message IDs deduplicate WebSocket echoes.
      removeEmptyMessage();
      appendMessage(message);
      scrollToBottom();


      messageInput.focus();
    } catch (error) {
      if(sendingGeneration===conversationGeneration && !messageInput.value) messageInput.value=draft;
      console.error("ส่งข้อความล้มเหลว:", error);
      alert("ไม่สามารถส่งข้อความได้");
    } finally {sendingText=false;}
  });

  /*
   * Enter = ส่ง
   * Shift + Enter = ขึ้นบรรทัดใหม่
   */

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
  });

  /*
   * =========================================================
   * RENDER MESSAGE
   * =========================================================
   */

  function appendMessage(message, scroll = true) {
    if (message?.roomId && String(message.roomId) !== String(currentRoomId)) return;
    if (message?.id && renderedMessageIds.has(String(message.id))) return;
    if (message?.id) renderedMessageIds.add(String(message.id));
    if (!message) {
      return;
    }

    /*
     * ถ้าไม่ใช่ TEXT ตอนนี้ยังไม่ render
     */
    if (message.deleted) message = {...message, content: "ข้อความนี้ถูกลบแล้ว", messageType: "TEXT"};

    removeEmptyMessage();

    const wrapper = document.createElement("div");

    /*
     * ใช้ senderId เพื่อแยกข้อความของเรา / ของเพื่อน
     *
     * ถ้าไม่มี current user id
     * ใช้ class received เป็นค่าเริ่มต้น
     */
    const isMine =
      currentUserId != null &&
      message.senderId != null &&
      String(message.senderId) === String(currentUserId);

    wrapper.className = isMine
      ? "friend-chat-message sent"
      : "friend-chat-message received";

    if (message.id) wrapper.dataset.messageId = String(message.id);
    const content = document.createElement("div");

    content.className = "friend-chat-message-content";

    if (message.messageType === "IMAGE" && /^https?:\/\/|^\//.test(message.content || "")) {
      const image = document.createElement("img"); image.src = message.content; image.alt = "รูปภาพในแชท"; image.loading = "lazy"; content.append(image);
    } else content.textContent = message.content || "";

    wrapper.appendChild(content);
    if(isMine && message.messageType==='TEXT' && message.id) {
      const edit=document.createElement('button');edit.type='button';edit.className='message-edit-button';edit.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg>';edit.title='แก้ไขข้อความ';edit.setAttribute('aria-label','แก้ไขข้อความของฉัน');
      edit.addEventListener('click',async()=>{
        const draft=window.prompt('แก้ไขข้อความ',content.textContent);
        if(draft===null || draft===content.textContent) return;
        if(!draft.trim() || draft.length>5000){alert('ข้อความต้องมี 1–5000 ตัวอักษร');return;}
        edit.disabled=true;
        try {
          const response=await fetch(`/api/chats/${message.roomId}/messages/${message.id}`,{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:draft})});
          if(!response.ok)throw new Error();
          const updated=await response.json();content.textContent=updated.content;
        }catch(_){alert('แก้ไขข้อความไม่สำเร็จ กรุณาลองอีกครั้ง');}finally{edit.disabled=false;}
      });wrapper.append(edit);
    }


    chatMessages.appendChild(wrapper);

    if (scroll) scrollToBottom();
    return wrapper;
  }

  function removeEmptyMessage() {
    const empty = chatMessages.querySelector(".friend-empty");

    if (empty) {
      empty.remove();
    }
  }

  /*
   * =========================================================
   * WEBSOCKET / STOMP
   * =========================================================
   */

  function disconnectRoomWebSocket() {
    const old = socket; socket = null; stompConnected = false;
    if (old) old.close();
  }
  function connectRoomWebSocket() {
    if (!currentRoomId) {
      return;
    }

    /*
     * ปิด connection เก่าก่อน
     */
    if (socket) {
      try {
        socket.close();
      } catch (error) {
        console.warn("ปิด WebSocket เดิมไม่ได้:", error);
      }

      socket = null;
    }

    stompConnected = false;

    socket = new WebSocket(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`,
    );

    const connection = socket;
    socket.onopen = () => {
      if (socket !== connection) return;
      console.log("Friend WebSocket connected");

      sendStompFrame("CONNECT", {
        "accept-version": "1.2",
        "heart-beat": "0,0",
      });
    };

    socket.onmessage = (event) => {
      if (socket !== connection) return;
      const frame = parseStompFrame(event.data);

      if (!frame) {
        return;
      }

      /*
       * STOMP CONNECTED
       */
      if (frame.command === "CONNECTED") {
        stompConnected = true;

        console.log("Friend STOMP connected");

        sendStompFrame("SUBSCRIBE", {
          id: `friend-room-${currentRoomId}`,
          destination: `/topic/rooms/${currentRoomId}`,
          ack: "auto",
        });

        sendStompFrame("SUBSCRIBE", {id:`friend-updates-${currentRoomId}`,destination:`/topic/rooms/${currentRoomId}/message-updates`,ack:"auto"});
        return;
      }

      /*
       * STOMP MESSAGE
       */
      if (frame.command === "MESSAGE") {
        try {
          const message = JSON.parse(frame.body);

          console.log("ได้รับข้อความใหม่:", message);

          /*
           * กันข้อความจากห้องอื่น
           */
          if (
            message.roomId &&
            String(message.roomId) !== String(currentRoomId)
          ) {
            return;
          }

          if (message.type === 'EDIT' && message.message) {
            const updated=message.message;
            if(String(updated.roomId)!==String(currentRoomId)) return;
            const existing=[...chatMessages.querySelectorAll('[data-message-id]')].find(n=>n.dataset.messageId===String(updated.id));
            if(existing) existing.querySelector('.friend-chat-message-content').textContent=updated.content;
          } else appendMessage(message);
        } catch (error) {
          console.error("อ่าน WebSocket message ไม่ได้:", error);
        }
      }
    };

    socket.onerror = (error) => {
      if (socket !== connection) return;
      console.error("Friend WebSocket error:", error);
      stompConnected = false;
    };

    socket.onclose = () => {
      if (socket !== connection) return;
      console.log("Friend WebSocket disconnected");
      stompConnected = false;
    };
  }

  function sendStompFrame(command, headers = {}, body = "") {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    let frame = command + "\n";

    Object.entries(headers).forEach(([key, value]) => {
      frame += `${key}:${value}\n`;
    });

    frame += "\n";
    frame += body;
    frame += "\0";

    socket.send(frame);
  }

  function parseStompFrame(data) {
    if (!data) {
      return null;
    }

    const cleanData = data.replace(/^\x00+/, "");

    const separatorIndex = cleanData.indexOf("\n\n");

    if (separatorIndex === -1) {
      return null;
    }

    const headerPart = cleanData.substring(0, separatorIndex);
    let body = cleanData.substring(separatorIndex + 2);

    body = body.replace(/\0+$/, "");

    const lines = headerPart.split("\n");

    const command = lines.shift();

    const headers = {};

    lines.forEach((line) => {
      const index = line.indexOf(":");

      if (index === -1) {
        return;
      }

      const key = line.substring(0, index);
      const value = line.substring(index + 1);

      headers[key] = value;
    });

    return {
      command,
      headers,
      body,
    };
  }

  /*
   * =========================================================
   * SEARCH FRIEND
   * =========================================================
   */

  friendSearch.addEventListener("input", () => {
    const keyword = friendSearch.value.trim().toLowerCase();

    const friends = document.querySelectorAll(".friend-list-item");

    let found = 0;

    friends.forEach((friend) => {
      const name = (friend.dataset.name || "").toLowerCase();

      const year = (friend.dataset.year || "").toLowerCase();

      const matched = name.includes(keyword) || year.includes(keyword);

      friend.style.display = matched ? "flex" : "none";

      if (matched) {
        found++;
      }
    });

    let emptyMessage = document.getElementById("friendEmpty");

    if (found === 0 && friends.length > 0) {
      if (!emptyMessage) {
        emptyMessage = document.createElement("div");

        emptyMessage.id = "friendEmpty";
        emptyMessage.className = "friend-empty";
        emptyMessage.textContent = "ไม่พบเพื่อนที่ค้นหา";

        friendList.appendChild(emptyMessage);
      }
    } else {
      if (emptyMessage) {
        emptyMessage.remove();
      }
    }
  });

  /*
   * =========================================================
   * CHAT MORE MENU
   * =========================================================
   */

  chatMoreButton.addEventListener("click", (event) => {
    event.stopPropagation();

    chatMoreMenu.classList.toggle("show");
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".chat-more")) {
      chatMoreMenu.classList.remove("show");
    }
  });

  /*
   * =========================================================
   * UNFRIEND
   * =========================================================
   */

  unfriendButton.addEventListener("click", async () => {
    if (!currentFriendId) {
      return;
    }

    const confirmUnfriend = confirm(
      `ต้องการเลิกเป็นเพื่อนกับ ${currentFriendName} หรือไม่?`,
    );

    if (!confirmUnfriend) {
      return;
    }

    try {
      const response = await fetch(`/api/friends/${currentFriendId}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `เลิกเป็นเพื่อนไม่สำเร็จ (${response.status}) ${errorText}`,
        );
      }

      if (socket) {
        try {
          socket.close();
        } catch (error) {
          console.warn(error);
        }
      }

      currentFriendId = null;
      currentRoomId = null;

      await loadFriends();

      chatMoreMenu.classList.remove("show");
    } catch (error) {
      console.error("เลิกเป็นเพื่อนล้มเหลว:", error);
      alert("ไม่สามารถเลิกเป็นเพื่อนได้");
    }
  });

  /*
   * =========================================================
   * IMAGE
   * =========================================================
   *
   * ตอนนี้ยังเป็น preview prototype
   * เพราะ backend ยังไม่มี endpoint upload image โดยตรง
   */

  imageButton.addEventListener("click", () => {
    imageInput.click();
  });

  imageInput.addEventListener("change", async (event) => {
    const file=event.target.files[0];event.target.value='';
    if(!file || imageButton.disabled)return;
    if(!currentRoomId){alert('กรุณาเลือกเพื่อนก่อนส่งรูป');return;}
    const generation=conversationGeneration, roomId=currentRoomId;
    imageButton.disabled=true;imageButton.setAttribute('aria-busy','true');
    try {const message=await CPChatImages.send(roomId,file);if(generation===conversationGeneration)appendMessage(message);}
    catch(error){alert(error.message || 'ส่งรูปไม่สำเร็จ');}
    finally{imageButton.disabled=false;imageButton.removeAttribute('aria-busy');}
  });

  /*
   * =========================================================
   * CLEAR CHAT
   * =========================================================
   */

  function clearChat() {
    currentFriendId = null;
    currentRoomId = null;

    chatUserName.textContent = "เลือกเพื่อน";
    chatUserYear.textContent = "";
    chatUserImage.src = "/images/avatar-placeholder.svg";

    chatUserProfile.removeAttribute("data-profile");
    chatUserProfile.removeAttribute("data-id");

    chatMessages.innerHTML = `
      <div class="friend-empty">
        เลือกเพื่อนเพื่อเริ่มสนทนา
      </div>
    `;
  }

  /*
   * =========================================================
   * HELPERS
   * =========================================================
   */

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function formatInterests(interests) {
    if (!interests) {
      return "";
    }

    if (Array.isArray(interests)) {
      return interests
        .map((interest) => {
          if (typeof interest === "string") {
            return interest;
          }

          return interest.name || "";
        })
        .filter(Boolean)
        .join(",");
    }

    return String(interests);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* CALL UI ELEMENTS */
  const $call = (id) => document.getElementById(id);
  const voiceCallButton = $call("voiceCallButton");
  const videoCallButton = $call("videoCallButton");
  const voiceCallOverlay = $call("voiceCallOverlay");
  const videoCallOverlay = $call("videoCallOverlay");
  const voiceCallClose = $call("voiceCallClose");
  const videoCallClose = $call("videoCallClose");
  const voiceCallEnd = $call("voiceCallEnd");
  const videoCallEnd = $call("videoCallEnd");
  const voiceCallMute = $call("voiceCallMute");
  const voiceCallSpeaker = $call("voiceCallSpeaker");
  const voiceCallUpgrade = $call("voiceCallUpgrade");
  const videoCallMute = $call("videoCallMute");
  const videoCallCamera = $call("videoCallCamera");
  const voiceCallAccept = $call("voiceCallAccept");
  const voiceCallDecline = $call("voiceCallDecline");
  const videoCallAccept = $call("videoCallAccept");
  const videoCallDecline = $call("videoCallDecline");
  const incomingVoiceActions = $call("incomingVoiceActions");
  const incomingVideoActions = $call("incomingVideoActions");
  const voiceCallStatus = $call("voiceCallStatus");
  const videoCallStatus = $call("videoCallStatus");
  const videoCallDuration = $call("videoCallDuration");
  let currentCallMode = null;
  let incomingCallSignal = null;
  let callInfo = null;
  let callTimer = null;
  let callSeconds = 0;
  let speakerMuted = false;
  let acceptingCall = false;
  let startingCall = false;
  // Ring timeouts: caller gives up after RING_TIMEOUT_MS; callee's incoming screen closes a bit later
  // so the caller's CANCEL normally arrives first.
  const RING_TIMEOUT_MS = 40000;
  const PENDING_CALL_MAX_AGE_MS = 30000;
  let ringTimer = null;
  let incomingTimer = null;
  function clearRingTimers() { clearTimeout(ringTimer); clearTimeout(incomingTimer); ringTimer = incomingTimer = null; }
  // After entering the call room, end the call if nobody else shows up (caller gave up, CANCEL got lost).
  const NO_PEER_TIMEOUT_MS = 20000;
  let remotePeerCount = 0;
  window.addEventListener("cp-call-streams", event => { remotePeerCount = Array.isArray(event.detail) ? event.detail.length : 0; });
  function armNoPeerTimeout() {
    const call = callInfo;
    setTimeout(() => {
      if (callInfo !== call || !CPCall.isActive() || remotePeerCount > 0) return;
      console.warn("[friend] ไม่มีอีกฝ่ายเข้ามาในสายภายใน", NO_PEER_TIMEOUT_MS / 1000, "วินาที → วางสาย");
      CPCall.leaveCall(); clearCallUI();
    }, NO_PEER_TIMEOUT_MS);
  }

  function callStatus(message) {
    if (currentCallMode === "VIDEO") { if (videoCallStatus) videoCallStatus.textContent = message; }
    else if (voiceCallStatus) voiceCallStatus.textContent = message;
  }
  function clock() {
    return `${String(Math.floor(callSeconds / 60)).padStart(2,"0")}:${String(callSeconds % 60).padStart(2,"0")}`;
  }
  function startCallTimer() {
    if (callTimer) return;
    callTimer = setInterval(() => {
      callSeconds += 1;
      if (videoCallDuration) videoCallDuration.textContent = clock();
    }, 1000);
  }
  function stopCallTimer() { clearInterval(callTimer); callTimer = null; callSeconds = 0; }
  function syncCallControls() {
    const stream = CPCall.getLocalStream();
    const audio = stream?.getAudioTracks()[0];
    const microphoneMuted = !!audio && !audio.enabled;
    const cameraOff = !CPCall.isCameraEnabled();
    for (const button of [voiceCallMute, videoCallMute]) {
      if (!button) continue;
      button.disabled = !audio;
      button.classList.toggle("muted", microphoneMuted);
      button.setAttribute("aria-pressed", String(microphoneMuted));
      button.querySelector(":scope > span:last-child").textContent = microphoneMuted ? "เปิดไมค์" : "ปิดไมค์";
      const slash = button.querySelector(".voice-call-slash, .video-call-slash");
      if (slash) slash.style.display = microphoneMuted ? "block" : "none";
    }
    if (voiceCallSpeaker) {
      voiceCallSpeaker.classList.toggle("muted", speakerMuted);
      voiceCallSpeaker.setAttribute("aria-pressed", String(speakerMuted));
    }
    if (videoCallCamera) {
      videoCallCamera.disabled = !CPCall.isActive();
      videoCallCamera.classList.toggle("muted", cameraOff);
      videoCallCamera.setAttribute("aria-pressed", String(!cameraOff));
      videoCallCamera.querySelector(":scope > span:last-child").textContent = cameraOff ? "เปิดกล้อง" : "ปิดกล้อง";
      const slash = videoCallCamera.querySelector(".video-call-slash");
      if (slash) slash.style.display = cameraOff ? "block" : "none";
    }
    if (voiceCallUpgrade) voiceCallUpgrade.disabled = !CPCall.isActive();
    const remoteAudio = $call("remoteCallAudio");
    if (remoteAudio) remoteAudio.muted = speakerMuted;
    CPCall.refreshMediaViews();
  }
  function showIncomingActions(incoming) {
    videoCallOverlay?.classList.toggle("ringing", incoming && currentCallMode === "VIDEO");
    if (incomingVoiceActions) incomingVoiceActions.style.display = incoming && currentCallMode === "VOICE" ? "flex" : "none";
    if (incomingVideoActions) incomingVideoActions.style.display = incoming && currentCallMode === "VIDEO" ? "flex" : "none";
    for (const button of [voiceCallEnd, voiceCallMute, voiceCallSpeaker, voiceCallUpgrade, videoCallEnd, videoCallMute, videoCallCamera]) {
      if (button) button.style.display = incoming ? "none" : "";
    }
  }
  function closeVoiceCall(stopTimer = true) {
    voiceCallOverlay?.classList.remove("show", "active");
    if (stopTimer) stopCallTimer();
  }
  function closeVideoCall(stopTimer = true) {
    videoCallOverlay?.classList.remove("show", "active");
    if (stopTimer) stopCallTimer();
  }
  function openVoiceCallUI(name, image, status, incoming = false) {
    closeVideoCall(false);
    currentCallMode = "VOICE";
    $call("voiceCallName").textContent = name || "เพื่อน";
    $call("voiceCallImage").src = image || "/images/avatar-placeholder.svg";
    callStatus(status);
    showIncomingActions(incoming);
    voiceCallOverlay?.classList.add("show", "active");
    syncCallControls();
  }
  function openVideoCallUI(name, image, status, incoming = false) {
    closeVoiceCall(false);
    currentCallMode = "VIDEO";
    $call("videoCallUserName").textContent = name || "เพื่อน";
    $call("videoCallUserImage").src = image || "/images/avatar-placeholder.svg";
    $call("videoCallRemoteImage").src = image || "/images/avatar-placeholder.svg";
    if (videoCallDuration) videoCallDuration.textContent = clock();
    callStatus(status);
    showIncomingActions(incoming);
    videoCallOverlay?.classList.add("show", "active");
    syncCallControls();
  }
  function clearCallUI() {
    clearRingTimers();
    closeVoiceCall(); closeVideoCall();
    incomingCallSignal = callInfo = currentCallMode = null;
    speakerMuted = false;
    acceptingCall = false;
    for (const button of [voiceCallAccept,voiceCallDecline,videoCallAccept,videoCallDecline]) if (button) button.disabled = false;
  }
  function friendlyMediaError(error) {
    if (error.name === "NotAllowedError") return "กรุณาอนุญาตไมค์และกล้องในเบราว์เซอร์ แล้วลองอีกครั้ง";
    if (error.name === "NotFoundError") return "ไม่พบไมค์หรือกล้อง กรุณาตรวจอุปกรณ์";
    if (error.name === "NotReadableError") return "ไมค์หรือกล้องกำลังถูกใช้งาน กรุณาปิดแอปอื่นแล้วลองอีกครั้ง";
    return error.message || "เชื่อมต่อสายไม่สำเร็จ กรุณาลองใหม่";
  }
  async function startCall(mode) {
    if (startingCall || CPCall.isBusy() || incomingCallSignal) return;
    if (!currentFriendId || !currentRoomId) return alert("กรุณาเลือกเพื่อนก่อนโทร");
    startingCall = true;
    callInfo = {friendId:currentFriendId,roomId:currentRoomId,name:currentFriendName,image:currentFriendImage};
    currentCallMode = mode;
    voiceCallButton.disabled = videoCallButton.disabled = true;
    try {
      await CPCall.startFriendCall(callInfo.friendId,callInfo.roomId,mode);
      const open = mode === "VIDEO" ? openVideoCallUI : openVoiceCallUI;
      open(callInfo.name,callInfo.image,"กำลังโทร...");
      const ringingFor = callInfo;
      clearTimeout(ringTimer);
      ringTimer = setTimeout(async () => {
        if (callInfo !== ringingFor || CPCall.isActive()) return;
        console.warn("[friend] ไม่มีผู้รับสายภายใน", RING_TIMEOUT_MS / 1000, "วินาที → ยกเลิกสาย");
        await cancelOutgoingCall();
        alert("ไม่มีผู้รับสาย");
      }, RING_TIMEOUT_MS);
    } catch (error) { CPCall.leaveCall(false); clearCallUI(); alert(friendlyMediaError(error)); }
    finally { startingCall = false; voiceCallButton.disabled = videoCallButton.disabled = false; }
  }
  async function cancelOutgoingCall() {
    try { await CPCall.cancelFriendCall(); }
    catch (error) { console.warn("ส่ง CANCEL ไม่สำเร็จ:", error); }
    finally { CPCall.leaveCall(false); clearCallUI(); }
  }
  async function declineIncomingCall() {
    const signal = incomingCallSignal;
    if (!signal) return;
    try { await CPCall.declineFriendCall(signal); }
    catch (error) { callStatus(error.message); return; }
    CPCall.leaveCall(false); clearCallUI();
  }
  async function acceptIncomingCall() {
    if (!incomingCallSignal || acceptingCall) return;
    const signal = incomingCallSignal;
    acceptingCall = true;
    for (const button of [voiceCallAccept,voiceCallDecline,videoCallAccept,videoCallDecline]) if (button) button.disabled = true;
    callStatus("กำลังเปิดไมค์และเชื่อมต่อ...");
    try {
      await CPCall.acceptFriendCall(signal);
      if (incomingCallSignal !== signal) return;
      incomingCallSignal = null;
      armNoPeerTimeout();
      showIncomingActions(false);
      callStatus("กำลังเชื่อมต่อ..."); syncCallControls();
    } catch (error) {
      if (incomingCallSignal === signal) callStatus(friendlyMediaError(error));
    } finally {
      acceptingCall = false;
      for (const button of [voiceCallAccept,voiceCallDecline,videoCallAccept,videoCallDecline]) if (button) button.disabled = false;
    }
  }
  async function resumePendingIncomingCall() {
    const raw = sessionStorage.getItem("cp-pending-call");
    if (!raw) return;
    sessionStorage.removeItem("cp-pending-call");
    let signal;
    try { signal = JSON.parse(raw); } catch (_) { return; }
    if (!signal?.fromUserId || !signal.roomId) return;
    if (!signal.receivedAt || Date.now() - signal.receivedAt > PENDING_CALL_MAX_AGE_MS) {
      console.warn("[friend] ข้ามสายเรียกเข้าที่เก่าเกินไป", signal);
      return;
    }
    currentFriendId = signal.fromUserId; currentRoomId = signal.roomId;
    currentFriendName = signal.fromName || "เพื่อน";
    currentFriendImage = signal.fromImage || "/images/avatar-placeholder.svg";
    showIncomingCall(signal);
    await acceptIncomingCall();
  }
  function showIncomingCall(signal) {
    incomingCallSignal = signal;
    callInfo = {friendId:signal.fromUserId,roomId:signal.roomId,name:signal.fromName || "เพื่อน",image:signal.fromImage};
    const open = signal.mode === "VIDEO" ? openVideoCallUI : openVoiceCallUI;
    open(callInfo.name,callInfo.image,signal.mode === "VIDEO" ? "สายวิดีโอเข้า" : "สายเรียกเข้า",true);
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(() => {
      if (incomingCallSignal !== signal || acceptingCall) return;
      console.warn("[friend] สายเรียกเข้าหมดเวลา (ไม่มี CANCEL จากผู้โทร) → ปิดหน้าจอ");
      clearCallUI();
    }, RING_TIMEOUT_MS + 5000);
  }
  // If the media connection fails and does not recover (ICE restart) within 15s, end the call.
  let mediaFailTimer = null;
  window.addEventListener("cp-call-connected", () => { clearTimeout(mediaFailTimer); mediaFailTimer = null; callStatus("กำลังสนทนา"); startCallTimer(); syncCallControls(); });
  window.addEventListener("cp-call-mode-changed", event => {
    if (event.detail?.mode !== "VIDEO" || !callInfo) return;
    openVideoCallUI(callInfo.name,callInfo.image,"กำลังสนทนา");
    syncCallControls();
  });
  window.addEventListener("cp-call-media-state", () => syncCallControls());
  window.addEventListener("cp-call-error", event => {
    callStatus(event.detail?.message || "การเชื่อมต่อขาดหาย");
    const mediaFailed = event.detail?.reason === "media-failed" || event.detail?.message === "เชื่อมต่อสื่อไม่สำเร็จ กรุณาลองโทรใหม่";
    if (!mediaFailed || !CPCall.isActive() || !callInfo || mediaFailTimer) return;
    const failedCall = callInfo;
    mediaFailTimer = setTimeout(() => {
      mediaFailTimer = null;
      if (callInfo !== failedCall || !CPCall.isActive()) return;
      console.warn("[friend] เชื่อมต่อสื่อไม่กลับมาภายใน 15 วินาที → วางสาย");
      CPCall.leaveCall(); clearCallUI();
      alert("การเชื่อมต่อขาดหาย สายถูกตัด");
    }, 15000);
  });
  window.addEventListener("cp-call-ended", () => { CPCall.leaveCall(false); clearCallUI(); });
  window.addEventListener("cp-call-signal", async event => {
    const signal = event.detail;
    if (!signal) return;
    if (signal.type === "INVITE") {
      if (CPCall.isBusy() || incomingCallSignal || startingCall) { CPCall.declineFriendCall(signal).catch(console.error); return; }
      showIncomingCall(signal); return;
    }
    if (!callInfo || String(signal.fromUserId) !== String(callInfo.friendId) || String(signal.roomId) !== String(callInfo.roomId)) return;
    if (signal.type === "ACCEPT") {
      if (incomingCallSignal || CPCall.isActive()) return;
      clearRingTimers();
      const accepted = callInfo;
      try { await CPCall.joinRoomCall(callInfo.roomId, signal.mode || currentCallMode); callStatus("กำลังเชื่อมต่อ..."); syncCallControls(); armNoPeerTimeout(); }
      catch (error) {
        // User hung up while we were connecting: clearCallUI() already ran, nothing to report.
        if (callInfo !== accepted) return;
        await cancelOutgoingCall(); alert(friendlyMediaError(error));
      }
    }
    if (signal.type === "DECLINE" || signal.type === "CANCEL") { CPCall.leaveCall(false); clearCallUI(); }
  });
  voiceCallButton?.addEventListener("click", () => startCall("VOICE"));
  videoCallButton?.addEventListener("click", () => startCall("VIDEO"));
  voiceCallAccept?.addEventListener("click", acceptIncomingCall);
  videoCallAccept?.addEventListener("click", acceptIncomingCall);
  voiceCallDecline?.addEventListener("click", declineIncomingCall);
  videoCallDecline?.addEventListener("click", declineIncomingCall);
  async function closeOrDecline() {
    if (incomingCallSignal) { await declineIncomingCall(); return; }
    if (CPCall.isActive()) { CPCall.leaveCall(); clearCallUI(); }
    else await cancelOutgoingCall();
  }
  voiceCallClose?.addEventListener("click", closeOrDecline);
  if (voiceCallEnd)
    voiceCallEnd.addEventListener("click", async () => {
      if (CPCall.isActive?.()) { CPCall.leaveCall(); clearCallUI(); }
      else if (currentCallMode === "VOICE") { await cancelOutgoingCall(); }
    });
  if (videoCallClose) videoCallClose.addEventListener("click", closeOrDecline);
  if (videoCallEnd)
    videoCallEnd.addEventListener("click", async () => {
      if (CPCall.isActive?.()) { CPCall.leaveCall(); clearCallUI(); }
      else if (currentCallMode === "VIDEO") { await cancelOutgoingCall(); }
    });
  if (voiceCallMute) voiceCallMute.addEventListener("click", () => { CPCall.toggleMicrophone(); syncCallControls(); });
  videoCallMute?.addEventListener("click", () => { CPCall.toggleMicrophone(); syncCallControls(); });
  voiceCallSpeaker?.addEventListener("click", () => { speakerMuted = !speakerMuted; syncCallControls(); });
  voiceCallUpgrade?.addEventListener("click", async () => {
    voiceCallUpgrade.disabled = true;
    callStatus("กำลังเปิดกล้อง...");
    try { await CPCall.upgradeToVideo(); }
    catch (error) { callStatus(friendlyMediaError(error)); }
    finally { syncCallControls(); }
  });
  videoCallCamera?.addEventListener("click", async () => {
    videoCallCamera.disabled = true;
    try { await CPCall.toggleCamera(); }
    catch (error) { callStatus(friendlyMediaError(error)); }
    finally { syncCallControls(); }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !CPCall.isActive() && !acceptingCall && currentCallMode) closeOrDecline();
  });
  // Closing / refreshing the tab while the call is not connected yet: stop the other side ringing.
  // beforeunload fires before call.js's pagehide handler (which closes the STOMP socket).
  // Mobile browsers may skip beforeunload; the ring timeouts cover that case.
  window.addEventListener("beforeunload", () => {
    if (!callInfo || CPCall.isActive()) return;
    const type = incomingCallSignal ? "DECLINE" : "CANCEL";
    CPCall.wsPublish("/app/call", { type, toUserId: callInfo.friendId, roomId: callInfo.roomId });
  });
  window.addEventListener("pagehide", () => { disconnectRoomWebSocket(); CPCall.leaveCall(); stopCallTimer(); });


  /*
   * =========================================================
   * START
   * =========================================================
   */

  try {
    await CPCall.loadMe();
    CPCall.connectWS();
  } catch (error) { console.error("เริ่มระบบรับสายไม่สำเร็จ:", error); }
  await loadCurrentUser();

  const hasPendingCall =
    sessionStorage.getItem("cp-pending-call") !== null;

  if (hasPendingCall) {
    await resumePendingIncomingCall();

    loadFriends().catch((error) => {
      console.error("โหลดรายชื่อเพื่อนล้มเหลว:", error);
    });
  } else {
    await loadFriends();
  }
});

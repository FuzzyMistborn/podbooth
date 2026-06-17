// ── Chat ─────────────────────────────────────────────────────────────────────

async function sendChat() {
  const text = chatInput?.value.trim();
  if (!text) return;
  chatInput.value = '';
  appendChatMessage(identity, displayName, text, true);
  await broadcastData({ type: 'chat', identity, displayName, text });
}

function appendChatMessage(senderIdentity, senderName, text, own) {
  if (!chatMessages) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg' + (own ? ' own' : '');
  const name = document.createElement('div');
  name.className = 'chat-msg-name';
  name.textContent = senderName;
  const body = document.createElement('div');
  body.className = 'chat-msg-text';
  body.textContent = text;
  msg.appendChild(name);
  msg.appendChild(body);
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (chatPanel?.classList.contains('open')) {
    btnChat?.classList.remove('chat-unread');
  }
}

// ── Raise hand ───────────────────────────────────────────────────────────────

async function toggleHand() {
  if (handRaised) {
    handRaised = false;
    btnRaiseHand?.classList.remove('active');
    removeFromQueue(identity);
    raisedHands.delete(identity);
    updateHandIndicator(identity, false);
    updateHandQueue();
    await broadcastData({ type: 'hand_lowered', identity });
  } else {
    handRaised = true;
    btnRaiseHand?.classList.add('active');
    if (!raisedHands.has(identity)) {
      handQueue.push({ identity, displayName });
    }
    raisedHands.set(identity, displayName);
    updateHandIndicator(identity, true);
    updateHandQueue();
    await broadcastData({ type: 'hand_raised', identity, displayName });
  }
}

async function clearHand(targetIdentity) {
  removeFromQueue(targetIdentity);
  raisedHands.delete(targetIdentity);
  updateHandIndicator(targetIdentity, false);
  updateHandQueue();
  // Sender never receives their own broadcast, so reset local state directly
  if (targetIdentity === identity) {
    handRaised = false;
    btnRaiseHand?.classList.remove('active');
  }
  await broadcastData({ type: 'hand_cleared', identity: targetIdentity });
}

function removeFromQueue(id) {
  const idx = handQueue.findIndex(h => h.identity === id);
  if (idx !== -1) handQueue.splice(idx, 1);
}

function updateHandQueue() {
  const panel = document.getElementById('hand-queue-panel');
  const list  = document.getElementById('hand-queue-list');
  if (!panel || !list) return;
  list.innerHTML = '';
  handQueue.forEach(({ identity: id, displayName: name }) => {
    const li = document.createElement('li');
    li.className = 'hand-queue-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    li.appendChild(nameSpan);
    if (IS_HOST) {
      const btn = document.createElement('button');
      btn.className = 'hand-queue-clear';
      btn.textContent = '×';
      btn.title = 'Lower hand';
      btn.addEventListener('click', () => clearHand(id));
      li.appendChild(btn);
    }
    list.appendChild(li);
  });
  panel.style.display = handQueue.length ? 'flex' : 'none';
}

function updateHandIndicator(participantIdentity, raised) {
  const tile = document.getElementById(`tile-${participantIdentity}`);
  if (!tile) return;
  const hand = tile.querySelector('.tile-hand');
  if (!hand) return;
  hand.style.display = raised ? 'flex' : 'none';
  tile.classList.toggle('hand-raised', raised);
}

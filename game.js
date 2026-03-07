// ── Socket.io connection ──────────────────────────────────────────────────────
const socket = io();

// ── Global state ─────────────────────────────────────────────────────────────
let myName = "";
let myRoomCode = "";
let isOrganizer = false;
let gameState = null;   // latest game_state from server
let mySelectedVote = null;  // endgame vote
let hasVotedAppeal = false;
let hasVotedEndgame = false;
let timerInterval = null;

// ── Node layout (must match server NODE_POSITIONS, scaled to 800×420) ────────
const NODE_POS = {
  hub: [400, 22],
  1: [142, 95],  2: [400, 95],  3: [658, 95],
  4: [49, 183],  5: [187, 183], 6: [347, 183], 7: [507, 183], 8: [658, 183],
  9: [36, 276],  10: [142, 276], 11: [253, 276], 12: [369, 276],
  13: [484, 276], 14: [604, 276],
  15: [89, 369],  16: [200, 369], 17: [316, 369], 18: [436, 369],
  19: [556, 369], 20: [671, 369],
};

const GRAPH = {
  hub: [1,2,3],
  1: ["hub",2,4,5], 2: ["hub",1,3,6], 3: ["hub",2,7,8],
  4: [1,5,9], 5: [1,4,6,10], 6: [2,5,7,11], 7: [3,6,8,12], 8: [3,7,13,14],
  9: [4,10,15], 10: [5,9,11,16], 11: [6,10,12,17], 12: [7,11,13,18],
  13: [8,12,14,19], 14: [8,13,15,20], 15: [9,14,16,20], 16: [10,15,17],
  17: [11,16,18], 18: [12,17,19], 19: [13,18,20], 20: [14,15,19],
};

const IMAGE_VALUES = {
  1:1,2:1,3:1,4:1, 5:2,6:2,7:2,8:2,
  9:3,10:3,11:3,12:3, 13:4,14:4,15:4,16:4, 17:5,18:5,19:5,20:5
};
const PLAYER_COLORS = ["#E74C3C","#3498DB","#2ECC71","#F39C12","#9B59B6","#1ABC9C"];
const NODE_R = 28;      // image node radius
const HUB_R = 18;       // hub radius

// ── Canvas setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById("board-canvas");
const ctx = canvas.getContext("2d");
const nodeImages = {};  // node_id → HTMLImageElement

function preloadImages(callback) {
  let loaded = 0;
  const total = 20;
  const fileMap = {};
  for (let i = 1; i <= 20; i++) fileMap[i] = i === 14 ? "14.png" : `${i}.jpg`;
  for (let i = 1; i <= 20; i++) {
    const img = new Image();
    img.onload = () => { loaded++; if (loaded === total) callback(); };
    img.onerror = () => { loaded++; if (loaded === total) callback(); };
    img.src = `/static/images/${fileMap[i]}`;
    nodeImages[i] = img;
  }
}

// ── Board Drawing ─────────────────────────────────────────────────────────────
function drawBoard() {
  if (!gameState) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const phase = gameState.phase;
  const selected = gameState.selected_images || [];
  const currentNode = gameState.current_player ? gameState.current_player.current_node : "hub";
  const allPlayerNodes = (gameState.players || []).map(p => p.current_node);

  // Draw edges
  ctx.strokeStyle = "#3A3A6A";
  ctx.lineWidth = 2;
  const drawnEdges = new Set();
  for (const [from, neighbors] of Object.entries(GRAPH)) {
    const fromKey = from === "hub" ? "hub" : parseInt(from);
    const fp = NODE_POS[fromKey];
    if (!fp) continue;
    for (const to of neighbors) {
      const edgeKey = [String(fromKey), String(to)].sort().join("-");
      if (drawnEdges.has(edgeKey)) continue;
      drawnEdges.add(edgeKey);
      const tp = NODE_POS[to];
      if (!tp) continue;
      ctx.beginPath();
      ctx.moveTo(fp[0], fp[1]);
      ctx.lineTo(tp[0], tp[1]);
      ctx.stroke();
    }
  }

  // Determine adjacent nodes for move phase
  let adjacentNodes = [];
  if (phase === "move") {
    adjacentNodes = (GRAPH[currentNode] || []).filter(n => n !== "hub");
  }

  // Draw image nodes (1-20)
  for (let n = 1; n <= 20; n++) {
    const [x, y] = NODE_POS[n];
    const isSelected = selected.includes(n);
    const isAdjacent = adjacentNodes.includes(n);
    const hasPlayer = allPlayerNodes.includes(n);

    // Outer ring
    ctx.beginPath();
    ctx.arc(x, y, NODE_R + 4, 0, Math.PI * 2);
    if (isSelected) {
      ctx.fillStyle = "#FFD700";
    } else if (isAdjacent && phase === "move") {
      ctx.fillStyle = "#2ECC71";
    } else {
      ctx.fillStyle = "#2A2A4A";
    }
    ctx.fill();

    // Clip and draw image
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
    ctx.clip();
    const img = nodeImages[n];
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x - NODE_R, y - NODE_R, NODE_R * 2, NODE_R * 2);
    } else {
      ctx.fillStyle = "#1E1E3E";
      ctx.fillRect(x - NODE_R, y - NODE_R, NODE_R * 2, NODE_R * 2);
    }
    ctx.restore();

    // Node number label
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.beginPath();
    ctx.arc(x - NODE_R + 12, y + NODE_R - 12, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#FFF";
    ctx.font = "bold 9px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(n, x - NODE_R + 12, y + NODE_R - 12);

    // Value badge (top-right)
    const val = IMAGE_VALUES[n];
    ctx.fillStyle = val >= 5 ? "#E74C3C" : val >= 4 ? "#E67E22" : val >= 3 ? "#F1C40F" : val >= 2 ? "#2ECC71" : "#95A5A6";
    ctx.beginPath();
    ctx.arc(x + NODE_R - 10, y - NODE_R + 10, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = "bold 8px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(val, x + NODE_R - 10, y - NODE_R + 10);

    // Player token ring
    if (hasPlayer) {
      const pIdx = allPlayerNodes.indexOf(n);
      ctx.strokeStyle = PLAYER_COLORS[pIdx % PLAYER_COLORS.length];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, NODE_R + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Draw hub
  const [hx, hy] = NODE_POS.hub;
  ctx.beginPath();
  ctx.arc(hx, hy, HUB_R, 0, Math.PI * 2);
  const isHubAdjacent = phase === "move" && (GRAPH[currentNode] || []).includes("hub");
  ctx.fillStyle = isHubAdjacent ? "#2ECC71" : "#444466";
  ctx.fill();
  ctx.fillStyle = "#FFF";
  ctx.font = "bold 10px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("START", hx, hy);

  // Hub player tokens
  const hubPlayers = (gameState.players || []).filter(p => p.current_node === "hub");
  hubPlayers.forEach((p, i) => {
    const pIdx = (gameState.players || []).indexOf(p);
    const angle = (i / hubPlayers.length) * Math.PI * 2;
    const tx = hx + Math.cos(angle) * (HUB_R + 8);
    const ty = hy + Math.sin(angle) * (HUB_R + 8);
    ctx.beginPath();
    ctx.arc(tx, ty, 5, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[pIdx % PLAYER_COLORS.length];
    ctx.fill();
  });

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

// ── Canvas Click Handler ──────────────────────────────────────────────────────
canvas.addEventListener("click", function(e) {
  if (!gameState) return;
  const phase = gameState.phase;
  const isMyTurn = gameState.current_player_sid === getMySocketId();
  if (!isMyTurn) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top) * scaleY;

  // Check hub click in move phase
  if (phase === "move") {
    const [hx, hy] = NODE_POS.hub;
    const distHub = Math.hypot(mx - hx, my - hy);
    if (distHub <= HUB_R + 6) {
      const currentNode = gameState.current_player.current_node;
      if ((GRAPH[currentNode] || []).includes("hub")) {
        socket.emit("move_player", { node_id: "hub" });
        return;
      }
    }
  }

  // Check image node click
  for (let n = 1; n <= 20; n++) {
    const [x, y] = NODE_POS[n];
    const dist = Math.hypot(mx - x, my - y);
    if (dist <= NODE_R + 4) {
      if (phase === "move") {
        socket.emit("move_player", { node_id: n });
      } else if (phase === "select") {
        socket.emit("select_image", { node_id: n });
      }
      return;
    }
  }
});

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on("room_created", (data) => {
  myName = data.name;
  myRoomCode = data.code;
  isOrganizer = true;
});

socket.on("room_joined", (data) => {
  myName = data.name;
  myRoomCode = data.code;
  isOrganizer = data.is_organizer;
});

socket.on("lobby_update", (data) => {
  showScreen("lobby");
  document.getElementById("lobby-code").textContent = data.code || myRoomCode;
  const list = document.getElementById("lobby-players");
  list.innerHTML = "";
  (data.players || []).forEach(name => {
    const div = document.createElement("div");
    div.className = "player-item";
    div.textContent = name;
    list.appendChild(div);
  });
  const startBtn = document.getElementById("start-btn");
  const waitMsg = document.getElementById("waiting-msg");
  // Always update based on latest organizer info
  if (data.is_organizer) {
    startBtn.classList.remove("hidden");
    waitMsg.classList.add("hidden");
    isOrganizer = true;
  }
});

socket.on("game_state", (state) => {
  gameState = state;
  myRoomCode = state.room_code || myRoomCode;

  const phase = state.phase;

  if (phase === "final") {
    showScreen("endgame");
    renderFinalResults(state);
    stopTimer();
    return;
  }

  if (phase === "endgame") {
    showScreen("endgame");
    renderEndgameVoting(state);
    stopTimer();
    return;
  }

  showScreen("game");
  drawBoard();
  updateSidebar(state);
  updateActionPanel(state);
  updateConnectStatus(state);

  // Timer
  if (phase === "type" && state.timer_end) {
    startTimer(state.timer_end);
  } else {
    stopTimer();
  }
});

socket.on("validation_result", (result) => {
  // Handled via game_state broadcast; show reason if rejected
  if (!result.valid) {
    document.getElementById("reject-reason").textContent = result.reason || "המטפורה לא תקינה";
  }
});

socket.on("error", (data) => {
  const msg = data.message || "שגיאה";
  // Show error in the appropriate visible error element
  const homeErr = document.getElementById("home-error");
  const lobbyErr = document.getElementById("lobby-error");
  if (!document.getElementById("screen-home").classList.contains("hidden") &&
      document.getElementById("screen-home").classList.contains("active")) {
    showError(homeErr, msg);
  } else if (!document.getElementById("screen-lobby").classList.contains("hidden") &&
             document.getElementById("screen-lobby").classList.contains("active")) {
    showError(lobbyErr, msg);
  } else {
    alert(msg);
  }
});

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
}

function showError(el, msg) {
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

function getMySocketId() { return socket.id; }

function showPanel(id) {
  document.querySelectorAll(".phase-panel").forEach(p => p.classList.remove("active-panel"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active-panel");
}

// ── Sidebar Update ────────────────────────────────────────────────────────────
function updateSidebar(state) {
  const sb = document.getElementById("scoreboard");
  sb.innerHTML = "<div style='color:#FFD700;font-weight:700;margin-bottom:8px'>לוח תוצאות</div>";
  (state.players || []).forEach((p, i) => {
    const isActive = state.current_player && p.name === state.current_player.name;
    const row = document.createElement("div");
    row.className = "score-row" + (isActive ? " active-player" : "");
    row.innerHTML = `
      <span><span class="score-dot" style="background:${PLAYER_COLORS[i]}"></span>${p.name}</span>
      <span>${p.total_score} נק' | ${p.metaphor_count} מט'</span>
    `;
    sb.appendChild(row);
  });

  const ci = document.getElementById("current-player-info");
  if (state.current_player) {
    const p = state.current_player;
    const nodeLabel = p.current_node === "hub" ? "התחלה" : `צומת ${p.current_node}`;
    ci.innerHTML = `<b>תור:</b> ${p.name}<br><b>מיקום:</b> ${nodeLabel}`;
  } else {
    ci.innerHTML = "";
  }

  const phaseTexts = {
    move: "שלב: תנועה",
    select: "שלב: בחירת תמונות",
    type: "שלב: כתיבת מטפורה",
    validate: "שלב: אימות",
    rejected: "שלב: נדחה",
    appeal: "שלב: ערעור",
    endgame: "שלב: סיום",
  };
  document.getElementById("phase-hint").textContent = phaseTexts[state.phase] || "";
}

// ── Action Panel Update ───────────────────────────────────────────────────────
function updateActionPanel(state) {
  const phase = state.phase;
  const isMyTurn = state.current_player_sid === getMySocketId();

  if (!isMyTurn && !["appeal"].includes(phase)) {
    showPanel("panel-waiting");
    document.getElementById("panel-waiting").querySelector(".panel-title").textContent =
      `ממתין לתור של ${state.current_player ? state.current_player.name : "..."}`;
    return;
  }

  if (phase === "move" && isMyTurn) {
    showPanel("panel-move");
  } else if (phase === "select" && isMyTurn) {
    showPanel("panel-select");
    updateSelectInfo(state);
  } else if (phase === "type" && isMyTurn) {
    showPanel("panel-type");
    document.getElementById("timer-display").classList.remove("hidden");
  } else if (phase === "validate") {
    showPanel("panel-validate");
  } else if (phase === "rejected" && isMyTurn) {
    showPanel("panel-rejected");
    document.getElementById("timer-display").classList.add("hidden");
  } else if (phase === "appeal") {
    showPanel("panel-appeal");
    const pending = state.pending_metaphor;
    if (pending) {
      document.getElementById("appeal-metaphor-text").textContent = pending.text;
    }
    const voted = state.appeal_voted_sids || [];
    const needed = (state.players || []).length - 1;
    document.getElementById("appeal-vote-count").textContent =
      `הצביעו: ${voted.length} / ${needed}`;
    const alreadyVoted = voted.includes(getMySocketId());
    if (alreadyVoted) {
      document.getElementById("appeal-vote-btns").classList.add("hidden");
      document.getElementById("appeal-my-vote").classList.remove("hidden");
    } else if (isMyTurn) {
      // Current player can't vote on their own appeal
      document.getElementById("appeal-vote-btns").classList.add("hidden");
      document.getElementById("appeal-my-vote").textContent = "ממתין להצבעת השחקנים...";
      document.getElementById("appeal-my-vote").classList.remove("hidden");
    } else {
      document.getElementById("appeal-vote-btns").classList.remove("hidden");
      document.getElementById("appeal-my-vote").classList.add("hidden");
    }
  } else {
    showPanel("panel-waiting");
  }
}

function updateSelectInfo(state) {
  const imgs = state.selected_images || [];
  const connected = imgs.length <= 1 ? true : areConnected(imgs);
  const score = computeScore(imgs);
  const selInfo = document.getElementById("select-info");
  selInfo.innerHTML = `נבחרו: ${imgs.length} תמונות | ניקוד: ${score} | ${connected ? '<span style="color:#2ECC71">מחוברות ✓</span>' : '<span style="color:#E74C3C">לא מחוברות ✗</span>'}`;
  const btn = document.getElementById("confirm-sel-btn");
  btn.disabled = imgs.length < 2 || !connected;
}

function updateConnectStatus(state) {
  const el = document.getElementById("connect-status");
  if (state.phase !== "select") { el.textContent = ""; return; }
  const imgs = state.selected_images || [];
  if (imgs.length < 2) { el.textContent = ""; return; }
  const ok = areConnected(imgs);
  el.textContent = ok ? "✓ התמונות מחוברות במסלול" : "✗ התמונות אינן מחוברות";
  el.style.color = ok ? "#2ECC71" : "#E74C3C";
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer(endTs) {
  stopTimer();
  const el = document.getElementById("timer-sec");
  const disp = document.getElementById("timer-display");
  disp.classList.remove("hidden");
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil(endTs - Date.now() / 1000));
    el.textContent = remaining;
    disp.classList.toggle("urgent", remaining <= 10);
    if (remaining === 0) stopTimer();
  }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  document.getElementById("timer-display").classList.add("hidden");
  document.getElementById("timer-display").classList.remove("urgent");
}

// ── Graph Helpers (client-side mirror) ───────────────────────────────────────
function areConnected(nodes) {
  if (nodes.length <= 1) return true;
  const s = new Set(nodes);
  const visited = new Set([nodes[0]]);
  const queue = [nodes[0]];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (GRAPH[cur] || [])) {
      if (typeof nb === "number" && s.has(nb) && !visited.has(nb)) {
        visited.add(nb); queue.push(nb);
      }
    }
  }
  return visited.size === s.size;
}

function computeScore(imgs) {
  let sum = imgs.reduce((a, i) => a + (IMAGE_VALUES[i] || 0), 0);
  if (imgs.length >= 3) sum *= 2;
  return sum;
}

// ── Endgame ───────────────────────────────────────────────────────────────────
function renderEndgameVoting(state) {
  document.getElementById("endgame-winner-title").textContent =
    `${state.winner || ""} ניצח/ה!`;
  document.getElementById("endgame-voting").classList.remove("hidden");
  document.getElementById("endgame-results").classList.add("hidden");

  const list = document.getElementById("metaphor-vote-list");
  list.innerHTML = "";
  const alreadyVoted = state.endgame_voted_sids && state.endgame_voted_sids.includes(socket.id);

  (state.metaphors || []).forEach(m => {
    const card = document.createElement("div");
    card.className = "vote-card" + (mySelectedVote === m.id ? " selected-vote" : "");
    card.innerHTML = `<div class="vm-text">${escHtml(m.metaphor_text)}</div>
      <div class="vm-meta">${m.player_name} | סיבוב ${m.round_number} | ${m.score} נק'</div>`;
    if (!alreadyVoted && !hasVotedEndgame) {
      card.addEventListener("click", () => {
        mySelectedVote = m.id;
        socket.emit("endgame_vote", { metaphor_id: m.id });
        hasVotedEndgame = true;
        document.getElementById("endgame-voted-msg").classList.remove("hidden");
        document.querySelectorAll(".vote-card").forEach(c => c.classList.remove("selected-vote"));
        card.classList.add("selected-vote");
      });
    }
    list.appendChild(card);
  });

  if (alreadyVoted || hasVotedEndgame) {
    document.getElementById("endgame-voted-msg").classList.remove("hidden");
  }
}

function renderFinalResults(state) {
  document.getElementById("endgame-voting").classList.add("hidden");
  document.getElementById("endgame-results").classList.remove("hidden");

  const fs = document.getElementById("final-scores");
  fs.innerHTML = "";
  const sorted = [...(state.players || [])].sort((a,b) => b.total_score - a.total_score);
  sorted.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "final-row" + (i === 0 ? " winner-row" : "");
    row.innerHTML = `<span>${i+1}. ${p.name}</span><span>${p.total_score} נקודות | ${p.metaphor_count} מטפורות</span>`;
    fs.appendChild(row);
  });

  const best = (state.metaphors || []).find(m => m.is_best);
  const bm = document.getElementById("best-metaphor-display");
  if (best) {
    bm.innerHTML = `<b>המטפורה הטובה ביותר (${best.votes} קולות):</b><br>"${escHtml(best.metaphor_text)}" — ${best.player_name}`;
    bm.classList.remove("hidden");
  }

  const dlBtn = document.getElementById("download-excel-btn");
  dlBtn.href = `/download_excel?room=${myRoomCode}`;
}

// ── Home UI Actions ───────────────────────────────────────────────────────────
function showCreate() {
  document.getElementById("create-form").classList.toggle("hidden");
  document.getElementById("join-form").classList.add("hidden");
}
function showJoin() {
  document.getElementById("join-form").classList.toggle("hidden");
  document.getElementById("create-form").classList.add("hidden");
}
function createRoom() {
  const name = document.getElementById("create-name").value.trim();
  const apiKey = document.getElementById("create-apikey").value.trim();
  if (!name) { showError(document.getElementById("home-error"), "נא להזין שם"); return; }
  socket.emit("create_room", { name, api_key: apiKey });
}
function joinRoom() {
  const name = document.getElementById("join-name").value.trim();
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!name) { showError(document.getElementById("home-error"), "נא להזין שם"); return; }
  if (!code) { showError(document.getElementById("home-error"), "נא להזין קוד חדר"); return; }
  socket.emit("join_room_req", { name, room_code: code });
}
function startGame() {
  socket.emit("start_game", { room_code: myRoomCode });
}

// ── Game actions ──────────────────────────────────────────────────────────────
function confirmSelection() {
  socket.emit("confirm_selection", {});
}
function submitMetaphor() {
  const text = document.getElementById("metaphor-input").value.trim();
  if (!text) { alert("נא לכתוב מטפורה"); return; }
  socket.emit("submit_metaphor", { text });
  document.getElementById("metaphor-input").value = "";
}
function doAppeal() {
  socket.emit("appeal", {});
}
function skipTurn() {
  // Server auto-advances; client asks server to move on
  socket.emit("confirm_selection", {}); // won't work; need skip event
  // Actually just next_turn: handled by server timeout.
  // Add a dedicated event:
  socket.emit("skip_turn", {});
}
function castVote(approve) {
  socket.emit("cast_vote", { approve });
  document.getElementById("appeal-vote-btns").classList.add("hidden");
  document.getElementById("appeal-my-vote").classList.remove("hidden");
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Init ──────────────────────────────────────────────────────────────────────
preloadImages(() => {
  // Images ready; board will draw when first game_state arrives
});

// Allow Enter key on inputs
document.getElementById("create-name").addEventListener("keydown", e => { if(e.key==="Enter") createRoom(); });
document.getElementById("join-code").addEventListener("keydown", e => { if(e.key==="Enter") joinRoom(); });

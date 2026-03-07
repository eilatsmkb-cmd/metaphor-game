#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Flask + Flask-SocketIO server for משחק המטאפורות (web multiplayer version).
Run locally: python server.py
Deploy: gunicorn --worker-class eventlet -w 1 server:app
"""

import os
import time
import random
import string
import threading
from flask import Flask, render_template, request, send_file
from flask_socketio import SocketIO, join_room as sio_join_room, emit, rooms

import game_logic as gl

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "metaphor-game-secret-2024")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# In-memory room storage
# rooms_data[code] = {
#   "state": GameState,
#   "organizer_sid": str,
#   "api_key": str,
#   "player_sids": [sid, ...],   (ordered, matches state.players)
#   "pending_names": {sid: name},  (before game starts)
#   "created_at": float,
# }
rooms_data = {}

ROOM_TIMEOUT_SECONDS = 7200  # 2 hours


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _gen_code() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def _find_room_by_sid(sid: str):
    """Return (code, room_dict) for the room this sid is in, or (None, None)."""
    for code, room in rooms_data.items():
        if sid == room.get("organizer_sid"):
            return code, room
        if sid in room.get("player_sids", []):
            return code, room
        if sid in room.get("pending_names", {}):
            return code, room
    return None, None


def _broadcast_state(code: str):
    """Emit current game_state to everyone in the room."""
    room = rooms_data.get(code)
    if not room or not room.get("state"):
        return
    state_dict = room["state"].to_dict()
    state_dict["room_code"] = code
    socketio.emit("game_state", state_dict, room=code)


def _cleanup_old_rooms():
    now = time.time()
    expired = [c for c, r in rooms_data.items()
               if now - r.get("created_at", now) > ROOM_TIMEOUT_SECONDS]
    for c in expired:
        del rooms_data[c]


# ─── HTTP Routes ───────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/download_excel")
def download_excel():
    code = request.args.get("room", "").upper()
    room = rooms_data.get(code)
    if not room or not room.get("state"):
        return "Room not found", 404
    buf = gl.export_to_excel(room["state"])
    return send_file(
        buf,
        as_attachment=True,
        download_name="game_results.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


# ─── Socket Events ─────────────────────────────────────────────────────────────
@socketio.on("create_room")
def handle_create_room(data):
    _cleanup_old_rooms()
    name = (data.get("name") or "").strip()
    api_key = (data.get("api_key") or "").strip() or os.environ.get("ANTHROPIC_API_KEY", "")
    if not name:
        emit("error", {"message": "נא להזין שם"})
        return
    code = _gen_code()
    while code in rooms_data:
        code = _gen_code()
    rooms_data[code] = {
        "state": None,
        "organizer_sid": request.sid,
        "api_key": api_key,
        "player_sids": [],
        "pending_names": {request.sid: name},
        "created_at": time.time(),
    }
    sio_join_room(code)
    emit("room_created", {"code": code, "name": name})
    emit("lobby_update", {
        "code": code,
        "players": list(rooms_data[code]["pending_names"].values()),
        "is_organizer": True
    })


@socketio.on("join_room_req")
def handle_join_room(data):
    name = (data.get("name") or "").strip()
    code = (data.get("room_code") or "").strip().upper()
    if not name:
        emit("error", {"message": "נא להזין שם"})
        return
    if code not in rooms_data:
        emit("error", {"message": f"חדר {code} לא נמצא"})
        return
    room = rooms_data[code]
    if room.get("state"):
        emit("error", {"message": "המשחק כבר התחיל"})
        return
    total = len(room["pending_names"])
    if total >= 6:
        emit("error", {"message": "החדר מלא (מקסימום 6 שחקנים)"})
        return
    # Check duplicate name
    if name in room["pending_names"].values():
        emit("error", {"message": f"השם '{name}' כבר בשימוש בחדר זה"})
        return
    room["pending_names"][request.sid] = name
    sio_join_room(code)
    is_org = request.sid == room["organizer_sid"]
    emit("room_joined", {"code": code, "name": name, "is_organizer": is_org})
    socketio.emit("lobby_update", {
        "code": code,
        "players": list(room["pending_names"].values()),
        "is_organizer": False
    }, room=code)
    # Tell organizer specifically
    socketio.emit("lobby_update", {
        "code": code,
        "players": list(room["pending_names"].values()),
        "is_organizer": True
    }, to=room["organizer_sid"])


@socketio.on("start_game")
def handle_start_game(data):
    code = (data.get("room_code") or "").upper()
    room = rooms_data.get(code)
    if not room:
        emit("error", {"message": "חדר לא נמצא"})
        return
    if request.sid != room["organizer_sid"]:
        emit("error", {"message": "רק מארגן המשחק יכול להתחיל"})
        return
    if room.get("state"):
        emit("error", {"message": "המשחק כבר התחיל"})
        return
    pending = room["pending_names"]
    if len(pending) < 2:
        emit("error", {"message": "נדרשים לפחות 2 שחקנים"})
        return
    sids = list(pending.keys())
    names = [pending[s] for s in sids]
    room["player_sids"] = sids
    room["state"] = gl.GameState(names, sids)
    _broadcast_state(code)


@socketio.on("move_player")
def handle_move_player(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        emit("error", {"message": "לא התורשלך"})
        return
    if state.phase != "move":
        emit("error", {"message": "לא בשלב תנועה"})
        return
    node_id = data.get("node_id")
    if node_id == "hub":
        node_id = "hub"
    else:
        try:
            node_id = int(node_id)
        except (TypeError, ValueError):
            emit("error", {"message": "צומת לא תקין"})
            return
    current = state.current_player.current_node
    adjacent = gl.get_adjacent(current)
    if node_id not in adjacent:
        emit("error", {"message": "לא ניתן לזוז לצומת זה"})
        return
    state.current_player.current_node = node_id
    state.phase = "select"
    state.selected_images = []
    _broadcast_state(code)


@socketio.on("select_image")
def handle_select_image(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        emit("error", {"message": "לא התורשלך"})
        return
    if state.phase != "select":
        emit("error", {"message": "לא בשלב בחירה"})
        return
    try:
        node_id = int(data.get("node_id"))
    except (TypeError, ValueError):
        return
    if node_id < 1 or node_id > 20:
        return
    if node_id in state.selected_images:
        state.selected_images.remove(node_id)
    else:
        state.selected_images.append(node_id)
    _broadcast_state(code)


@socketio.on("confirm_selection")
def handle_confirm_selection(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        emit("error", {"message": "לא התורשלך"})
        return
    if state.phase != "select":
        return
    imgs = state.selected_images
    if len(imgs) < 2:
        emit("error", {"message": "יש לבחור לפחות 2 תמונות"})
        return
    if not gl.are_connected(imgs):
        emit("error", {"message": "התמונות אינן מחוברות במסלול"})
        return
    state.phase = "type"
    state.timer_end = time.time() + gl.TIMER_SECONDS
    _broadcast_state(code)
    # Start server-side timer to auto-skip if player doesn't submit
    def _auto_skip():
        time.sleep(gl.TIMER_SECONDS + 3)
        r = rooms_data.get(code)
        if r and r.get("state") and r["state"].phase == "type":
            r["state"].next_turn()
            _broadcast_state(code)
    threading.Thread(target=_auto_skip, daemon=True).start()


@socketio.on("submit_metaphor")
def handle_submit_metaphor(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        emit("error", {"message": "לא התורשלך"})
        return
    if state.phase != "type":
        return
    text = (data.get("text") or "").strip()
    images = list(state.selected_images)
    api_key = room.get("api_key", "")
    state.phase = "validate"
    state.pending_metaphor = {"text": text, "images": images,
                               "player_sid": request.sid,
                               "player_name": state.current_player.name}
    _broadcast_state(code)

    def _validate():
        result = gl.validate_metaphor(text, images, api_key)
        r = rooms_data.get(code)
        if not r or not r.get("state"):
            return
        s = r["state"]
        if s.phase != "validate":
            return
        result["text"] = text
        result["images"] = images
        socketio.emit("validation_result", result, room=code)
        if result.get("valid"):
            rec = s.add_metaphor(s.current_player, text, images)
            winner = s.check_winner()
            if winner:
                s.winner = winner
                s.game_over = True
                s.phase = "endgame"
                s.endgame_votes = {}
            else:
                s.pending_metaphor = None
                s.next_turn()
        else:
            s.phase = "rejected"
        _broadcast_state(code)

    threading.Thread(target=_validate, daemon=True).start()


@socketio.on("appeal")
def handle_appeal(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        emit("error", {"message": "לא התורשלך"})
        return
    if state.phase != "rejected":
        return
    # Collect other players' sids
    other_sids = [p.sid for p in state.players if p.sid != request.sid]
    if not other_sids:
        emit("error", {"message": "אין שחקנים אחרים להצביע"})
        return
    state.phase = "appeal"
    state.appeal_votes = {}
    state.appeal_voter_sids = other_sids
    _broadcast_state(code)


@socketio.on("cast_vote")
def handle_cast_vote(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.phase != "appeal":
        return
    if request.sid not in state.appeal_voter_sids:
        emit("error", {"message": "אינך מורשה להצביע"})
        return
    if request.sid in state.appeal_votes:
        emit("error", {"message": "כבר הצבעת"})
        return
    approve = bool(data.get("approve"))
    state.appeal_votes[request.sid] = approve
    # Check if all voted
    if len(state.appeal_votes) >= len(state.appeal_voter_sids):
        approve_count = sum(1 for v in state.appeal_votes.values() if v)
        reject_count = len(state.appeal_votes) - approve_count
        if approve_count > reject_count:
            # Accepted via appeal
            pending = state.pending_metaphor
            rec = state.add_metaphor(state.current_player,
                                     pending["text"], pending["images"])
            winner = state.check_winner()
            if winner:
                state.winner = winner
                state.game_over = True
                state.phase = "endgame"
                state.endgame_votes = {}
            else:
                state.pending_metaphor = None
                state.next_turn()
        else:
            # Rejected by vote
            state.pending_metaphor = None
            state.next_turn()
    _broadcast_state(code)


@socketio.on("endgame_vote")
def handle_endgame_vote(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.phase != "endgame":
        return
    metaphor_id = data.get("metaphor_id")
    if metaphor_id is None:
        return
    try:
        metaphor_id = int(metaphor_id)
    except (TypeError, ValueError):
        return
    # Each player votes once
    if request.sid in state.endgame_votes:
        return
    state.endgame_votes[request.sid] = metaphor_id
    # Check if all players voted
    if len(state.endgame_votes) >= len(state.players):
        _finalize_endgame(code, room)
    else:
        _broadcast_state(code)


def _finalize_endgame(code: str, room: dict):
    state = room["state"]
    # Tally votes
    tally: dict = {}
    for mid in state.endgame_votes.values():
        tally[mid] = tally.get(mid, 0) + 1
    if tally:
        best_id = max(tally, key=lambda k: tally[k])
        for m in state.all_metaphors:
            if m.metaphor_id == best_id:
                m.is_best = True
                m.votes = tally[best_id]
                # Add bonus to player
                for p in state.players:
                    if p.name == m.player_name:
                        p.total_score += gl.BEST_METAPHOR_BONUS
                        break
    state.phase = "final"
    _broadcast_state(code)


@socketio.on("skip_turn")
def handle_skip_turn(data):
    code, room = _find_room_by_sid(request.sid)
    if not room or not room.get("state"):
        return
    state = room["state"]
    if state.current_player.sid != request.sid:
        return
    if state.phase not in ("rejected", "type", "select"):
        return
    state.pending_metaphor = None
    state.next_turn()
    _broadcast_state(code)


@socketio.on("disconnect")
def handle_disconnect():
    code, room = _find_room_by_sid(request.sid)
    if not room:
        return
    # Remove from pending if not started
    if not room.get("state"):
        room["pending_names"].pop(request.sid, None)
        socketio.emit("lobby_update", {
            "code": code,
            "players": list(room["pending_names"].values()),
            "is_organizer": False
        }, room=code)
        if room["organizer_sid"] == request.sid and room["pending_names"]:
            # Promote next person as organizer
            new_org = next(iter(room["pending_names"]))
            room["organizer_sid"] = new_org
            socketio.emit("lobby_update", {
                "code": code,
                "players": list(room["pending_names"].values()),
                "is_organizer": True
            }, to=new_org)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=True)

"""serve/conversations.py - the web app's chat history: named conversations kept in a small sqlite database next to
the run config, the same way the Chat settings live in *.shared-settings.json (serve/server.py's svc.shared_path).
A different run config (a different model) gets its own file, so switching models does not mix their histories.

    python -c "from serve.conversations import ConversationStore; print(ConversationStore('x.db').list())"
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path


class ConversationStore:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()                   # sqlite3 connections are not shared across threads
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
                       "messages TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS conversations_updated_at ON conversations(updated_at)")

    @contextlib.contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            db.execute("PRAGMA journal_mode=WAL")        # readers (the sidebar list) don't block a save in progress
            with db:                                      # commits on a clean exit, rolls back on an exception
                yield db
        finally:
            db.close()                                    # else the file stays locked open (Windows: can't delete it)

    def list(self) -> list[dict]:
        """Every conversation's summary (no messages: the sidebar list only), newest first."""
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT id, title, created_at, updated_at FROM conversations "
                              "ORDER BY updated_at DESC").fetchall()
        return [{"id": r[0], "title": r[1], "created_at": r[2], "updated_at": r[3]} for r in rows]

    def get(self, conv_id: str) -> dict | None:
        with self._lock, self._connect() as db:
            row = db.execute("SELECT id, title, messages, created_at, updated_at FROM conversations WHERE id = ?",
                             (conv_id,)).fetchone()
        if row is None:
            return None
        return {"id": row[0], "title": row[1], "messages": json.loads(row[2]), "created_at": row[3], "updated_at": row[4]}

    def save(self, conv_id: str | None, title: str, messages: list | None = None) -> dict | None:
        """Create or fully replace a conversation (`messages` given), or rename one in place (`messages` is None -
        `conv_id` must then name an existing conversation; None when it does not exist)."""
        title = (title or "").strip()[:200] or "New chat"
        now = time.time()
        with self._lock, self._connect() as db:
            if messages is None:
                if not conv_id:
                    raise ValueError("\"id\" is required to rename a conversation")
                row = db.execute("SELECT created_at FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                if row is None:
                    return None
                db.execute("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", (title, now, conv_id))
                return {"id": conv_id, "title": title, "created_at": row[0], "updated_at": now}
            conv_id = conv_id or uuid.uuid4().hex
            existing = db.execute("SELECT created_at FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            created_at = existing[0] if existing else now
            db.execute("INSERT INTO conversations (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
                       "ON CONFLICT(id) DO UPDATE SET title = excluded.title, messages = excluded.messages, "
                       "updated_at = excluded.updated_at", (conv_id, title, json.dumps(messages), created_at, now))
            return {"id": conv_id, "title": title, "created_at": created_at, "updated_at": now}

    def delete(self, conv_id: str) -> bool:
        with self._lock, self._connect() as db:
            return db.execute("DELETE FROM conversations WHERE id = ?", (conv_id,)).rowcount > 0

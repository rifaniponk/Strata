"""serve/test_conversations.py - the chat sidebar's storage (serve/conversations.py) and its HTTP endpoints.

    python -m unittest serve.test_conversations -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.conversations import ConversationStore  # noqa: E402
from serve.frontend import ChatTemplate  # noqa: E402
from serve.server import ByteTokenizer, MockEngine, Service, serve  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConversationStore(str(Path(self.tmp.name) / "conversations.db"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_creates_an_id_and_get_round_trips_the_messages(self):
        msgs = [{"role": "user", "text": "hi"}]
        saved = self.store.save(None, "First chat", msgs)
        self.assertTrue(saved["id"])
        got = self.store.get(saved["id"])
        self.assertEqual(got["title"], "First chat")
        self.assertEqual(got["messages"], msgs)
        self.assertEqual(got["created_at"], got["updated_at"])

    def test_save_with_an_existing_id_replaces_it_in_place(self):
        first = self.store.save(None, "A", [{"role": "user", "text": "1"}])
        second = self.store.save(first["id"], "B", [{"role": "user", "text": "2"}])
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(second["created_at"], first["created_at"])   # the original creation time is kept
        got = self.store.get(first["id"])
        self.assertEqual(got["title"], "B")
        self.assertEqual(got["messages"], [{"role": "user", "text": "2"}])
        self.assertEqual(len(self.store.list()), 1)                  # replaced, not a second row

    def test_rename_keeps_the_messages(self):
        saved = self.store.save(None, "A", [{"role": "user", "text": "1"}])
        renamed = self.store.save(saved["id"], "B")
        self.assertEqual(renamed["title"], "B")
        self.assertEqual(self.store.get(saved["id"])["messages"], [{"role": "user", "text": "1"}])

    def test_rename_of_a_missing_conversation_returns_none(self):
        self.assertIsNone(self.store.save("no-such-id", "B"))

    def test_rename_without_an_id_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.save(None, "B")

    def test_list_is_newest_first(self):
        a = self.store.save(None, "A", [])
        b = self.store.save(None, "B", [])
        self.assertEqual([c["id"] for c in self.store.list()], [b["id"], a["id"]])

    def test_delete(self):
        saved = self.store.save(None, "A", [])
        self.assertTrue(self.store.delete(saved["id"]))
        self.assertIsNone(self.store.get(saved["id"]))
        self.assertFalse(self.store.delete(saved["id"]))             # already gone


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tok = ByteTokenizer()
        cls.engine = MockEngine(tok, "</think>\n\nok")
        cls.svc = Service(cls.engine, tok, ChatTemplate(ROOT / "serve/chat_template.jinja"))
        cls.tmp = tempfile.TemporaryDirectory()
        cls.svc.conversations = ConversationStore(str(Path(cls.tmp.name) / "conversations.db"))
        cls.httpd = serve(cls.svc, port=0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def test_round_trip_through_the_http_api(self):
        status, body = self.call("GET", "/api/conversations")
        self.assertEqual((status, body["conversations"]), (200, []))

        status, saved = self.call("POST", "/api/conversations",
                                  {"title": "Trip", "messages": [{"role": "user", "text": "hi"}]})
        self.assertEqual(status, 200)
        conv_id = saved["id"]

        status, body = self.call("GET", f"/api/conversations/{conv_id}")
        self.assertEqual((status, body["title"], body["messages"]), (200, "Trip", [{"role": "user", "text": "hi"}]))

        status, body = self.call("GET", "/api/conversations")
        self.assertEqual([c["id"] for c in body["conversations"]], [conv_id])

        status, body = self.call("POST", "/api/conversations", {"id": conv_id, "title": "Renamed"})
        self.assertEqual((status, body["title"]), (200, "Renamed"))
        self.assertEqual(self.call("GET", f"/api/conversations/{conv_id}")[1]["messages"], [{"role": "user", "text": "hi"}])

        status, body = self.call("DELETE", f"/api/conversations/{conv_id}")
        self.assertEqual((status, body["deleted"]), (200, True))
        self.assertEqual(self.call("GET", f"/api/conversations/{conv_id}")[0], 404)

    def test_missing_conversation_is_404(self):
        self.assertEqual(self.call("GET", "/api/conversations/no-such-id")[0], 404)
        self.assertEqual(self.call("DELETE", "/api/conversations/no-such-id")[1]["deleted"], False)

    def test_messages_must_be_a_list(self):
        status, body = self.call("POST", "/api/conversations", {"title": "Bad", "messages": "nope"})
        self.assertEqual(status, 400)
        self.assertIn("messages", body["error"]["message"])

    def test_without_a_run_config_the_api_is_disabled_gracefully(self):
        svc = Service(self.engine, ByteTokenizer(), ChatTemplate(ROOT / "serve/chat_template.jinja"))
        httpd = serve(svc, port=0)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with urllib.request.urlopen(base + "/api/conversations", timeout=10) as r:
                self.assertEqual(json.loads(r.read())["conversations"], [])   # list: empty, not an error
            req = urllib.request.Request(base + "/api/conversations/x")
            try:
                urllib.request.urlopen(req, timeout=10)
                self.fail("expected 404")
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()

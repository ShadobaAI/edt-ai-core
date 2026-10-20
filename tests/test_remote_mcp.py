import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from remote_client import RemoteMcp, RemoteRpcError
from mcp_pages import all_pages


class Response(io.BytesIO):
    def __init__(self, body, content_type="application/json", status=200, session="fixture-session"):
        super().__init__(body)
        self.headers = {"Content-Type": content_type, "Mcp-Session-Id": session}
        self.status = status


class RemoteTransport(unittest.TestCase):
    def test_initialize_and_session_reuse(self):
        result = {"jsonrpc": "2.0", "id": 1,
                  "result": {"protocolVersion": "2024-11-05", "capabilities": {}}}
        with patch("urllib.request.urlopen", side_effect=[
            Response(json.dumps(result).encode()), Response(b"", status=202)
        ]) as call:
            client = RemoteMcp("http://127.0.0.1:1/mcp")
            client.initialize()
            self.assertEqual(client.initialization, result["result"])
            notification = call.call_args_list[1].args[0]
            self.assertEqual(notification.get_header("Mcp-session-id"), "fixture-session")

    def test_shared_stateless_endpoint_does_not_create_or_delete_sessions(self):
        initialized = {"id": 1, "result": {"protocolVersion": "2025-03-26",
                       "capabilities": {"tools": {}}, "instructions": "Read only corpus"}}
        replies = [Response(json.dumps(initialized).encode(), session=None),
                   Response(b"", status=202, session=None)]
        with patch("urllib.request.urlopen", side_effect=[*replies,
            Response(json.dumps(initialized).encode(), session=None),
            Response(b"", status=202, session=None),
            Response(b'{"id":2,"result":{"tools":[]}}', session=None)
        ]) as calls:
            first = RemoteMcp("http://127.0.0.1:1/mcp")
            second = RemoteMcp(first.url)
            first.initialize(); second.initialize()
            first.close()
            self.assertEqual(first.initialization, {})
            self.assertEqual(second.initialization["instructions"], "Read only corpus")
            self.assertEqual(second.request("tools/list"), {"tools": []})
            second.close()
            self.assertEqual(calls.call_count, 5)
            self.assertTrue(all(item.args[0].get_method() == "POST" for item in calls.call_args_list))
            self.assertEqual(calls.call_args_list[-1].args[0].get_header("Mcp-protocol-version"), "2025-03-26")

    def test_sse_response(self):
        body = b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'
        with patch("urllib.request.urlopen", return_value=Response(body, "text/event-stream")):
            result = RemoteMcp("http://127.0.0.1:1/mcp").request("tools/list")
            self.assertEqual(result, {"tools": []})

    def test_uncertain_mutation_is_never_retried(self):
        with patch("urllib.request.urlopen", return_value=Response(b'{"id":999,"result":{}}')) as call:
            with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
                RemoteMcp("http://127.0.0.1:1/mcp").request("tools/call", {"name": "write"})
            self.assertEqual(call.call_count, 1)

    def test_empty_acceptance_does_not_confirm_a_mutation(self):
        for status in (202, 204):
            with self.subTest(status=status), patch("urllib.request.urlopen", return_value=Response(b"", status=status)) as call:
                with self.assertRaisesRegex(RuntimeError, "outcome unknown"):
                    RemoteMcp("http://127.0.0.1:1/mcp").request("tools/call", {"name": "write"})
                self.assertEqual(call.call_count, 1)

    def test_sse_notification_invalidates_the_catalogue_without_losing_the_result(self):
        body = (b'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'
                b'data: {"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":false}}\n\n')
        with patch("urllib.request.urlopen", return_value=Response(body, "text/event-stream")):
            client = RemoteMcp("http://127.0.0.1:1/mcp")
            result = client.request("tools/call", {"name": "change_surface"})
            self.assertEqual(client.tools_revision, 1)
            self.assertEqual(result, {"content": [], "isError": False})

    def test_missing_continuation_is_not_an_empty_optional_catalogue(self):
        class PartialCatalogue:
            def request(self, method, params):
                if not params:
                    return {"resources": [{"uri": "fixture://first"}], "nextCursor": "second"}
                raise RemoteRpcError({"code": -32601, "message": "Missing continuation"})
        with self.assertRaisesRegex(RuntimeError, "Incomplete resources/list pagination") as caught:
            all_pages(PartialCatalogue(), "resources/list", "resources")
        self.assertNotIsInstance(caught.exception, RemoteRpcError)

    def test_closing_one_session_leaves_the_other_session_bound(self):
        def reply(request_id, session):
            return Response(json.dumps({"id": request_id, "result": {}}).encode(), session=session)
        with patch("urllib.request.urlopen", side_effect=[
            reply(1, "one"), Response(b"", status=202, session="one"),
            reply(1, "two"), Response(b"", status=202, session="two"),
            Response(b"", status=204, session="one"), reply(2, "two")
        ]) as calls:
            first, second = RemoteMcp("http://127.0.0.1:1/mcp"), RemoteMcp("http://127.0.0.1:2/mcp")
            first.initialize(); second.initialize()
            first.close()
            self.assertIsNone(first.session)
            self.assertEqual(second.session, "two")
            second.request("tools/list")
            self.assertEqual(calls.call_args_list[4].args[0].get_method(), "DELETE")
            self.assertEqual(calls.call_args_list[4].args[0].get_header("Mcp-session-id"), "one")
            self.assertEqual(calls.call_args_list[5].args[0].get_header("Mcp-session-id"), "two")


if __name__ == "__main__":
    unittest.main()


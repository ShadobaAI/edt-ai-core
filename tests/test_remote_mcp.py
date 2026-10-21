import io
import json
from pathlib import Path
import sys
import threading
import urllib.error
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from remote_client import RemoteMcp, RemoteRpcError, RemoteSessionExpired, RemoteHttpError, header_value
from mcp_pages import all_pages


class Response(io.BytesIO):
    def __init__(self, body, content_type="application/json", status=200, session="fixture-session"):
        super().__init__(body)
        self.headers = {"Content-Type": content_type, "Mcp-Session-Id": session}
        self.status = status


class RemoteTransport(unittest.TestCase):
    def test_initialize_and_session_reuse(self):
        modern_error = {"jsonrpc": "2.0", "id": 1,
                        "error": {"code": -32601, "message": "server/discover unavailable"}}
        result = {"jsonrpc": "2.0", "id": 1,
                  "result": {"protocolVersion": "2024-11-05", "capabilities": {}}}
        with patch("urllib.request.urlopen", side_effect=[
            Response(json.dumps(modern_error).encode()),
            Response(json.dumps(result).encode()), Response(b"", status=202)
        ]) as call:
            client = RemoteMcp("http://127.0.0.1:1/mcp")
            client.initialize()
            self.assertEqual(client.initialization, result["result"])
            self.assertIsNone(call.call_args_list[1].args[0].get_header("Mcp-protocol-version"))
            notification = call.call_args_list[2].args[0]
            self.assertEqual(notification.get_header("Mcp-session-id"), "fixture-session")

    def test_modern_discovery_uses_stateless_headers(self):
        discovered = {"jsonrpc": "2.0", "id": 1, "result": {
            "supportedVersions": ["2026-07-28"], "capabilities": {},
            "instructions": "modern"}}
        listed = {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}
        with patch("urllib.request.urlopen", side_effect=[
            Response(json.dumps(discovered).encode(), session=None),
            Response(json.dumps(listed).encode(), session=None),
        ]) as calls:
            client = RemoteMcp("http://127.0.0.1:1/mcp")
            client.initialize()
            self.assertEqual(client.protocol, "2026-07-28")
            client.request("tools/list")
            discover = calls.call_args_list[0].args[0]
            self.assertEqual(discover.get_header("Mcp-method"), "server/discover")
            self.assertIsNone(discover.get_header("Mcp-session-id"))
            listing = calls.call_args_list[1].args[0]
            self.assertEqual(listing.get_header("Mcp-method"), "tools/list")
            self.assertIsNone(listing.get_header("Mcp-session-id"))

    def test_shared_stateless_endpoint_does_not_create_or_delete_sessions(self):
        initialized = {"id": 1, "result": {"protocolVersion": "2025-03-26",
                       "capabilities": {"tools": {}}, "instructions": "Read only corpus"}}
        modern_error = {"jsonrpc": "2.0", "id": 1,
                        "error": {"code": -32601, "message": "legacy"}}
        replies = [Response(json.dumps(modern_error).encode(), session=None),
                   Response(json.dumps(initialized).encode(), session=None),
                   Response(b"", status=202, session=None)]
        with patch("urllib.request.urlopen", side_effect=[*replies,
            Response(json.dumps(modern_error).encode(), session=None),
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
            self.assertEqual(calls.call_count, 7)
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
            return Response(json.dumps({"id": request_id, "result": {"protocolVersion": "2024-11-05"}}).encode(), session=session)
        modern_error = json.dumps({"jsonrpc": "2.0", "id": 1,
                                   "error": {"code": -32601, "message": "legacy"}}).encode()
        with patch("urllib.request.urlopen", side_effect=[
            Response(modern_error, session=None), reply(1, "one"), Response(b"", status=202, session="one"),
            Response(modern_error, session=None), reply(1, "two"), Response(b"", status=202, session="two"),
            Response(b"", status=204, session="one"), reply(2, "two")
        ]) as calls:
            first, second = RemoteMcp("http://127.0.0.1:1/mcp"), RemoteMcp("http://127.0.0.1:2/mcp")
            first.initialize(); second.initialize()
            first.close()
            self.assertIsNone(first.session)
            self.assertEqual(second.session, "two")
            second.request("tools/list")
            self.assertEqual(calls.call_args_list[6].args[0].get_method(), "DELETE")
            self.assertEqual(calls.call_args_list[6].args[0].get_header("Mcp-session-id"), "one")
            self.assertEqual(calls.call_args_list[7].args[0].get_header("Mcp-session-id"), "two")

    def test_http_400_is_not_treated_as_expired_session(self):
        import urllib.error
        error = urllib.error.HTTPError("http://127.0.0.1:1/mcp", 400, "Bad Request", {}, io.BytesIO())
        with patch("urllib.request.urlopen", side_effect=error):
            client = RemoteMcp("http://127.0.0.1:1/mcp")
            client.session = "fixture-session"
            with self.assertRaises(RuntimeError) as caught:
                client.request("tools/list")
            self.assertNotIsInstance(caught.exception, RemoteSessionExpired)

    def test_modern_http_headers_are_validated_over_a_real_connection(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                params, method = message["params"], message["method"]
                requests.append((message, dict(self.headers)))
                expected_name = params.get("uri" if method == "resources/read" else "name")
                valid = (self.headers.get("Mcp-Method") == method
                         and self.headers.get("MCP-Protocol-Version") == params["_meta"]["io.modelcontextprotocol/protocolVersion"]
                         and not self.headers.get("Mcp-Session-Id"))
                if expected_name:
                    valid = valid and self.headers.get("Mcp-Name") == header_value(expected_name)
                if method == "tools/call":
                    valid = valid and self.headers.get("Mcp-Param-Tenant") == header_value(params["arguments"]["context"]["tenant"])
                result = {"resultType": "complete"}
                if method == "server/discover":
                    result.update(supportedVersions=["2026-07-28"], capabilities={})
                if method == "tools/list":
                    result["tools"] = [{"name": "lookup", "inputSchema": {"properties": {
                        "context": {"type": "object", "properties": {
                            "tenant": {"type": "string", "x-mcp-header": "Tenant"}}}}}}]
                response = {"jsonrpc": "2.0", "id": message["id"]}
                response["result" if valid else "error"] = result if valid else {"code": -32020, "message": "Header mismatch"}
                payload = json.dumps(response).encode()
                self.send_response(200 if valid else 400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                # Even if a transitional gateway emits it, modern requests must
                # never acquire or reuse this session header.
                self.send_header("Mcp-Session-Id", "ignore-this-session")
                self.end_headers()
                self.wfile.write(payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = RemoteMcp(f"http://127.0.0.1:{server.server_port}/mcp")
            client.initialize()
            client.request("tools/list")
            client.request("tools/call", {"name": "lookup", "arguments": {"context": {"tenant": "Клиент"}}, "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2024-11-05",
                "io.modelcontextprotocol/clientCapabilities": {"roots": {}}}})
            client.request("resources/read", {"uri": "fixture://проект/данные"})
            client.request("prompts/get", {"name": "review"})
            self.assertIsNone(client.session)
            client.close()
            self.assertEqual(len(requests), 5)
            self.assertEqual(requests[2][0]["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"], {})
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_invalid_header_annotations_do_not_advertise_unusable_tools(self):
        client = RemoteMcp("http://127.0.0.1:1/mcp")
        client.protocol = client.MODERN_PROTOCOL
        bad_schemas = [
            {"properties": {"tenant": {"type": "object", "x-mcp-header": "Tenant"}}},
            {"properties": {"tenant": {"type": "string", "x-mcp-header": "bad name"}}},
            {"allOf": [{"properties": {"tenant": {"type": "string", "x-mcp-header": "Tenant"}}}]},
            {"properties": {"one": {"type": "string", "x-mcp-header": "Tenant"},
                            "two": {"type": "string", "x-mcp-header": "tenant"}}},
        ]
        tools = [{"name": str(i), "inputSchema": schema} for i, schema in enumerate(bad_schemas)]
        tools.append({"name": "valid", "inputSchema": {"type": "object"}})
        with patch.object(client, "send", return_value={"tools": tools}):
            self.assertEqual([t["name"] for t in client.request("tools/list")["tools"]], ["valid"])

    def test_negotiation_does_not_hide_auth_timeout_or_modern_protocol_errors(self):
        errors = [TimeoutError("server timed out"),
                  urllib.error.HTTPError("http://fixture/mcp", 401, "Unauthorized", {}, io.BytesIO()),
                  urllib.error.HTTPError("http://fixture/mcp", 400, "Bad Request", {}, io.BytesIO(json.dumps({
                      "error": {"code": -32020, "message": "Header mismatch"}}).encode()))]
        for error in errors:
            with self.subTest(error=error), patch("urllib.request.urlopen", side_effect=error) as calls:
                with self.assertRaises((TimeoutError, RemoteHttpError)):
                    RemoteMcp("http://fixture/mcp").initialize()
                self.assertEqual(calls.call_count, 1)

    def test_input_required_is_not_a_completed_mutation(self):
        with patch("urllib.request.urlopen", return_value=Response(b'{"id":1,"result":{"resultType":"input_required","inputRequests":[]}}')) as calls:
            with self.assertRaises(RuntimeError):
                RemoteMcp("http://fixture/mcp").request("tools/call", {"name": "write"})
            self.assertEqual(calls.call_count, 1)

    def test_unknown_http_method_does_not_expire_a_live_session(self):
        body = io.BytesIO(b'{"error":{"code":-32601,"message":"Method not found"}}')
        error = urllib.error.HTTPError("http://fixture/mcp", 404, "Not found", {}, body)
        client = RemoteMcp("http://fixture/mcp")
        client.session = "live"
        with patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaises(RemoteHttpError) as caught:
                client.request("prompts/list")
            self.assertEqual(caught.exception.rpc_error["code"], -32601)
        self.assertEqual(client.session, "live")


if __name__ == "__main__":
    unittest.main()


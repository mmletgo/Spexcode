"""在独立临时库和回环端点验证安装的 LLM Manager 与进程协议。"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, cast

HOST = Path(__file__).resolve().with_name("host.py")
SYNTHETIC_KEY = "synthetic-fixture-key-public-71e0"


class FixtureUpstream(BaseHTTPRequestHandler):
    """只在回环中验证真正转发到上游的路径、状态和合成凭据。"""

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_POST(self) -> None:
        request: dict[str, object] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert self.headers["x-api-key"] == SYNTHETIC_KEY
        assert request["model"] == "fixture-model"
        text = str(request.get("fixture", ""))
        path = self.path.partition("?")[0]
        assert path in ("/tenant/v1/messages", "/tenant/v1/messages/count_tokens")
        status = 429 if text == "limit" else 200
        if text == "redirect":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{cast(ThreadingHTTPServer, self.server).server_port}/forbidden")
            self.end_headers()
            return
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream" if text == "stream" else "application/json")
        self.end_headers()
        if text == "stream":
            self.wfile.write(b"event: message\ndata: {\"value\":\"" + SYNTHETIC_KEY[:12].encode())
            self.wfile.flush()
            self.wfile.write(SYNTHETIC_KEY[12:].encode() + b"\"}\n\n")
        else:
            self.wfile.write(b'{"fixture":true}')


class HostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.config = self.root / "host.json"
        self.database = self.root / "manager.sqlite"
        self.master = self.root / "master.key"
        self.config.write_text(json.dumps({
            "database": str(self.database), "owner_id": "fixture-owner", "group_id": "sync",
            "master_key_file": str(self.master), "catalog": [
                {"id": "sync", "label": "Sync", "fallback_when": "never", "max_concurrency": 1},
            ],
        }), encoding="utf-8")
        proc = subprocess.run([sys.executable, "-IB", str(HOST), "init", str(self.config)], capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(stat.S_IMODE(self.master.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.database.stat().st_mode), 0o600)

    def call(self, **message: Any) -> dict[str, Any]:
        result = subprocess.run(
            [sys.executable, "-IB", str(HOST), "rpc", str(self.config)],
            input=json.dumps(message), text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertNotIn(SYNTHETIC_KEY, result.stdout)
        return json.loads(result.stdout)

    def rpc(self, **message: Any) -> Any:
        response = self.call(**message)
        self.assertTrue(response["ok"], response)
        return response["value"]

    def settings(self, op: str, **body: Any) -> Any:
        return self.rpc(action="settings", body={"op": op, **body})

    def add_provider(self, id: str, **values: Any) -> dict[str, Any]:
        provider = {"id": id, "name": id, "enabled": True, "max_concurrency": 2,
                    "timeout_seconds": 3, "timezone": "UTC", "models": [], **values}
        self.settings("save_provider", input={"mode": "create", "provider": provider})
        return provider

    def add_api(self, base_url: str) -> dict[str, Any]:
        result = self.add_provider(
            "api", kind="api", api_format="anthropic-messages", base_url=base_url,
            models=[{"id": "api-model", "name": "fixture-model", "thinking_tiers": [
                {"id": "api-off", "thinking_effort": "off", "max_thinking_tokens": None},
            ]}],
        )
        key = self.settings("save_key", input={
            "action": "add", "provider_id": "api", "id": "fixture-key", "label": "Fixture",
            "secret": SYNTHETIC_KEY, "enabled": True,
        })
        self.assertEqual(set(key), {"id", "provider_id", "position", "label", "hint", "enabled"})
        return result

    def add_native(self, vendor: str, mode: str) -> None:
        self.add_provider(
            vendor, kind="cli", cli_vendor=vendor, model_mode=mode,
            models=[{"id": f"{vendor}-model", "name": f"{vendor}-configured"}],
        )

    def group(self, *providers: str) -> None:
        members = [{"id": f"{provider}-option", "model_id": f"{provider}-model", "provider_version": 1,
                    "thinking_tier_id": "api-off" if provider == "api" else None, "enabled": True} for provider in providers]
        self.settings("replace_group", group_id="sync", members=members)

    def reserve(self, route: dict[str, str], session: str) -> dict[str, Any]:
        return self.call(action="reserve", route=route, sessionId=session)

    def run_claude(
        self, route: dict[str, str], session: str, cli: Path, *args: str, sandbox: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "ANTHROPIC_API_KEY": "fixture-inherited", "ANTHROPIC_AUTH_TOKEN": "fixture-inherited",
               "CLAUDE_CODE_OAUTH_TOKEN": "fixture-inherited", "CLAUDE_CODE_USE_BEDROCK": "1"}
        options = ["--spex-sandbox-profile", sandbox] if sandbox is not None else []
        return subprocess.run(
            [sys.executable, "-IB", str(HOST), "claude", str(self.config), route["routeId"], session, str(cli), *options, *args],
            text=True, cwd=self.root, env=env, capture_output=True, start_new_session=True, timeout=15,
        )

    def test_configuration_and_one_authoritative_route_order(self) -> None:
        self.assertEqual(self.settings("catalog")["catalog"][0]["id"], "sync")
        self.add_api("http://127.0.0.1:9000/tenant")
        self.add_native("grok", "account")
        self.add_native("claude", "auto")
        self.add_native("zcode", "fixed")
        self.add_native("cursor", "fixed")
        self.add_native("codex", "fixed")
        self.group("grok", "claude", "api", "codex", "zcode", "cursor")
        route = self.rpc(action="resolve")
        for index, (vendor, model, kind) in enumerate([
            ("grok", "default", "cli"), ("claude", "default", "cli"),
            ("claude", "fixture-model", "anthropic-messages"), ("codex", "codex-configured", "cli"),
            ("zcode", "zcode-configured", "cli"), ("cursor", "cursor-configured", "cli"),
        ]):
            self.assertEqual((route["vendor"], route["model"], route["kind"]), (vendor, model, kind))
            self.assertRegex(route["routeId"], r"^[0-9a-f]{64}$")
            session = f"fixture-{index}"
            self.assertTrue(self.reserve(route, session)["ok"])
            self.assertEqual(self.rpc(action="settle", route=route, sessionId=session, outcome="quota"), {"outcome": "quota"})
            route = self.rpc(action="resolve", nextAfter=route)
        self.assertIsNone(route)
        self.assertEqual(len(self.settings("status")["breakers"]), 6)
        self.assertEqual(len(self.settings("list_keys", provider_id="api")["keys"]), 1)
        self.assertNotIn(SYNTHETIC_KEY.encode(), self.database.read_bytes())

    def test_codex_account_route_owns_the_session_and_usage(self) -> None:
        self.add_native("codex", "account")
        self.group("codex")
        route = self.rpc(action="resolve")
        self.assertIsNotNone(route)
        self.assertEqual((route["vendor"], route["model"], route["kind"]), ("codex", "default", "cli"))
        self.assertTrue(self.reserve(route, "codex-fixture")["ok"])
        self.assertIsNone(self.rpc(action="resolve"))
        self.assertEqual(self.rpc(action="settle", route=route, sessionId="codex-fixture", outcome="completed", usage={
            "inputTokens": 19, "outputTokens": 5,
        }), {"outcome": "completed"})
        report = self.settings("query_usage", query={"window": "24h"})
        self.assertEqual(report["call_count"], 1)
        row, = report["slices"]
        self.assertEqual((row["provider_id"], row["input_tokens"], row["output_tokens"]), ("codex", 19, 5))
        self.assertEqual(self.rpc(action="resolve"), route)

    def test_exact_binding_concurrency_and_idempotent_settlement(self) -> None:
        provider = self.add_api("http://127.0.0.1:9000/tenant")
        self.group("api")
        route = self.rpc(action="resolve")
        self.assertEqual(self.call(action="resolve", nextAfter=route)["code"], "llm_manager_quota_required")
        self.settings("save_provider", input={"mode": "update", "provider": {**provider, "name": "New name"}})
        self.assertEqual(self.reserve(route, "stale-version")["code"], "llm_manager_route_stale")
        route = self.rpc(action="resolve")
        self.settings("save_key", input={"action": "replace_secret", "provider_id": "api", "id": "fixture-key", "secret": "synthetic-rotated-key"})
        self.assertEqual(self.reserve(route, "stale-key")["code"], "llm_manager_route_stale")
        route = self.rpc(action="resolve")
        with ThreadPoolExecutor(max_workers=4) as pool:
            a, b, c, d = pool.map(lambda id: self.reserve(route, id), ["fixture-a", "fixture-a", "fixture-b", "fixture-b"])
        self.assertEqual(a, b)
        self.assertEqual(c, d)
        self.assertEqual(sum(response["ok"] for response in (a, c)), 1)
        chosen = "fixture-a" if a["ok"] else "fixture-b"
        loser = "fixture-b" if a["ok"] else "fixture-a"
        self.assertEqual(self.rpc(action="settle", route=route, sessionId=loser, outcome="quota"), {"outcome": "stopped"})
        self.assertEqual(self.settings("query_usage", query={"window": "24h"})["call_count"], 0)
        self.assertEqual(len(self.settings("status")["leases"]), 1)
        for _ in range(2):
            self.assertEqual(self.rpc(action="settle", route=route, sessionId=chosen, outcome="completed", usage={
                "inputTokens": 11, "outputTokens": 4, "cachedInputTokens": 2, "cacheCreationInputTokens": 3,
            }), {"outcome": "completed"})
        report = self.settings("query_usage", query={"window": "24h"})
        self.assertEqual([report[name] for name in ("call_count", "input_tokens", "output_tokens", "cache_read_tokens")], [1, 11, 4, 2])
        self.assertIsNotNone(self.settings("status")["leases"][0]["released_at"])

    def test_claude_exec_keeps_real_key_only_in_manager_and_follows_last_message(self) -> None:
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FixtureUpstream)
        thread = Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        self.add_api(f"http://127.0.0.1:{upstream.server_port}/tenant")
        self.add_native("grok", "account")
        self.group("api", "grok")
        self.assertTrue(self.settings("test", request={"provider_id": "api", "model_id": "api-model"})["ok"])
        route = self.rpc(action="resolve")
        cli = self.root / "controlled-claude"
        cli.write_text(f"#!{sys.executable}\n" + r'''
import json, os, pathlib, sys, urllib.error, urllib.request
assert pathlib.Path.cwd() == pathlib.Path(sys.argv[1])
assert os.getppid() == os.getpgrp()
key = os.environ["ANTHROPIC_API_KEY"]
assert len(key) >= 40 and "synthetic" not in key
assert os.environ["ANTHROPIC_BASE_URL"].startswith("http://127.0.0.1:")
assert not any(name in os.environ for name in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"))
if sys.platform == "darwin":
    for path in sys.argv[3:6]:
        try:
            pathlib.Path(path).read_bytes()
        except PermissionError:
            pass
        else:
            raise AssertionError("Claude CLI was able to read private Manager file")
    try:
        pathlib.Path(sys.argv[6]).write_text("blocked")
    except PermissionError:
        pass
    else:
        raise AssertionError("original native worktree write guard was lost")
def call(path, flag, status=200, model="fixture-model", token=key):
    url = os.environ["ANTHROPIC_BASE_URL"] + path
    req = urllib.request.Request(url, json.dumps({"model": model, "fixture": flag, "messages": []}).encode(), headers={"x-api-key":token})
    try:
        with urllib.request.urlopen(req, timeout=4) as result:
            assert result.status == status
            return result.read()
    except urllib.error.HTTPError as error:
        assert error.code == status, (error.code, status)
        return b""
call("/v1/messages", "limit", 401, token="wrong")
call("/v1/messages", "limit", 400, model="other-model")
call("/forbidden", "limit", 404)
call("/v1/messages", "redirect", 502)
assert b'event: message\ndata: {"value":"[redacted]"}\n\n' == call("/v1/messages?beta=true", "stream")
call("/v1/messages", "limit", 429)
if sys.argv[2] == "later-success":
    call("/v1/messages", "success")
call("/v1/messages/count_tokens", "success")
print("controlled native Claude received only a one-time loopback ticket")
sys.exit(19)
''', encoding="utf-8")
        cli.chmod(0o700)
        guard = self.root / "guarded-git-config"
        guard.write_text("unchanged", encoding="utf-8")
        sandbox = f"(version 1) (allow default) (deny file-write* (literal {json.dumps(str(guard))}))" if sys.platform == "darwin" else None
        for session, mode, outcome in [("first", "later-success", "stopped"), ("second", "quota-evidence", "quota")]:
            self.assertTrue(self.reserve(route, session)["ok"])
            result = self.run_claude(
                route, session, cli, str(self.root), mode, str(self.config), str(self.database), str(self.master), str(guard),
                sandbox=sandbox,
            )
            self.assertEqual(result.returncode, 19, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertIn("only a one-time loopback ticket", result.stdout)
            self.assertNotIn(SYNTHETIC_KEY, result.stdout + result.stderr)
            self.assertEqual(self.rpc(action="settle", route=route, sessionId=session, outcome="stopped"), {"outcome": outcome})
        self.assertEqual(self.rpc(action="resolve", nextAfter=route)["vendor"], "grok")
        self.assertEqual(guard.read_text(encoding="utf-8"), "unchanged")


if __name__ == "__main__":
    unittest.main()

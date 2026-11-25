"""在独立临时库和回环端点验证安装的 LLM Manager 与进程协议。"""

from __future__ import annotations

import json
import os
import sqlite3
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
        if text == "timeout":
            self.rfile.read(1)
            return
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

    def add_api(self, base_url: str, *, timeout: float = 3) -> dict[str, Any]:
        result = self.add_provider(
            "api", kind="api", api_format="anthropic-messages", base_url=base_url, timeout_seconds=timeout,
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
               "CLAUDE_CODE_OAUTH_TOKEN": "fixture-inherited", "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDECODE": "1"}
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

    def add_api_with_fixture(self, *, timeout: float = 3) -> None:
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), FixtureUpstream)
        thread = Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        self.add_api(f"http://127.0.0.1:{upstream.server_port}/tenant", timeout=timeout)

    def expire_api_cooldown(self) -> None:
        with sqlite3.connect(self.database) as database:
            expired = database.execute(
                "UPDATE llm_circuit_breaker SET cooldown_until = ? WHERE owner_id = ? AND (key_id = ? OR provider_id = ?)",
                ("2000-01-01 00:00:00.000000", "fixture-owner", "fixture-key", "api"),
            )
            self.assertEqual(expired.rowcount, 1)

    def test_same_group_anchor_restarts_preferred_order_after_cooldown(self) -> None:
        self.add_api_with_fixture()
        self.add_native("grok", "account")
        self.group("api", "grok")
        preferred = self.rpc(action="resolve")
        self.assertEqual(preferred["kind"], "anthropic-messages")
        self.assertTrue(self.reserve(preferred, "quota-fixture")["ok"])
        self.assertEqual(self.rpc(action="settle", route=preferred, sessionId="quota-fixture", outcome="quota"), {"outcome": "quota"})

        fallback = self.rpc(action="resolve")
        self.assertEqual(fallback["vendor"], "grok")
        self.assertEqual(self.rpc(action="resolve", sameGroupAs=fallback), fallback)

        self.expire_api_cooldown()
        self.assertEqual(self.rpc(action="resolve", sameGroupAs=fallback), preferred)
        self.assertEqual(self.settings("status")["breakers"], [])
        self.assertTrue(self.reserve(preferred, "successful-sibling")["ok"])
        self.assertEqual(self.rpc(action="settle", route=preferred, sessionId="successful-sibling", outcome="completed"), {"outcome": "completed"})
        successor = self.rpc(action="resolve", nextAfter=preferred)
        self.assertEqual(successor["vendor"], "grok")
        self.assertEqual(self.rpc(action="resolve", nextAfter=preferred, sameGroupAs=fallback), successor)
        self.assertEqual(self.rpc(action="resolve", nextAfter=preferred, sameGroupAs=fallback, failedSessionId="quota-fixture"), successor)
        self.assertEqual(self.call(action="resolve", nextAfter=preferred, sameGroupAs=fallback, failedSessionId="different-session")["code"], "llm_manager_quota_required")
        self.assertEqual(self.call(action="resolve", nextAfter=preferred, sameGroupAs=fallback, failedSessionId="successful-sibling")["code"], "llm_manager_quota_required")
        self.assertEqual(self.call(action="resolve", nextAfter=fallback, sameGroupAs=fallback)["code"], "llm_manager_quota_required")

        self.group("api")
        self.assertEqual(self.reserve(fallback, "stale-fallback")["code"], "llm_manager_route_stale")
        recovered = self.rpc(action="resolve", sameGroupAs=fallback)
        self.assertEqual(recovered["kind"], "anthropic-messages")
        self.assertEqual(recovered, self.rpc(action="resolve"))

    def test_same_group_anchor_rejects_another_owner_or_group(self) -> None:
        self.add_native("grok", "account")
        self.group("grok")
        anchor = self.rpc(action="resolve")
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["catalog"].append({"id": "other", "label": "Other", "fallback_when": "never", "max_concurrency": 1})
        self.config.write_text(json.dumps({**config, "group_id": "other"}), encoding="utf-8")
        self.settings("replace_group", group_id="other", members=[{
            "id": "other-option", "model_id": "grok-model", "provider_version": 1,
            "thinking_tier_id": None, "enabled": True,
        }])
        self.assertEqual(self.rpc(action="resolve")["vendor"], "grok")
        self.assertEqual(self.call(action="resolve", sameGroupAs=anchor)["code"], "llm_manager_route_stale")

        self.config.write_text(json.dumps({**config, "owner_id": "another-owner"}), encoding="utf-8")
        self.assertEqual(self.call(action="resolve", sameGroupAs=anchor)["code"], "llm_manager_route_stale")

    def test_claude_exec_keeps_real_key_only_in_manager_and_follows_last_message(self) -> None:
        self.add_api_with_fixture()
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
assert not any(name in os.environ for name in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE"))
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

        self.expire_api_cooldown()
        self.assertEqual(self.rpc(action="resolve"), route)
        self.assertEqual(self.settings("status")["breakers"], [])

    def test_claude_reports_only_latest_messages_upstream_timeout(self) -> None:
        self.add_api_with_fixture(timeout=1)
        self.add_native("grok", "account")
        self.group("api", "grok")
        preferred = self.rpc(action="resolve")
        self.assertEqual(preferred["kind"], "anthropic-messages")
        cli = self.root / "controlled-claude-timeout"
        cli.write_text(f"#!{sys.executable}\n" + '''
import json
import os
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

def call(path: str, flag: str) -> int:
    req = Request(
        os.environ["ANTHROPIC_BASE_URL"] + path,
        json.dumps({"model": "fixture-model", "fixture": flag, "messages": []}).encode(),
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"]},
    )
    try:
        with urlopen(req, timeout=4) as result:
            return result.status
    except HTTPError as error:
        return error.code

mode = sys.argv[1]
messages = "/v1/messages"
count_tokens = messages + "/count_tokens"
assert call(count_tokens if mode == "count-tokens" else messages, "timeout") == 502
if mode == "later-success":
    assert call(messages, "success") == 200
elif mode == "last-message":
    assert call(count_tokens, "success") == 200
sys.exit(19)
''', encoding="utf-8")
        cli.chmod(0o700)

        for mode in ("count-tokens", "later-success", "last-message"):
            with self.subTest(mode=mode):
                self.assertTrue(self.reserve(preferred, mode)["ok"])
                result = self.run_claude(preferred, mode, cli, mode)
                self.assertEqual(result.returncode, 19, result.stderr)
                breakers = self.settings("status")["breakers"]
                self.assertEqual(
                    self.rpc(action="settle", route=preferred, sessionId=mode, outcome="stopped"),
                    {"outcome": "stopped"},
                )
                self.assertEqual(self.call(action="resolve", nextAfter=preferred)["code"], "llm_manager_quota_required")
                status = self.settings("status")
                self.assertTrue(all(lease["released_at"] is not None for lease in status["leases"]))
                fresh = self.rpc(action="resolve", sameGroupAs=preferred)
                if mode == "last-message":
                    self.assertEqual(
                        [(breaker["scope"], breaker["provider_id"]) for breaker in breakers],
                        [("config", "api")],
                    )
                    self.assertEqual(status["breakers"], breakers)
                    self.assertEqual(fresh["vendor"], "grok")
                    self.expire_api_cooldown()
                    self.assertEqual(self.rpc(action="resolve", sameGroupAs=preferred), preferred)
                    self.assertEqual(self.settings("status")["breakers"], [])
                else:
                    self.assertEqual(breakers, [])
                    self.assertEqual(status["breakers"], [])
                    self.assertEqual(fresh, preferred)


if __name__ == "__main__":
    unittest.main()

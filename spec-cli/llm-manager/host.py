"""SpexCode 的可选 LLM Manager 宿主进程。"""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import stat
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from hashlib import sha256
from http.client import HTTPConnection, HTTPException, HTTPResponse, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BufferedIOBase
from pathlib import Path
from socket import socket
from sqlite3 import connect
from threading import Thread
from typing import Literal, Self, TypeAlias, cast
from urllib.parse import urlsplit

from llm_manager import (
    ApiFormat,
    BreakerScope,
    CapabilityError,
    CapacityError,
    CircuitBreaker,
    CliModelMode,
    CliVendor,
    ConflictError,
    DuplicateIdError,
    FailureReport,
    FeatureGroupSpec,
    GroupMemberWrite,
    GroupOption,
    GroupView,
    KeyView,
    Lease,
    LlmManager,
    LlmManagerError,
    MasterKeyRequiredError,
    NotFoundError,
    PricingPreference,
    ProbeRequest,
    ProbeResult,
    ProviderInUseError,
    ProviderKey,
    ProviderKind,
    ProviderUpdate,
    ProviderView,
    ProviderWrite,
    RevalidateRequest,
    RouteChoice,
    RouteDisposition,
    SettlementOutcome,
    SettlementRequest,
    ThinkingEffort,
    TokenUsage,
    UsageEvent,
    UsageKind,
    UsageReport,
    UsageSource,
    UsageWindow,
    create_schema,
    is_configured_available,
    reported_absent,
    validate_feature_group_catalog,
)
from llm_manager.catalog import provider_satisfies_capability_gate
from llm_manager.db import enable_sqlite_foreign_keys
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator
from sqlalchemy import ForeignKeyConstraint, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


class HostError(Exception):
    """宿主失败携带固定错误码，跨进程回复无需读取异常详情。"""


class HostConfig(BaseModel):
    """
    Business Logic（为什么需要这个类）:
        浏览器和派发调用统一由宿主配置绑定数据库、owner 和执行功能组。

    Code Logic（这个类做什么）:
        校验配置 JSON、绝对文件路径和 Manager 功能组定义。
    """

    model_config = ConfigDict(extra="forbid")

    database: Path
    owner_id: str = Field(min_length=1, max_length=128)
    group_id: str
    catalog: tuple[FeatureGroupSpec, ...]
    master_key_file: Path | None = None
    provider_capabilities: dict[str, tuple[str, ...]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_source(self) -> Self:
        """
        Business Logic（为什么需要这个函数）:
            宿主配置应选定存在的功能组，避免把密钥与数据库指向同一文件。

        Code Logic（这个函数做什么）:
            验证绝对路径、owner 和完整组清单，返回本配置。
        """

        key = self.master_key_file
        if not self.database.is_absolute() or not self.owner_id.strip():
            raise ValueError("database or owner")
        if key is not None and (not key.is_absolute() or key.resolve() == self.database.resolve()):
            raise ValueError("master key path")
        validate_feature_group_catalog(self.catalog)
        if all(group.id != self.group_id for group in self.catalog):
            raise ValueError("requested group")
        return self


Vendor: TypeAlias = Literal["grok", "claude", "zcode", "cursor", "codex"]
Outcome: TypeAlias = Literal["completed", "quota", "stopped"]
VENDORS = frozenset({CliVendor.claude, CliVendor.grok, CliVendor.zcode, CliVendor.cursor, CliVendor.codex})
TEXT = TypeAdapter(str, config=ConfigDict(strict=True))


class ManagedRoute(BaseModel):
    """宿主 model 只包含公开的路由标识、厂商、模型和运行类型。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    routeId: str = Field(pattern=r"^[0-9a-f]{64}$")
    vendor: Vendor
    model: str = Field(min_length=1, pattern=r"^[^\r\n\x00]+$")
    kind: Literal["cli", "anthropic-messages"]

    @model_validator(mode="after")
    def validate_execution(self) -> Self:
        """
        Business Logic（为什么需要这个函数）:
            API 路线只可交给 Claude，公开模型需能原样成为原生参数。

        Code Logic（这个函数做什么）:
            验证 API 厂商和模型边界空白，返回原路由。
        """

        if self.model != self.model.strip() or (self.kind == "anthropic-messages" and self.vendor != "claude"):
            raise ValueError("route execution")
        return self


class NativeUsage(BaseModel):
    """冻结原生执行器实际提供的计数，包括 Manager 当前不显示的缓存写入量。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    inputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    outputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    cachedInputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    cacheCreationInputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)


class RouteLookup(BaseModel):
    """选路可以从功能组首项开始，或承接已确认额度失败的冻结路线。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["resolve"]
    nextAfter: ManagedRoute | None = None


class RouteRequest(BaseModel):
    """正式名额和结算由同一 SpexCode session id 关联到冻结路线。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    route: ManagedRoute
    sessionId: str = Field(min_length=1, max_length=256, pattern=r"^[^\r\n\x00]+$")


class ReserveRequest(RouteRequest):
    """请求分配精确路线的 Manager 名额。"""

    action: Literal["reserve"]


class SettleRequest(RouteRequest):
    """正式调用完成、额度耗尽或确认停止后提交一次 Manager 结算。"""

    action: Literal["settle"]
    outcome: Outcome
    usage: NativeUsage | None = None


class SettingsRequest(BaseModel):
    """设置客户端只选择操作，不传入数据库及 owner。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["settings"]
    body: dict[str, object]


RPC = TypeAdapter[RouteLookup | ReserveRequest | SettleRequest | SettingsRequest](
    RouteLookup | ReserveRequest | SettleRequest | SettingsRequest
)


class HostTables(DeclarativeBase):
    """宿主自己的冻结与名额绑定以独立元数据建表，不能代替 Manager 迁移。"""


class RouteBinding(HostTables):
    """
    Business Logic（为什么需要这个类）:
        操作审查和恢复需要识别当初的路线，Manager 公开选路结果不负责冻结历史。

    Code Logic（这个类做什么）:
        持久化路由 id、公开路线和不带明文的选项快照、功能组游标及凭据 nonce 摘要。
    """

    __tablename__ = "spex_llm_route_binding"

    owner_id: Mapped[str] = mapped_column(primary_key=True)
    route_id: Mapped[str] = mapped_column(primary_key=True)
    request_group: Mapped[str]
    provider_id: Mapped[str]
    public_route: Mapped[str]
    provider_version: Mapped[int]
    key_nonce_digest: Mapped[str | None]
    tier_id: Mapped[str | None]
    snapshot: Mapped[str]


class RouteClaim(HostTables):
    """
    Business Logic（为什么需要这个类）:
        同一个 SpexCode session 多次请求准入或结算时只对应一次 Manager 调用。

    Code Logic（这个类做什么）:
        用 owner 和 session 唯一绑定 route、Manager 租约及首次终态。
        额度失败保存游标给出的后继；原生用量保留尚未进入 Manager 统计的列。
    """

    __tablename__ = "spex_llm_route_claim"

    owner_id: Mapped[str] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(primary_key=True)
    route_id: Mapped[str]
    lease_id: Mapped[str]
    outcome: Mapped[str | None]
    usage: Mapped[str | None]
    settled_at: Mapped[datetime | None]
    successor_id: Mapped[str | None]
    upstream_ordinal: Mapped[int] = mapped_column(default=0)
    upstream_status: Mapped[int | None]

    __table_args__ = (
        ForeignKeyConstraint(["owner_id", "route_id"], ["spex_llm_route_binding.owner_id", "spex_llm_route_binding.route_id"]),
    )


CHOICE = TypeAdapter(RouteChoice)
OBSERVABLE_ERRORS: tuple[tuple[type[Exception], str], ...] = (
    (CapacityError, "llm_manager_capacity"),
    (ConflictError, "llm_manager_conflict"),
    (ProviderInUseError, "llm_manager_provider_in_use"),
    (CapabilityError, "llm_manager_capability"),
    (DuplicateIdError, "llm_manager_duplicate"),
    (NotFoundError, "llm_manager_not_found"),
    (MasterKeyRequiredError, "llm_manager_master_key_required"),
    (LlmManagerError, "llm_manager_invalid"),
    (SQLAlchemyError, "llm_manager_database"),
    (ValueError, "llm_manager_invalid"),
    (OSError, "llm_manager_host_unavailable"),
)


def database(path: Path) -> Engine:
    """
    Business Logic（为什么需要这个函数）:
        RPC 只连接明确初始化的库，路径写错应当失败。

    Code Logic（这个函数做什么）:
        以 SQLite 读写模式打开已存在的文件并启用外键约束。
    """

    uri = f"{path.as_uri()}?mode=rw"
    engine = create_engine("sqlite://", creator=lambda: connect(uri, uri=True, timeout=10))
    enable_sqlite_foreign_keys(engine)
    return engine


def master_key(path: Path | None) -> bytes | None:
    """
    Business Logic（为什么需要这个函数）:
        API Key 要由库外的主密钥保护，CLI-only 配置可以不提供它。

    Code Logic（这个函数做什么）:
        从当前用户拥有的 0600 普通文件读入原始 AES 密钥，拒绝软链接和异常长度。
    """

    if path is None:
        return None
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid():
            raise HostError("llm_manager_master_key_permissions")
        key = reader.read(33)
    if len(key) not in (16, 24, 32):
        raise HostError("llm_manager_master_key_invalid")
    return key


def initialize(config: HostConfig) -> None:
    """
    Business Logic（为什么需要这个函数）:
        明确启用 SpexCode 宿主时才创建专用 Manager 库及可选主密钥。

    Code Logic（这个函数做什么）:
        以排他方式建立新数据库；密钥不存在时排他生成 32 字节随机文件。
        初始化失败时回滚本次新建的文件，已有文件由调用方另行管理。
    """

    if config.database.exists() or config.database.is_symlink():
        raise HostError("llm_manager_database_exists")
    created: list[Path] = []
    try:
        fd = os.open(config.database, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created.append(config.database)
        os.close(fd)
        if config.master_key_file is not None and not config.master_key_file.exists():
            fd = os.open(config.master_key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(config.master_key_file)
            with os.fdopen(fd, "wb") as writer:
                writer.write(os.urandom(32))
        key = master_key(config.master_key_file)
        engine = database(config.database)
        try:
            create_schema(engine)
            HostTables.metadata.create_all(engine)
            with Session(engine) as session:
                LlmManager(config.owner_id, session, key, config.catalog, provider_capabilities=config.provider_capabilities)
        finally:
            engine.dispose()
    except Exception:
        for path in reversed(created):
            path.unlink()
        raise


@contextmanager
def transaction(config: HostConfig, key: bytes | None) -> Iterator[LlmManager]:
    """
    Business Logic（为什么需要这个函数）:
        独立宿主进程不能同时抢到同一个 Manager 名额，也不能看见半次结算。

    Code Logic（这个函数做什么）:
        在读取或写入路线前取得 SQLite 写锁，让 Manager 保存点和宿主写入属于一个真实外层事务。
    """

    engine = database(config.database)
    try:
        with Session(engine) as session, session.begin():
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            yield LlmManager(config.owner_id, session, key, config.catalog, provider_capabilities=config.provider_capabilities)
    finally:
        engine.dispose()


def provider_transport(provider: ProviderView) -> bool:
    """
    Business Logic（为什么需要这个函数）:
        Manager 可以保存多种通道，SpexCode 只能派发其工作树执行器实际支持的通道。

    Code Logic（这个函数做什么）:
        判断宿主支持的无 Key 原生 CLI，或使用兼容 Anthropic Messages 的 API Provider。
    """

    if provider.kind == ProviderKind.cli:
        return provider.cli_vendor in VENDORS and not provider.keys
    return provider.api_format == ApiFormat.anthropic_messages


def execution_manager(manager: LlmManager, config: HostConfig, key: bytes | None) -> LlmManager:
    """
    Business Logic（为什么需要这个函数）:
        Manager 应按原功能组优先级与备用规则选择 SpexCode 实际可派发的成员。

    Code Logic（这个函数做什么）:
        将宿主执行器兼容性与起始组能力并成一条额外门槛，交给同 owner、同事务的 Manager。
    """

    capability = "spex-execution-transport-v1"
    requested = next(group for group in manager.catalog if group.id == config.group_id)
    capable = {
        provider.id: (capability,)
        for provider in manager.list_providers()
        if provider_transport(provider)
        and (key is not None or provider.kind == ProviderKind.cli)
        and provider_satisfies_capability_gate(requested, manager.provider_capabilities.get(provider.id, frozenset()))
    }
    gated = requested.model_copy(update={"required_capabilities": (capability,)})
    catalog = tuple(gated if group.id == config.group_id else group for group in manager.catalog)
    return LlmManager(manager.owner_id, manager.session, key, catalog, provider_capabilities=capable)


def probe_provider(
    base_url: str, api_format: ApiFormat, secret: str, model: str, timeout: float,
) -> ProbeResult:
    """
    Business Logic（为什么需要这个函数）:
        手动测试与正式选路试探都应验证配置的真实端点及认证，并向 Manager 报告分类。

    Code Logic（这个函数做什么）:
        对标准 API 发最短模型请求，自定义协议检查基础地址。不跟重定向，不读取响应正文。
    """

    target = urlsplit(base_url)
    if target.scheme not in ("http", "https") or not target.hostname or target.username is not None or target.query or target.fragment:
        return ProbeResult(ok=False, failure=FailureReport(scope=BreakerScope.config))
    path = target.path.rstrip("/")
    headers: dict[str, str] = {"content-type": "application/json"}
    payload: bytes | None = None
    if api_format == ApiFormat.anthropic_messages:
        path = path if path.endswith("/v1/messages") else f"{path.removesuffix('/v1')}/v1/messages"
        headers.update({"x-api-key": secret, "anthropic-version": "2023-06-01"})
    elif api_format == ApiFormat.openai_compat:
        path = path if path.endswith("/chat/completions") else f"{path or '/v1'}/chat/completions"
        headers["authorization"] = f"Bearer {secret}"
    else:
        headers["authorization"] = f"Bearer {secret}"
    if api_format != ApiFormat.custom:
        payload = json.dumps({"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "ping"}]}).encode()
    connect_http = HTTPSConnection if target.scheme == "https" else HTTPConnection
    try:
        connection = connect_http(target.hostname, target.port, timeout=min(timeout, 4.0))
        try:
            connection.request("GET" if payload is None else "POST", path or "/", body=payload, headers=headers)
            status = connection.getresponse().status
        finally:
            connection.close()
    except TimeoutError:
        return ProbeResult(ok=False, failure=FailureReport(transport="timeout"))
    except (OSError, HTTPException):
        return ProbeResult(ok=False, failure=FailureReport(transport="dns"))
    if 200 <= status < 300:
        return ProbeResult(ok=True)
    if status in (401, 402, 403, 429) or 500 <= status <= 599:
        return ProbeResult(ok=False, failure=FailureReport(status_code=status))
    return ProbeResult(ok=False, failure=FailureReport(scope=BreakerScope.config))


def manual_probe(request: ProbeRequest) -> ProbeResult:
    """
    Business Logic（为什么需要这个函数）:
        官方设置页测试使用 Manager 选择的真实凭据和模型。

    Code Logic（这个函数做什么）:
        将 Manager 测试请求交给宿主 HTTP 回调。
    """

    return probe_provider(request.base_url, request.api_format, request.secret, request.model_name, request.timeout_seconds)


def revalidate_api(request: RevalidateRequest) -> ProbeResult:
    """
    Business Logic（为什么需要这个函数）:
        API 冷却到期须通过 Manager 试探后才能重新派发。

    Code Logic（这个函数做什么）:
        用 Manager 提供的这把 Key 调同一 HTTP 探测，拒绝非法的跨种类请求。
    """

    if request.base_url is None or request.api_format is None or request.secret is None or request.model_name is None:
        raise HostError("llm_manager_route_stale")
    return probe_provider(request.base_url, request.api_format, request.secret, request.model_name, request.timeout_seconds)


def frozen_choice(binding: RouteBinding) -> RouteChoice:
    """
    Business Logic（为什么需要这个函数）:
        正式结算和后继选择要复用原 Manager 游标。

    Code Logic（这个函数做什么）:
        读取无凭据快照，构造只用于 Manager 记账与游标的 RouteChoice。
    """

    return CHOICE.validate_python({**json.loads(binding.snapshot), "secret": None})


def key_digest(manager: LlmManager, choice: RouteChoice) -> str | None:
    """
    Business Logic（为什么需要这个函数）:
        保存新 Key 正文时 Provider 的版本不变，宿主也要能拒绝原路线。

    Code Logic（这个函数做什么）:
        用 Manager 行的随机 nonce 摘要识别启用的 Key 版本，无需解密。
    """

    if choice.key_id is None:
        return None
    row = manager.session.get(ProviderKey, (manager.owner_id, choice.key_id))
    if row is None or row.provider_id != choice.provider_id or not row.enabled:
        raise HostError("llm_manager_route_stale")
    return sha256(row.nonce).hexdigest()


def bind_choice(manager: LlmManager, group: str, choice: RouteChoice) -> ManagedRoute:
    """
    Business Logic（为什么需要这个函数）:
        路由 id 要绑定实际执行的 Provider、版本、模型、思考档、凭据和后继位置。

    Code Logic（这个函数做什么）:
        从 Manager 选择创建可重放的无明文快照，计算 SHA-256 并只新增一次绑定。
    """

    provider = manager.get_provider(choice.provider_id)
    option = manager.session.get_one(GroupOption, (manager.owner_id, choice.option_id))
    vendor = "claude" if choice.kind == ProviderKind.api else choice.cli_vendor
    model = "default" if provider.model_mode in (CliModelMode.auto, CliModelMode.account) else choice.model_name
    kind = "anthropic-messages" if choice.kind == ProviderKind.api else "cli"
    snapshot = CHOICE.dump_python(choice, mode="json", exclude={"secret"})
    snapshot["cursor"]["skipped_option_ids"] = sorted(choice.cursor.skipped_option_ids)
    digest = key_digest(manager, choice)
    payload = json.dumps(
        [manager.owner_id, group, provider.version, digest, option.thinking_tier_id, snapshot, vendor, model, kind],
        sort_keys=True, separators=(",", ":"),
    )
    public = ManagedRoute.model_validate({"routeId": sha256(payload.encode()).hexdigest(), "vendor": vendor.value if isinstance(vendor, CliVendor) else vendor, "model": model, "kind": kind})
    if manager.session.get(RouteBinding, (manager.owner_id, public.routeId)) is None:
        manager.session.add(RouteBinding(
            owner_id=manager.owner_id, route_id=public.routeId, request_group=group, provider_id=provider.id,
            public_route=public.model_dump_json(), provider_version=provider.version, key_nonce_digest=digest,
            tier_id=option.thinking_tier_id, snapshot=json.dumps(snapshot, sort_keys=True),
        ))
    return public


def require_binding(manager: LlmManager, group: str, route: ManagedRoute) -> RouteBinding:
    """
    Business Logic（为什么需要这个函数）:
        路由 id 不能来自另一 owner 或功能组，也不能用其摘要替换公开模型。

    Code Logic（这个函数做什么）:
        按 owner 读取冻结记录，校验组与完整公开形状。
    """

    binding = manager.session.get(RouteBinding, (manager.owner_id, route.routeId))
    if binding is None or binding.request_group != group or binding.public_route != route.model_dump_json():
        raise HostError("llm_manager_route_stale")
    return binding


def is_current(manager: LlmManager, binding: RouteBinding, choice: RouteChoice) -> bool:
    """
    Business Logic（为什么需要这个函数）:
        准入前应核对冻结配置，结算也不能把原调用的熔断写到后来换掉的 Key。

    Code Logic（这个函数做什么）:
        检查 Provider 版本、能力资格、对应组成员和选项档位，以及 Key 版本与状态。
    """

    try:
        provider = manager.get_provider(choice.provider_id)
        digest = key_digest(manager, choice)
    except (NotFoundError, HostError):
        return False
    option = manager.session.get(GroupOption, (manager.owner_id, choice.option_id))
    return (
        provider.enabled and provider.version == binding.provider_version
        and provider_transport(provider) and provider.id in manager.provider_capabilities
        and digest == binding.key_nonce_digest
        and option is not None and option.enabled and option.group_id == choice.group_id
        and option.model_id == choice.model_id and option.thinking_tier_id == binding.tier_id
    )


def same_choice(current: RouteChoice, frozen: RouteChoice) -> bool:
    """
    Business Logic（为什么需要这个函数）:
        派发前重新验证路线可用时，应匹配原组、选项和 Key。

    Code Logic（这个函数做什么）:
        比较 Manager 本次返回的身份，Provider 版本、档位和 Key 版本另由冻结记录校验。
    """

    return (current.group_id, current.option_id, current.model_id, current.key_id) == (
        frozen.group_id, frozen.option_id, frozen.model_id, frozen.key_id,
    )


def ready_choice(manager: LlmManager, choice: RouteChoice | None) -> RouteChoice | None:
    """
    Business Logic（为什么需要这个函数）:
        只发出 Manager 正式判为 ready 的路线，过期的 API 熔断要先试探。

    Code Logic（这个函数做什么）:
        按原 Manager 游标试探 API 或跳过宿主不能选用的选项。
    """

    tried: set[tuple[str, str | None]] = set()
    while choice is not None:
        attempt = (choice.option_id, choice.key_id)
        if choice.provider_id not in manager.provider_capabilities or attempt in tried:
            choice = manager.skip_option(choice)
        elif choice.disposition == RouteDisposition.ready:
            return choice
        elif choice.kind == ProviderKind.api:
            tried.add(attempt)
            choice = manager.revalidate(choice, revalidate_api)
        else:
            choice = manager.skip_option(choice)
    return None


def resolve(manager: LlmManager, config: HostConfig, after: ManagedRoute | None) -> ManagedRoute | None:
    """
    Business Logic（为什么需要这个函数）:
        正常派发取当前首条可用路线，正式额度失败后的显式重试承接原游标。

    Code Logic（这个函数做什么）:
        首次调用 Manager resolve；后继读取同路线的额度结算与保存的 Manager 后继。
        后继已失效时沿后继游标再往下，避免回到已失败的本轮前缀。
    """

    if after is None:
        choice = ready_choice(manager, manager.resolve(config.group_id))
    else:
        old = require_binding(manager, config.group_id, after)
        claim = manager.session.scalars(select(RouteClaim).where(
            RouteClaim.owner_id == manager.owner_id, RouteClaim.route_id == old.route_id, RouteClaim.outcome == "quota",
        ).order_by(RouteClaim.settled_at.desc(), RouteClaim.session_id.desc()).limit(1)).first()
        if claim is None:
            raise HostError("llm_manager_quota_required")
        if claim.successor_id is None:
            choice = ready_choice(manager, manager.skip_option(frozen_choice(old)))
        else:
            binding = manager.session.get_one(RouteBinding, (manager.owner_id, claim.successor_id))
            frozen = frozen_choice(binding)
            current = manager.resolve(config.group_id)
            while current is not None and current.option_id != frozen.option_id:
                current = manager.skip_option(current)
            if (current is not None and same_choice(current, frozen)
                    and is_current(manager, binding, frozen) and current.disposition == RouteDisposition.ready):
                return ManagedRoute.model_validate_json(binding.public_route)
            choice = ready_choice(manager, manager.skip_option(frozen))
    return bind_choice(manager, config.group_id, choice) if choice is not None else None


def reserve(manager: LlmManager, config: HostConfig, request: ReserveRequest) -> None:
    """
    Business Logic（为什么需要这个函数）:
        每次派发只能在原冻结路线同时占用一次功能组和 Provider 名额。

    Code Logic（这个函数做什么）:
        核对冻结路线和当前就绪状态，同事务 acquire 并保存唯一 session claim；重复准入复用有效 claim。
    """

    binding = require_binding(manager, config.group_id, request.route)
    frozen = frozen_choice(binding)
    if not is_current(manager, binding, frozen):
        raise HostError("llm_manager_route_stale")
    claim = manager.session.get(RouteClaim, (manager.owner_id, request.sessionId))
    if claim is not None:
        if claim.route_id != binding.route_id or claim.outcome is not None:
            raise HostError("llm_manager_session_conflict")
        return
    choice = manager.resolve(config.group_id)
    while choice is not None:
        if choice.disposition == RouteDisposition.ready and same_choice(choice, frozen):
            lease = manager.acquire(frozen.group_id, frozen.provider_id)
            manager.session.add(RouteClaim(
                owner_id=manager.owner_id, session_id=request.sessionId, route_id=binding.route_id, lease_id=lease.id,
            ))
            return
        choice = manager.skip_option(choice)
    # Manager.resolve also skips full groups and Providers. Ask the same acquisition
    # gate, keeping the probe transaction from leaving a lease for an unavailable route.
    with manager.session.begin_nested() as probe:
        manager.acquire(frozen.group_id, frozen.provider_id)
        probe.rollback()
    raise HostError("llm_manager_route_unavailable")


SETTLEMENT_OUTCOMES = {
    "completed": SettlementOutcome.succeeded, "quota": SettlementOutcome.failed, "stopped": SettlementOutcome.cancelled,
}


def settle(manager: LlmManager, config: HostConfig, request: SettleRequest) -> dict[str, str]:
    """
    Business Logic（为什么需要这个函数）:
        原执行停止后要把调用事实、用量、熔断和名额释放一并交还 Manager。

    Code Logic（这个函数做什么）:
        只有精确 claim 能结算；同一 claim 保留首次结果。成功写 Manager 回执及用量，额度失败沿 Manager 游标计算后继。
    """

    claim = manager.session.get(RouteClaim, (manager.owner_id, request.sessionId))
    if claim is None:
        return {"outcome": "stopped"}
    binding = require_binding(manager, config.group_id, request.route)
    if claim.route_id != binding.route_id:
        raise HostError("llm_manager_session_conflict")
    if claim.outcome is not None:
        return {"outcome": claim.outcome}
    choice = frozen_choice(binding)
    usage = request.usage
    outcome = "quota" if request.outcome == "stopped" and claim.upstream_status == 429 else request.outcome
    moment = datetime.now(UTC)
    receipt = manager.settle(SettlementRequest(
        settlement_id=f"spex:{sha256(request.sessionId.encode()).hexdigest()}",
        invocation_id=request.sessionId, query_id=None, group_id=choice.group_id,
        provider_id=choice.provider_id, provider_name=choice.provider_name,
        model_id=choice.model_id, model_name=choice.model_name, thinking_effort=choice.thinking_effort,
        kind=UsageKind.call, source=UsageSource.group,
        outcome=SETTLEMENT_OUTCOMES[outcome], usage=TokenUsage(
            input_tokens=(usage.inputTokens or 0) if usage else 0,
            output_tokens=(usage.outputTokens or 0) if usage else 0,
            cache_read_tokens=(usage.cachedInputTokens or 0) if usage else 0,
        ), reported_query_cost=reported_absent(), preference=PricingPreference.reported,
        exact_prices={}, occurred_at=moment,
    ))
    if usage is None or not usage.model_dump(exclude_none=True):
        manager.session.get_one(UsageEvent, (manager.owner_id, receipt.usage_event_id)).usage_reported = False
    manager.release(claim.lease_id, now=moment)
    current = is_current(manager, binding, choice)
    if outcome == "completed" and current:
        manager.report_success(choice, now=moment)
    if outcome == "quota":
        successor = manager.report_failure(choice, FailureReport(status_code=429), now=moment) if current else manager.skip_option(choice, now=moment)
        successor = ready_choice(manager, successor)
        if successor is not None:
            claim.successor_id = bind_choice(manager, config.group_id, successor).routeId
    claim.outcome = outcome
    claim.usage = usage.model_dump_json(exclude_none=True) if usage else None
    claim.settled_at = moment
    return {"outcome": outcome}


class SaveProvider(BaseModel):
    """官方表单新建与整表更新共用 Manager Provider 写入定义。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    mode: Literal["create", "update"]
    provider: ProviderWrite


class KeyInput(BaseModel):
    """Key 表单的只写输入，序列化响应从 Manager 公开视图取得。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["add", "set_enabled", "replace_secret"]
    provider_id: str
    id: str
    label: str | None = None
    secret: str | None = Field(default=None, repr=False)
    enabled: bool | None = None


class TestInput(BaseModel):
    """官方设置组件可以用指定模型和思考档，或者测试 Provider 默认模型。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    provider_id: str
    model_id: str | None = None
    group_id: str | None = None
    thinking_effort: ThinkingEffort | None = None


class UsageInput(BaseModel):
    """用量查询支持固定时间窗或带时区的自定义范围。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    window: UsageWindow | None = None
    start: datetime | None = None
    end: datetime | None = None


STRINGS = TypeAdapter(list[str], config=ConfigDict(strict=True))
GROUP_MEMBERS = TypeAdapter(list[GroupMemberWrite], config=ConfigDict(strict=True))


def settings(manager: LlmManager, body: dict[str, object]) -> object:
    """
    Business Logic（为什么需要这个函数）:
        官方设置组件要管理正式派发所用的同一 owner、Provider、Key 和功能组，查看其状态与用量。

    Code Logic（这个函数做什么）:
        给各设置操作适配 Manager 的公开类型，并返回公开视图。
    """

    match body.get("op"):
        case "catalog":
            return {
                "catalog": [group.model_dump(mode="json") for group in manager.catalog],
                "providerCapabilities": {provider: sorted(names) for provider, names in manager.provider_capabilities.items()},
            }
        case "list_providers":
            return {"providers": manager.list_providers()}
        case "save_provider":
            request = SaveProvider.model_validate_json(json.dumps(body.get("input")))
            data = request.provider
            if data.base_url is not None:
                url = urlsplit(data.base_url)
                if url.scheme not in ("http", "https") or not url.hostname or url.username is not None or url.query or url.fragment:
                    raise HostError("llm_manager_invalid_url")
                _ = url.port
            if request.mode == "create":
                historical = manager.session.scalars(select(RouteBinding.route_id).where(
                    RouteBinding.owner_id == manager.owner_id, RouteBinding.provider_id == data.id,
                ).limit(1)).first()
                if historical is not None:
                    raise HostError("llm_manager_duplicate")
                return manager.create_provider(data)
            existing = manager.get_provider(data.id)
            if existing.kind != data.kind:
                raise HostError("llm_manager_invalid")
            return manager.update_provider(data.id, ProviderUpdate.model_validate(data.model_dump(exclude={"id", "kind"})))
        case "delete_provider":
            provider = TEXT.validate_python(body.get("provider_id"))
            lease = manager.session.scalars(select(Lease.id).where(
                Lease.owner_id == manager.owner_id, Lease.provider_id == provider, Lease.released_at.is_(None),
            ).limit(1)).first()
            if lease is not None:
                raise HostError("llm_manager_provider_in_use")
            manager.delete_provider(provider)
            return {}
        case "list_keys":
            return {"keys": manager.list_keys(TEXT.validate_python(body.get("provider_id")))}
        case "save_key":
            return save_key(manager, KeyInput.model_validate(body.get("input")))
        case "reorder_keys":
            return {"keys": manager.reorder_keys(TEXT.validate_python(body.get("provider_id")), STRINGS.validate_python(body.get("key_ids")))}
        case "delete_key":
            manager.delete_key(TEXT.validate_python(body.get("provider_id")), TEXT.validate_python(body.get("key_id")))
            return {}
        case "list_groups":
            return {"groups": [manager.get_group(group.id) for group in manager.catalog]}
        case "replace_group":
            return manager.replace_group(TEXT.validate_python(body.get("group_id")), GROUP_MEMBERS.validate_python(body.get("members")))
        case "status":
            return public_status(manager)
        case "test":
            test = TestInput.model_validate_json(json.dumps(body.get("request")))
            result = manager.probe(
                test.provider_id, manual_probe, group_id=test.group_id,
                model_id=test.model_id, thinking_effort=test.thinking_effort, include_cooled_keys=True,
            )
            return {"ok": result.ok, "detail": "连通" if result.ok else "探测失败"}
        case "query_usage":
            query = UsageInput.model_validate_json(json.dumps(body.get("query")))
            return manager.usage_report(window=query.window, start=query.start, end=query.end)
        case _:
            raise HostError("llm_manager_invalid")


def save_key(manager: LlmManager, request: KeyInput) -> KeyView:
    """
    Business Logic（为什么需要这个函数）:
        用户可单独创建、禁用或轮换已经保存的 Key，表单只接受操作所需的值。

    Code Logic（这个函数做什么）:
        按 Key 操作调用 Manager 加密或启停接口，返回仅带 hint 的视图。
    """

    if manager.get_provider(request.provider_id).kind != ProviderKind.api:
        raise HostError("llm_manager_invalid")
    if request.action == "add" and request.label is not None and request.secret is not None and request.enabled is not None:
        return manager.add_key(request.provider_id, request.id, request.label, request.secret, request.enabled)
    if request.action == "set_enabled" and request.enabled is not None:
        return manager.set_key_enabled(request.provider_id, request.id, request.enabled)
    if request.action == "replace_secret" and request.secret is not None:
        return manager.replace_key_secret(request.provider_id, request.id, request.secret)
    raise HostError("llm_manager_invalid")


def public_status(manager: LlmManager) -> dict[str, object]:
    """
    Business Logic（为什么需要这个函数）:
        官方状态页面显示当前 owner 的熔断和租约。

    Code Logic（这个函数做什么）:
        从 Manager 模型只选组件要求的公开列。
    """

    breakers = manager.session.scalars(select(CircuitBreaker).where(CircuitBreaker.owner_id == manager.owner_id))
    leases = manager.session.scalars(select(Lease).where(Lease.owner_id == manager.owner_id))
    return {
        "breakers": [
            {"id": row.id, "scope": row.scope, "key_id": row.key_id, "provider_id": row.provider_id,
             "option_id": row.option_id, "failure_count": row.failure_count, "last_failure_at": row.last_failure_at,
             "cooldown_until": row.cooldown_until}
            for row in breakers
        ],
        "leases": [
            {"id": row.id, "group_id": row.group_id, "provider_id": row.provider_id,
             "acquired_at": row.acquired_at, "released_at": row.released_at}
            for row in leases
        ],
    }


def json_public(value: object) -> object:
    """
    Business Logic（为什么需要这个函数）:
        宿主只发布明确由路由或设置操作选择的返回字段。

    Code Logic（这个函数做什么）:
        将公开路由、视图或 SQLite 时间转换成 JSON，未知类型拒绝。
    """

    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()
    if isinstance(value, ManagedRoute):
        return value.model_dump(mode="json")
    if isinstance(value, (ProviderView, KeyView, GroupView, UsageReport)):
        return asdict(value)
    raise TypeError("unsupported response type")


def rpc(config: HostConfig) -> object:
    """
    Business Logic（为什么需要这个函数）:
        一个宿主请求应在一个 Manager 事务中完成。

    Code Logic（这个函数做什么）:
        从 stdin 解析单个请求，设置走原始功能组，执行走使用相同数据的运行资格门槛。
    """

    request = RPC.validate_json(sys.stdin.buffer.readline())
    key = master_key(config.master_key_file)
    with transaction(config, key) as manager:
        if isinstance(request, SettingsRequest):
            return settings(manager, request.body)
        execution = execution_manager(manager, config, key)
        if isinstance(request, RouteLookup):
            return resolve(execution, config, request.nextAfter)
        if isinstance(request, SettleRequest):
            return settle(execution, config, request)
        return reserve(execution, config, request)


def main(argv: Sequence[str]) -> int:
    """
    Business Logic（为什么需要这个函数）:
        SpexCode 通过窄进程协议初始化 Manager、执行设置或正式派发。

    Code Logic（这个函数做什么）:
        校验命令格式、读取配置，仅输出 JSON 信封或执行器状态码，不输出错误对象和输入正文。
    """

    try:
        if len(argv) < 2:
            raise HostError("llm_manager_invalid_arguments")
        action, path = argv[0], Path(argv[1])
        if not path.is_absolute():
            raise HostError("llm_manager_host_config")
        config = HostConfig.model_validate_json(path.read_bytes())
        if action == "claude" and len(argv) >= 5:
            args = argv[5:]
            sandbox = None
            if args and args[0] == "--spex-sandbox-profile":
                if len(args) < 2 or sys.platform != "darwin":
                    raise HostError("llm_manager_invalid_arguments")
                sandbox, args = args[1], args[2:]
            return launch_claude(config, path, argv[2], argv[3], Path(argv[4]), args, sandbox)
        if action == "init" and len(argv) == 2:
            initialize(config)
            result = None
        elif action == "rpc" and len(argv) == 2:
            result = rpc(config)
        else:
            raise HostError("llm_manager_invalid_arguments")
        response = {"ok": True, "value": result}
        print(json.dumps(response, default=json_public))
        return 0
    except Exception as error:
        code = error.args[0] if isinstance(error, HostError) else next(
            (code for kind, code in OBSERVABLE_ERRORS if isinstance(error, kind)), "llm_manager_host_failure",
        )
        if argv and argv[0] == "claude":
            print(code, file=sys.stderr)
            return 1
        print(json.dumps({"ok": False, "code": code}))
        return 0 if argv and argv[0] == "rpc" else 1


class ClaudeRelay(ThreadingHTTPServer):
    """
    Business Logic（为什么需要这个类）:
        Claude CLI 及其原生工具能看到继承环境，真实上游 Key 必须只留在 Manager 进程。

    Code Logic（这个类做什么）:
        一次调用持有自己的回环地址、随机认证令牌、冻结上游和 session。
    """

    def __init__(
        self, config: HostConfig, route_id: str, session_id: str, url: str,
        secret: str, model: str, timeout: float,
    ) -> None:
        """
        Business Logic（为什么需要这个函数）:
            一次正式调用只暴露到其指定模型的临时回环入口。

        Code Logic（这个函数做什么）:
            保存冻结身份、内存凭据及上游地址，在 IPv4 回环绑定随机端口。
        """

        self.config = config
        self.route_id = route_id
        self.session_id = session_id
        self.target = urlsplit(url)
        if self.target.hostname is None or self.target.scheme not in ("http", "https"):
            raise HostError("llm_manager_invalid_url")
        self.upstream_host = self.target.hostname
        self.upstream_secret = secret
        self.model = model
        self.timeout = timeout
        self.ticket = secrets.token_urlsafe(32)
        super().__init__(("127.0.0.1", 0), ClaudeRelayHandler)

    def get_request(self) -> tuple[socket, tuple[str, int]]:
        """
        Business Logic（为什么需要这个函数）:
            无效本机连接不应让代理无限等待请求正文。

        Code Logic（这个函数做什么）:
            返回接受到的套接字并为读写应用与该 Provider 一致的超时。
        """

        connection, address = super().get_request()
        connection.settimeout(self.timeout)
        return connection, address

    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        """
        Business Logic（为什么需要这个函数）:
            代理故障不应往真实 CLI 的 stderr 发 HTTP 头、路径或异常正文。

        Code Logic（这个函数做什么）:
            捕获 HTTP server 未处理的线程异常，只输出固定诊断码。
        """

        print("llm_manager_relay_failure", file=sys.stderr)

    def message_status(self, ordinal: int | None = None, status: int | None = None) -> int:
        """
        Business Logic（为什么需要这个函数）:
            只有最后一个正式 Messages 请求的上游状态可作为本次额度证据。

        Code Logic（这个函数做什么）:
            锁定当前 claim；开始请求分配序号并使旧状态失效，收到头按相同序号写入安全状态。
        """

        with transaction(self.config, None) as manager:
            claim = manager.session.get(RouteClaim, (manager.owner_id, self.session_id))
            if claim is None or claim.route_id != self.route_id or claim.outcome is not None:
                raise HostError("llm_manager_route_stale")
            if ordinal is None:
                claim.upstream_ordinal += 1
                claim.upstream_status = None
            elif claim.upstream_ordinal == ordinal:
                claim.upstream_status = status
            return claim.upstream_ordinal


class ClaudeRelayHandler(BaseHTTPRequestHandler):
    """
    Business Logic（为什么需要这个类）:
        官方 Claude 仍走 Anthropic Messages 和 SSE，Manager 负责实际端点、Key、429 信号和流式传输。

    Code Logic（这个类做什么）:
        验证每次请求的回环令牌、允许的路径与模型，调用固定上游并流式下发公开响应。
    """

    def log_message(self, format: str, *args: object) -> None:
        """HTTP 日志含请求数据，宿主协议只保留固定分类。"""

    def do_POST(self) -> None:
        """
        Business Logic（为什么需要这个函数）:
            Claude 只能代理指定模型的 Messages 与 token 计数，无法转发到任意端点。

        Code Logic（这个函数做什么）:
            验证临时 token，约束 HTTP 路径、模型及大小，并在 HTTP 响应前记录正式消息状态。
        """

        relay = cast(ClaudeRelay, self.server)
        ticket = self.headers.get("x-api-key", "").encode()
        if not secrets.compare_digest(ticket, relay.ticket.encode()):
            self.send_error(401)
            return
        path, _, query = self.path.partition("?")
        if path not in ("/v1/messages", "/v1/messages/count_tokens") or query not in ("", "beta=true"):
            self.send_error(404)
            return
        length = self.headers.get("content-length", "")
        if not length.isascii() or not length.isdecimal() or len(length) > 8 or not 0 < int(length) <= 32 * 1024 * 1024:
            self.send_error(413)
            return
        try:
            body = self.rfile.read(int(length))
            data: object = json.loads(body)
        except (ValueError, OSError):
            self.send_error(400)
            return
        if not isinstance(data, dict) or data.get("model") != relay.model:
            self.send_error(400)
            return
        headers = {
            "x-api-key": relay.upstream_secret,
            "anthropic-version": self.headers.get("anthropic-version", "2023-06-01"),
            "content-type": "application/json",
        }
        if beta := self.headers.get("anthropic-beta"):
            headers["anthropic-beta"] = beta
        target = relay.target
        http = HTTPSConnection if target.scheme == "https" else HTTPConnection
        upstream = http(relay.upstream_host, target.port, timeout=relay.timeout)
        # Once headers are sent, closing the stream preserves the real transport failure.
        sent = False
        try:
            ordinal = relay.message_status() if path == "/v1/messages" else None
            prefix = target.path.rstrip("/").removesuffix("/v1/messages").removesuffix("/v1")
            upstream.request("POST", prefix + path + (f"?{query}" if query else ""), body=body, headers=headers)
            response = upstream.getresponse()
            if ordinal is not None:
                relay.message_status(ordinal, response.status)
            if 300 <= response.status < 400:
                self.send_error(502)
                return
            self.send_response_only(response.status)
            content_type = response.headers.get_content_type()
            self.send_header("Content-Type", "text/event-stream" if content_type == "text/event-stream" else "application/json")
            retry_after = response.getheader("retry-after", "")
            if retry_after.isascii() and retry_after.isdecimal() and len(retry_after) <= 8:
                self.send_header("Retry-After", retry_after)
            self.send_header("Connection", "close")
            self.end_headers()
            sent = True
            forward_stream(response, self.wfile, relay.upstream_secret.encode())
        except (OSError, HTTPException, SQLAlchemyError, HostError):
            if not sent:
                self.send_error(502)
        finally:
            upstream.close()


def forward_stream(response: HTTPResponse, output: BufferedIOBase, secret: bytes) -> None:
    """
    Business Logic（为什么需要这个函数）:
        在保留 Claude SSE 流的同时，不能把上游意外回显的真实 Key 交给 CLI。

    Code Logic（这个函数做什么）:
        增量传输响应，只为跨块的 Key 匹配保留短尾部并遮掉匹配内容。
    """

    pending = b""
    while chunk := response.read1(65536):
        pending += chunk
        while (index := pending.find(secret)) >= 0:
            output.write(pending[:index] + b"[redacted]")
            pending = pending[index + len(secret):]
        retain = min(len(secret) - 1, len(pending))
        while retain and not secret.startswith(pending[-retain:]):
            retain -= 1
        through = len(pending) - retain
        output.write(pending[:through])
        output.flush()
        pending = pending[through:]
    output.write(pending)
    output.flush()


def launch_claude(
    config: HostConfig, config_path: Path, route_id: str, session_id: str,
    cli: Path, args: Sequence[str], sandbox: str | None,
) -> int:
    """
    Business Logic（为什么需要这个函数）:
        官方 Claude 仍在 SpexCode 原工作树和进程组中运行，实际 API Key 和端点由 Manager 绑定。

    Code Logic（这个函数做什么）:
        从锁定且活跃的 claim 验证精确路线与 Key。启动一次性回环代理，给官方子进程仅注入其 URL 和 token。
        macOS 在原工作树沙箱上追加私有文件读限制，再等待执行器退出并关闭代理。
    """

    if not cli.is_absolute():
        raise HostError("llm_manager_invalid_arguments")
    command = [str(cli), *args]
    if sys.platform == "darwin":
        database_path = str(config.database.resolve())
        private_paths = [str(config_path.resolve()), database_path]
        private_paths.extend(database_path + suffix for suffix in ("-wal", "-shm", "-journal"))
        if config.master_key_file is not None:
            private_paths.append(str(config.master_key_file.resolve()))
        literals = " ".join(f"(literal {json.dumps(path, ensure_ascii=False)})" for path in private_paths)
        profile = sandbox if sandbox is not None else "(version 1) (allow default)"
        command = ["/usr/bin/sandbox-exec", "-p", f"{profile} (deny file-read* {literals})", *command]
    key = master_key(config.master_key_file)
    with transaction(config, key) as manager:
        execution = execution_manager(manager, config, key)
        claim = manager.session.get(RouteClaim, (manager.owner_id, session_id))
        binding = manager.session.get(RouteBinding, (manager.owner_id, route_id))
        if claim is None or claim.route_id != route_id or claim.outcome is not None or binding is None or binding.request_group != config.group_id:
            raise HostError("llm_manager_route_stale")
        lease = manager.session.get(Lease, (manager.owner_id, claim.lease_id))
        route = ManagedRoute.model_validate_json(binding.public_route)
        choice = frozen_choice(binding)
        if (route.kind != "anthropic-messages" or choice.key_id is None or lease is None or lease.released_at is not None
                or not is_current(execution, binding, choice)):
            raise HostError("llm_manager_route_stale")
        provider = manager.get_provider(choice.provider_id)
        if not is_configured_available(provider.weekly_windows, provider.holiday_calendar, provider.timezone, datetime.now(UTC)):
            raise HostError("llm_manager_route_unavailable")
        exported = manager.export_provider(choice.provider_id)
        selected = next(item for item in exported.keys if item.id == choice.key_id and item.enabled)
        relay = ClaudeRelay(config, route_id, session_id, exported.base_url, selected.secret, route.model, provider.timeout_seconds)
        inherited = {
            name: value for name, value in os.environ.items()
            if name != "CLAUDECODE" and not name.startswith(("ANTHROPIC_", "CLAUDE_CODE_OAUTH_", "CLAUDE_CODE_USE_", "SPEX_LLM_MANAGER_"))
        }
        bypass = ",".join(part for part in (inherited.get("NO_PROXY", inherited.get("no_proxy", "")), "127.0.0.1", "localhost") if part)
        inherited.update({
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{relay.server_port}",
            "ANTHROPIC_API_KEY": relay.ticket,
            "NO_PROXY": bypass,
            "no_proxy": bypass,
        })
        with relay:
            manager.session.commit()
            process = subprocess.Popen(command, env=inherited)
            worker = Thread(target=relay.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            worker.start()

            def stop_child(signum: int, frame: object) -> None:
                """SpexCode 停止 wrapper 时，同样通知继承进程组中的官方 CLI。"""
                process.send_signal(signum)

            previous = {signum: signal.signal(signum, stop_child) for signum in (signal.SIGTERM, signal.SIGINT)}
            try:
                status = process.wait()
            finally:
                relay.shutdown()
                worker.join()
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

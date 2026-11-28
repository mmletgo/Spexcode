"""SpexCode 的可选 LLM Manager 宿主进程。"""

from __future__ import annotations

import json
import os
import stat
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from functools import partial
from hashlib import sha256
from pathlib import Path
from sqlite3 import connect
from typing import Literal, Self, TypeAlias
from urllib.parse import urlsplit

from llm_manager import (
    ApiFormat,
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
    ProviderInUseError,
    ProviderKey,
    ProviderKind,
    ProviderUpdate,
    ProviderView,
    ProviderWrite,
    RouteChoice,
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
    upgrade_schedule_schema,
    validate_feature_group_catalog,
)
from llm_manager.api_probe import probe_api
from llm_manager.claude_relay import ClaudeRelayError
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
NativeCapability: TypeAlias = Literal["frozen-reader-v2"]
VENDORS = frozenset({CliVendor.claude, CliVendor.grok, CliVendor.zcode, CliVendor.cursor, CliVendor.codex})
TEXT = TypeAdapter(str, config=ConfigDict(strict=True))


class FrozenReaderCapability(BaseModel):
    """
    Business Logic（为什么需要这个类）:
        大型冻结独审只使用 Manager 已证实能提供原生读取证明的路线。

    Code Logic（这个类做什么）:
        校验 Manager 返回的能力、协议、实际模型及 CLI 版本和文件摘要。
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    capability: NativeCapability
    protocol: str = Field(min_length=1, pattern=r"^[^\r\n\x00]+$")
    model: str = Field(min_length=1, pattern=r"^[^\r\n\x00]+$")
    cliVersion: str = Field(min_length=1, pattern=r"^[^\r\n\x00]+$")
    cliSha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ManagedRoute(BaseModel):
    """
    Business Logic（为什么需要这个类）:
        调用方凭公开路线发起正式会话并引用原功能组。

    Code Logic（这个类做什么）:
        保存路由摘要、厂商、公开模型、运行类型和 Manager 签明的可选读取能力。
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    routeId: str = Field(pattern=r"^[0-9a-f]{64}$")
    vendor: Vendor
    model: str = Field(min_length=1, pattern=r"^[^\r\n\x00]+$")
    kind: Literal["cli", "anthropic-messages"]
    frozenReader: FrozenReaderCapability | None = None

    @model_validator(mode="after")
    def validate_execution(self) -> Self:
        """
        Business Logic（为什么需要这个函数）:
            API 路线只可交给 Claude，公开模型需能原样成为原生参数。

        Code Logic（这个函数做什么）:
            验证 API 厂商、模型边界空白和能力证据模型一致性，返回原路由。
        """

        if self.model != self.model.strip() or (self.kind == "anthropic-messages" and self.vendor != "claude"):
            raise ValueError("route execution")
        if self.frozenReader is not None and self.frozenReader.model != self.model:
            raise ValueError("frozen route model")
        return self


class NativeUsage(BaseModel):
    """冻结原生执行器实际提供的计数，包括 Manager 当前不显示的缓存写入量。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    inputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    outputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    cachedInputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)
    cacheCreationInputTokens: int | None = Field(default=None, ge=0, le=2**53 - 1)


class RouteLookup(BaseModel):
    """
    Business Logic（为什么需要这个类）:
        新会话按原功能组当前排序选路，额度失败后的后继选择可沿用原游标。

    Code Logic（这个类做什么）:
        校验同组锚点、额度后继路由、原失败会话及本次必须由 Manager 证明的能力。
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["resolve"]
    nextAfter: ManagedRoute | None = None
    sameGroupAs: ManagedRoute | None = None
    failedSessionId: str | None = Field(default=None, min_length=1, max_length=256, pattern=r"^[^\r\n\x00]+$")
    capability: NativeCapability | None = None


class RouteRequest(BaseModel):
    """正式名额和结算由同一 SpexCode session id 关联到冻结路线。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    route: ManagedRoute
    sessionId: str = Field(min_length=1, max_length=256, pattern=r"^[^\r\n\x00]+$")


class ReserveRequest(RouteRequest):
    """请求分配精确路线的 Manager 名额。"""

    action: Literal["reserve"]


class SettleRequest(RouteRequest):
    """
    Business Logic（为什么需要这个类）:
        正式调用结算时应保留原生余额耗尽与普通限流的区别。

    Code Logic（这个类做什么）:
        接收精确路线、调用身份、结算结果和可选用量。原生适配认证的余额耗尽可携带 HTTP 402。
    """

    action: Literal["settle"]
    outcome: Outcome
    usage: NativeUsage | None = None
    quotaStatus: Literal[402] | None = None


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


def upgrade(config: HostConfig) -> None:
    """
    Business Logic（为什么需要这个函数）:
        已初始化的宿主需要新增全局时区设置，历史 Provider 调度和运行记录需要保留。

    Code Logic（这个函数做什么）:
        打开配置指向的现有数据库，调用 Manager 的增量迁移，并释放数据库连接。
    """

    engine = database(config.database)
    try:
        upgrade_schedule_schema(engine)
    finally:
        engine.dispose()


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


def execution_manager(manager: LlmManager, config: HostConfig, native_capability: NativeCapability | None = None) -> LlmManager:
    """
    Business Logic（为什么需要这个函数）:
        Manager 应按原功能组优先级与备用规则选择 SpexCode 实际可派发的成员。

    Code Logic（这个函数做什么）:
        声明本宿主可执行的 API 协议、CLI 厂商和请求能力，由同 owner、同事务的 Manager 选择执行通道。
    """

    return manager.for_execution(
        config.group_id,
        api_formats=frozenset({ApiFormat.anthropic_messages}),
        cli_vendors=VENDORS,
        native_capability=native_capability,
    )


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


def bind_choice(manager: LlmManager, group: str, choice: RouteChoice, capability: NativeCapability | None = None) -> ManagedRoute:
    """
    Business Logic（为什么需要这个函数）:
        路由 id 要绑定实际执行的 Provider、版本、模型、思考档、凭据和后继位置。

    Code Logic（这个函数做什么）:
        将 Manager 选项与原生能力证据冻结到无明文快照，计算 SHA-256 并只新增一次绑定。
    """

    provider = manager.get_provider(choice.provider_id)
    option = manager.session.get_one(GroupOption, (manager.owner_id, choice.option_id))
    vendor = "claude" if choice.kind == ProviderKind.api else choice.cli_vendor
    model = "default" if provider.model_mode in (CliModelMode.auto, CliModelMode.account) else choice.model_name
    kind = "anthropic-messages" if choice.kind == ProviderKind.api else "cli"
    reader = None
    if capability is not None:
        proof = manager.attest_native_capability(choice)
        if proof is None:
            raise HostError("llm_manager_native_capability_unavailable")
        reader = FrozenReaderCapability.model_validate(proof)
        if reader.capability != capability:
            raise HostError("llm_manager_native_capability_mismatch")
        model = reader.model
    snapshot = CHOICE.dump_python(choice, mode="json", exclude={"secret"})
    snapshot["cursor"]["skipped_option_ids"] = sorted(choice.cursor.skipped_option_ids)
    digest = key_digest(manager, choice)
    identity = [manager.owner_id, group, provider.version, digest, option.thinking_tier_id, snapshot, vendor, model, kind]
    if reader is not None:
        identity.append(reader.model_dump(mode="json"))
    payload = json.dumps(
        identity,
        sort_keys=True, separators=(",", ":"),
    )
    public = ManagedRoute.model_validate({"routeId": sha256(payload.encode()).hexdigest(), "vendor": vendor.value if isinstance(vendor, CliVendor) else vendor, "model": model, "kind": kind, "frozenReader": reader})
    if manager.session.get(RouteBinding, (manager.owner_id, public.routeId)) is None:
        manager.session.add(RouteBinding(
            owner_id=manager.owner_id, route_id=public.routeId, request_group=group, provider_id=provider.id,
            public_route=public.model_dump_json(exclude_none=True), provider_version=provider.version, key_nonce_digest=digest,
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
    if binding is None or binding.request_group != group or binding.public_route != route.model_dump_json(exclude_none=True):
        raise HostError("llm_manager_route_stale")
    return binding


def is_current(manager: LlmManager, binding: RouteBinding, choice: RouteChoice) -> bool:
    """
    Business Logic（为什么需要这个函数）:
        准入前应核对冻结配置，结算也不能把原调用的熔断写到后来换掉的 Key。

    Code Logic（这个函数做什么）:
        检查 Provider、组成员、选项档位、Key 和 Manager 原生能力证据是否仍与冻结绑定一致。
    """

    try:
        provider = manager.get_provider(choice.provider_id)
        digest = key_digest(manager, choice)
    except (NotFoundError, HostError):
        return False
    option = manager.session.get(GroupOption, (manager.owner_id, choice.option_id))
    reader = ManagedRoute.model_validate_json(binding.public_route).frozenReader
    if reader is not None and manager.attest_native_capability(choice) != reader.model_dump(mode="json"):
        return False
    return (
        provider.enabled and provider.version == binding.provider_version
        and provider.id in manager.provider_capabilities
        and digest == binding.key_nonce_digest
        and option is not None and option.enabled and option.group_id == choice.group_id
        and option.model_id == choice.model_id and option.thinking_tier_id == binding.tier_id
    )


def resolve(manager: LlmManager, config: HostConfig, request: RouteLookup) -> ManagedRoute | None:
    """
    Business Logic（为什么需要这个函数）:
        新会话从原功能组选择当前首条可用路线，额度失败后的后继选择承接原游标。

    Code Logic（这个函数做什么）:
        按冻结绑定验证锚点的 owner、组和原生能力，再由 Manager 从组首选路。
        额度游标读取已结算后继；指定失败会话时只读取该会话。后继失效时继续沿游标向下。
    """

    if request.sameGroupAs is not None:
        require_binding(manager, config.group_id, request.sameGroupAs)
    for anchor in (request.sameGroupAs, request.nextAfter):
        if anchor is not None and (anchor.frozenReader.capability if anchor.frozenReader else None) != request.capability:
            raise HostError("llm_manager_native_capability_mismatch")
    after = request.nextAfter
    if after is None:
        if request.failedSessionId is not None:
            raise HostError("llm_manager_quota_required")
        choice = manager.prepare_route(manager.resolve(config.group_id))
    else:
        old = require_binding(manager, config.group_id, after)
        claims = select(RouteClaim).where(
            RouteClaim.owner_id == manager.owner_id, RouteClaim.route_id == old.route_id, RouteClaim.outcome == "quota",
        )
        if request.failedSessionId is not None:
            claims = claims.where(RouteClaim.session_id == request.failedSessionId)
        claim = manager.session.scalars(claims.order_by(RouteClaim.settled_at.desc(), RouteClaim.session_id.desc()).limit(1)).first()
        if claim is None:
            raise HostError("llm_manager_quota_required")
        if claim.successor_id is None:
            choice = manager.prepare_route(manager.skip_option(frozen_choice(old)))
        else:
            binding = manager.session.get_one(RouteBinding, (manager.owner_id, claim.successor_id))
            frozen = frozen_choice(binding)
            if is_current(manager, binding, frozen) and manager.matches_ready_route(config.group_id, frozen):
                return ManagedRoute.model_validate_json(binding.public_route)
            choice = manager.prepare_route(manager.skip_option(frozen))
    return bind_choice(manager, config.group_id, choice, request.capability) if choice is not None else None


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
    if manager.matches_ready_route(config.group_id, frozen):
        lease = manager.acquire(frozen.group_id, frozen.provider_id)
        manager.session.add(RouteClaim(
            owner_id=manager.owner_id, session_id=request.sessionId, route_id=binding.route_id, lease_id=lease.id,
        ))
        return
    # Obtain the original capacity error without retaining a probe lease.
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
        只从已确认的原生额度结算接收 HTTP 402，由 Manager 采用真实状态计算冷却。
    """

    if request.quotaStatus is not None and (request.outcome != "quota" or request.route.kind != "cli"):
        raise HostError("llm_manager_invalid_quota_status")
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
        if request.quotaStatus is not None:
            claim.upstream_status = request.quotaStatus
        successor = manager.report_failure(choice, FailureReport(status_code=request.quotaStatus or 429), now=moment) if current else manager.skip_option(choice, now=moment)
        successor = manager.prepare_route(successor)
        if successor is not None:
            claim.successor_id = bind_choice(manager, config.group_id, successor, request.route.frozenReader.capability if request.route.frozenReader else None).routeId
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
        官方设置组件要管理正式派发所用的同一 owner 的时区、Provider、Key 和功能组，查看其状态与用量。

    Code Logic（这个函数做什么）:
        给各设置操作适配 Manager 的公开类型，并返回公开视图。
    """

    match body.get("op"):
        case "catalog":
            return {
                "catalog": [group.model_dump(mode="json") for group in manager.catalog],
                "providerCapabilities": {provider: sorted(names) for provider, names in manager.provider_capabilities.items()},
            }
        case "get_schedule_timezone":
            return {"timezone": manager.get_schedule_timezone()}
        case "set_schedule_timezone":
            return {"timezone": manager.set_schedule_timezone(TEXT.validate_python(body.get("timezone")))}
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
            patch = data.model_dump(exclude={"id", "kind", "timezone"})
            return manager.update_provider(data.id, ProviderUpdate.model_validate(patch))
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
                test.provider_id, probe_api, group_id=test.group_id,
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
        return value.model_dump(mode="json", exclude_none=True)
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
        capability = request.capability if isinstance(request, RouteLookup) else request.route.frozenReader.capability if request.route.frozenReader else None
        execution = execution_manager(manager, config, capability)
        if isinstance(request, RouteLookup):
            return resolve(execution, config, request)
        if isinstance(request, SettleRequest):
            return settle(execution, config, request)
        return reserve(execution, config, request)


def main(argv: Sequence[str]) -> int:
    """
    Business Logic（为什么需要这个函数）:
        SpexCode 通过窄进程协议初始化和升级 Manager、执行设置或正式派发。

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
        elif action == "upgrade" and len(argv) == 2:
            upgrade(config)
            result = None
        elif action == "rpc" and len(argv) == 2:
            result = rpc(config)
        else:
            raise HostError("llm_manager_invalid_arguments")
        response = {"ok": True, "value": result}
        print(json.dumps(response, default=json_public))
        return 0
    except Exception as error:
        code = error.args[0] if isinstance(error, (HostError, ClaudeRelayError)) else next(
            (code for kind, code in OBSERVABLE_ERRORS if isinstance(error, kind)), "llm_manager_host_failure",
        )
        if argv and argv[0] == "claude":
            print(code, file=sys.stderr)
            return 1
        print(json.dumps({"ok": False, "code": code}))
        return 0 if argv and argv[0] == "rpc" else 1


def record_api_message_status(
    config: HostConfig, route_id: str, session_id: str, ordinal: int | None, status: int | None,
) -> int:
    """
    Business Logic（为什么需要这个函数）:
        只允许同一活跃调用中最后一个正式请求的上游状态作为额度证据。

    Code Logic（这个函数做什么）:
        通过宿主事务绑定 claim。开始正式消息时递增序号，按相同序号写入安全的响应状态。
    """

    with transaction(config, None) as manager:
        claim = manager.session.get(RouteClaim, (manager.owner_id, session_id))
        if claim is None or claim.route_id != route_id or claim.outcome is not None:
            raise ClaudeRelayError("llm_manager_route_stale")
        if ordinal is None:
            claim.upstream_ordinal += 1
            claim.upstream_status = None
        elif claim.upstream_ordinal == ordinal:
            claim.upstream_status = status
        return claim.upstream_ordinal


def report_api_terminal_timeout(
    config: HostConfig, key: bytes | None, route_id: str, session_id: str, ordinal: int,
) -> None:
    """
    Business Logic（为什么需要这个函数）:
        Manager 按最后一条正式请求的真实超时决定后续调用的健康状态。

    Code Logic（这个函数做什么）:
        核对当前消息序号、活跃租约和原路线后提交已观测的上游超时。
    """

    if ordinal == 0:
        return
    with transaction(config, key) as manager:
        claim = manager.session.get(RouteClaim, (manager.owner_id, session_id))
        if (claim is None or claim.route_id != route_id or claim.outcome is not None
                or claim.upstream_ordinal != ordinal or claim.upstream_status is not None):
            return
        binding = manager.session.get_one(RouteBinding, (manager.owner_id, route_id))
        lease = manager.session.get_one(Lease, (manager.owner_id, claim.lease_id))
        if binding.request_group != config.group_id or lease.released_at is not None:
            return
        execution = execution_manager(manager, config)
        choice = frozen_choice(binding)
        if is_current(execution, binding, choice):
            execution.report_failure(choice, FailureReport(transport="timeout"))


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
        execution = execution_manager(manager, config)
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
        status, timed_out_ordinal = manager.launch_claude_api(
            choice, command, environment=os.environ, private_env_prefixes=("SPEX_LLM_MANAGER_",),
            message_status=partial(record_api_message_status, config, route_id, session_id),
            before_process=manager.session.commit,
        )
    report_api_terminal_timeout(config, key, route_id, session_id, timed_out_ordinal)
    return status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

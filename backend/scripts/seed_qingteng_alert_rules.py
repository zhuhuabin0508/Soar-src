"""青藤万相告警规则播种脚本：刷新内置解析策略 + 幂等创建 12 条告警规则。

用法（在 backend 目录下，需已安装 backend 依赖 + 可连数据库）:
    python -m scripts.seed_qingteng_alert_rules

逻辑:
  1. 先运行 run_lightweight_migrations 补齐新增列（与应用启动路径一致，
     幂等；独立执行本脚本时数据库可能尚未随新版应用重启过）；
  2. 调用 seed_builtin_strategies 刷新内置解析策略（青藤策略 v2.1 的
     字段修复免重启生效：等级推导默认值 / 账号与处置建议映射纠正 /
     举证信息改用进程树等）；
  3. 幂等创建规则分组「青藤万相」；
  4. 按 12 类安全日志类型 upsert 告警规则（作用域 device_type=
     qingteng_wanxiang，条件 log_type 相等；Agent状态 / 功能类日志
     属运维数据不产生告警，故跳过）。更新时保留用户自行调整的
     enabled / draft 状态，其余以内置定义为准。

规则设计说明:
  - field_mapping 采用 keep（保留解析结果）：alert_name / risk_level
    已由解析策略从 event_name / severity 正确提取，无需二次覆盖；
  - 严格模式下未命中任何规则的日志不落告警表，因此每类安全日志
    需一条对应规则才能在告警列表出现。
"""
import json
import logging
import os
import sys

from sqlalchemy.orm import Session

from app.core.security import run_lightweight_migrations
from app.database import SessionLocal, engine
from app.engine.strategy_seed import seed_builtin_strategies
from app.models.alert_rule import AlertRule
from app.models.alert_rule_group import AlertRuleGroup

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("seed_qingteng_alert_rules")

_GROUP_NAME = "青藤万相"
_DEVICE_TYPE = "qingteng_wanxiang"

# 12 类安全日志（跳过 Agent状态 / 功能类日志 两类运维数据）
_LOG_TYPES = [
    "暴力破解", "异常登录", "反弹Shell", "本地提权",
    "后门检测", "Web后门", "可疑操作", "蜜罐",
    "Web命令执行", "异常文件监控", "病毒查杀", "内存后门",
]


def _ensure_group(db: Session) -> None:
    group = db.query(AlertRuleGroup).filter(AlertRuleGroup.name == _GROUP_NAME).first()
    if group is None:
        db.add(AlertRuleGroup(name=_GROUP_NAME, sort_order=50))
        logger.info("规则分组已创建: %s", _GROUP_NAME)


def _upsert_rules(db: Session) -> None:
    for log_type in _LOG_TYPES:
        name = f"青藤万相-{log_type}"
        rule = db.query(AlertRule).filter(AlertRule.name == name).first()
        data = dict(
            description=f"青藤万相主机安全「{log_type}」类日志命中即告警（名称/等级保留解析结果）",
            priority=50,
            scope="device_type",
            device_type=_DEVICE_TYPE,
            match="all",
            conditions=json.dumps(
                {"logic": "all", "items": [{"field": "log_type", "op": "eq", "value": log_type}]},
                ensure_ascii=False,
            ),
            rule_type="match",
            action="alert",
            override=json.dumps({}, ensure_ascii=False),
            stats_config="",
            field_mapping=json.dumps(
                {
                    "alert_name": {"mode": "keep", "value": None},
                    "risk_level": {"mode": "keep", "value": None},
                },
                ensure_ascii=False,
            ),
            alert_aggregation="",
            rule_group=_GROUP_NAME,
        )
        if rule is None:
            db.add(AlertRule(name=name, enabled=1, draft=0, **data))
            logger.info("告警规则已创建: %s", name)
            continue
        # 更新：保留用户自行调整的 enabled / draft（不在 data 中），其余以内置定义为准
        for k, v in data.items():
            setattr(rule, k, v)
        logger.info("告警规则已更新: %s (enabled=%s draft=%s)", name, rule.enabled, rule.draft)


def _confirm_migrations() -> bool:
    """建表/轻量迁移前的安全确认（迁移可能包含结构变更，防止误连生产库）。

    - 交互式终端：人工输入 y 确认；
    - 非交互环境（CI/管道）：需显式设置环境变量 SEED_ALLOW_MIGRATIONS=1。
    """
    if os.environ.get("SEED_ALLOW_MIGRATIONS") == "1":
        return True
    if not sys.stdin.isatty():
        logger.warning("非交互环境且未设置 SEED_ALLOW_MIGRATIONS=1，跳过建表/迁移")
        return False
    answer = input("本脚本将执行建表与轻量迁移（可能包含结构变更），确认继续？[y/N] ")
    return answer.strip().lower() in ("y", "yes")


def main() -> None:
    db: Session = SessionLocal()
    try:
        # 0) 建表 + 轻量迁移补齐新列（幂等，与应用启动路径一致）；
        #    需人工确认（交互式输入 y / 非交互设 SEED_ALLOW_MIGRATIONS=1），
        #    跳过时假定库已随新版应用完成迁移，播种失败会显式报错
        import app.models  # noqa: F401  触发 ORM 注册到 Base.metadata
        from app.database import Base

        if _confirm_migrations():
            Base.metadata.create_all(bind=engine)
            run_lightweight_migrations(engine)
            Base.metadata.create_all(bind=engine)  # 迁移可能 DROP 重建分表，补一次建表
        # 1) 刷新内置解析策略（v2.1 字段修复免重启生效）
        seed_builtin_strategies(db)
        # 2) 分组 + 12 条告警规则
        _ensure_group(db)
        _upsert_rules(db)
        db.commit()
        logger.info("播种完成：青藤万相告警规则 %s 条（分组「%s」）。", len(_LOG_TYPES), _GROUP_NAME)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("播种失败: %s", exc)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()

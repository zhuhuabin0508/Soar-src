"""报告中心 Celery 任务：运行执行与定时调度扫描。"""
from __future__ import annotations

import logging
from datetime import timedelta

from app.core.celery_app import celery_app
from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.models.report import ReportConfig, ReportRun
from app.report.errors import ReportError
from app.report.service import create_run, execute_run

logger = logging.getLogger(__name__)


@celery_app.task(name="execute_report_run", soft_time_limit=600, time_limit=660)
def execute_report_run(run_id: int) -> dict:
    """执行单次报告运行。"""
    return execute_run(run_id)


@celery_app.task(name="scan_report_schedules")
def scan_report_schedules() -> dict:
    """每分钟扫描一次已发布配置的 cron，到点则创建运行。

    幂等键使用 ``cron 上次触发时间``，保证同一周期只生成一次报告。
    """
    from croniter import croniter

    now = beijing_now()
    triggered: list[dict] = []
    db = SessionLocal()
    try:
        configs = (
            db.query(ReportConfig)
            .filter(ReportConfig.status == "published", ReportConfig.schedule_cron != "")
            .all()
        )
        for config in configs:
            try:
                iterator = croniter(config.schedule_cron, now)
                previous = iterator.get_prev(type(now))
                # 只处理最近 90 秒内到期的周期，避免服务重启后补跑历史
                if now - previous > timedelta(seconds=90):
                    continue
                period = previous.strftime("%Y-%m-%d %H:%M")
                idempotency_key = f"cfg{config.id}:{previous.isoformat()}"
                # 已存在同周期运行时不再投递：create_run 幂等只防建单不防重复执行，
                # 在 90 秒扫描窗口内重复 delay 会让多个 worker 同时抢跑同一 run。
                exists = (
                    db.query(ReportRun.id)
                    .filter(ReportRun.idempotency_key == idempotency_key)
                    .first()
                )
                if exists is not None:
                    continue
                run = create_run(
                    db,
                    config.id,
                    params={"period": period},
                    trigger_type="schedule",
                    idempotency_key=idempotency_key,
                    dispatch=False,
                )
                execute_report_run.delay(run.id)
                triggered.append({"config_id": config.id, "run_id": run.id})
            except ReportError as exc:
                logger.warning("报告定时触发失败 cfg=%s: %s", config.id, exc.message)
            except Exception:  # noqa: BLE001
                logger.exception("报告定时触发异常 cfg=%s", config.id)
        return {"triggered": triggered}
    finally:
        db.close()

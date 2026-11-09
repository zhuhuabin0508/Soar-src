"""Celery 任务包。

导入此包时会自动注册 :func:`execute_workflow` 与工单超时扫描任务。
"""
from app.tasks.workflow_tasks import execute_workflow
from app.tasks.ticket_tasks import scan_ticket_timeouts
from app.tasks.ticket_device_tasks import execute_ticket_device_run
from app.tasks.ticket_pause_tasks import scan_ticket_pauses
from app.tasks.dashboard_cache_tasks import refresh_dashboard_cache
from app.tasks.daily_stats_tasks import rollup_daily_stats

__all__ = [
    "execute_workflow",
    "scan_ticket_timeouts",
    "execute_ticket_device_run",
    "scan_ticket_pauses",
    "refresh_dashboard_cache",
    "rollup_daily_stats",
]

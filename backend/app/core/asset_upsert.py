"""资产同步批量 upsert 公共实现。

设计：
- 使用 PostgreSQL ``INSERT ... ON CONFLICT DO UPDATE`` 一次完成写入；
- 模型带 ``row_hash`` 列时，写入前计算内容指纹：
  - 全量同步：所有行都写入并刷新指纹/批次；
  - 增量同步：先按 source_id 查询已有指纹，只 upsert 新增或内容变化的行，
    未变化行不产生任何写操作，从根本上避免全量重复写；
- 无 ``row_hash`` 的模型回退到 ``RETURNING (xmax = 0)`` 统计新增/更新；
- ``RETURNING (xmax = 0)`` 可省掉「先查 source_id 是否存在」的额外查询。
"""
from __future__ import annotations

import hashlib
import json
from typing import Sequence

from sqlalchemy import literal_column, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session


def _content_hash(row: dict, content_cols: Sequence[str]) -> str:
    payload = {col: row.get(col) for col in content_cols}
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _execute_upsert(
    db: Session,
    model,
    rows: Sequence[dict],
    *,
    update_cols: Sequence[str],
    index_elements: Sequence[str],
    has_hash: bool,
    with_counts: bool,
) -> tuple[int, int]:
    stmt = insert(model).values(list(rows))
    excluded = stmt.excluded
    set_ = {col: getattr(excluded, col) for col in update_cols}
    if has_hash:
        set_["row_hash"] = excluded.row_hash

    stmt = stmt.on_conflict_do_update(
        index_elements=list(index_elements),
        set_=set_,
    )
    if not with_counts:
        db.execute(stmt)
        return 0, 0

    # xmax = 0 表示本语句插入的新行；非 0 表示冲突后更新
    stmt = stmt.returning(literal_column("(xmax = 0)").label("inserted"))
    flags = list(db.execute(stmt).scalars())
    inserted = sum(1 for flag in flags if flag)
    return inserted, len(flags) - inserted


def bulk_upsert(
    db: Session,
    model,
    rows: Sequence[dict],
    *,
    update_cols: Sequence[str],
    index_elements: Sequence[str] = ("source_id",),
    skip_unchanged: bool = False,
) -> tuple[int, int]:
    """批量 upsert，返回 ``(inserted, updated)``。

    Args:
        db: 数据库会话。
        model: ORM 模型。
        rows: 待写入行（同一批次内 source_id 必须唯一）。
        update_cols: 冲突时更新的列。
        index_elements: 冲突判定列，默认 source_id。
        skip_unchanged: 仅处理新增/内容变化的行（增量同步用）。

    Returns:
        (inserted, updated)：
        - 全量模式：updated 为所有已存在行；
        - 增量模式：只统计实际写入的新增/变化行。
    """
    if not rows:
        return 0, 0

    has_hash = hasattr(model, "row_hash")
    content_cols = [
        col for col in update_cols
        if col not in ("batch_id", "updated_at", "row_hash")
    ]
    if has_hash:
        for row in rows:
            row["row_hash"] = _content_hash(row, content_cols)

    # 增量 + 内容指纹：先筛出新增/变化行，未变化行完全不写库
    if skip_unchanged and has_hash:
        source_ids = [row["source_id"] for row in rows]
        existing = {
            source_id: row_hash
            for source_id, row_hash in db.query(model.source_id, model.row_hash)
            .filter(model.source_id.in_(source_ids))
            .all()
        }
        inserted = updated = 0
        write_rows: list[dict] = []
        for row in rows:
            source_id = row["source_id"]
            if source_id not in existing:
                inserted += 1
                write_rows.append(row)
            elif existing[source_id] != row["row_hash"]:
                updated += 1
                write_rows.append(row)
        if write_rows:
            _execute_upsert(
                db,
                model,
                write_rows,
                update_cols=update_cols,
                index_elements=index_elements,
                has_hash=has_hash,
                with_counts=False,
            )
        return inserted, updated

    # 无 row_hash 时的增量兜底：数据库侧只更新内容变化的行
    if skip_unchanged and content_cols:
        stmt = insert(model).values(list(rows))
        excluded = stmt.excluded
        set_ = {col: getattr(excluded, col) for col in update_cols}
        where = tuple_(
            *[getattr(model, col) for col in content_cols]
        ).is_distinct_from(
            tuple_(*[getattr(excluded, col) for col in content_cols])
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=list(index_elements),
            set_=set_,
            where=where,
        )
        stmt = stmt.returning(literal_column("(xmax = 0)").label("inserted"))
        flags = list(db.execute(stmt).scalars())
        inserted = sum(1 for flag in flags if flag)
        return inserted, len(flags) - inserted

    return _execute_upsert(
        db,
        model,
        rows,
        update_cols=update_cols,
        index_elements=index_elements,
        has_hash=has_hash,
        with_counts=True,
    )

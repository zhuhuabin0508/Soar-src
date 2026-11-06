"""一次性迁移：cloud_host_security 模板 eip/出口地址 改为 extra 映射后的存量修正。

背景：此前 ip / eip / 出口地址 三个模板字段都映射 standard:ip，导入时按
字典遍历顺序后写覆盖前写，标准 ip 列只剩最后写入的值；原始 ip 字段值
保留在 identifier（模板 identifier_field = "ip"）。

迁移规则（仅处理 identifier 与 ip 均为合法单 IP 且不相等的行）：
- identifier 的值恢复进标准 ip 列（即原始 ip 字段值）
- 原 ip 列值挪入 extra_fields["eip"]（无法区分原属于 eip 还是出口地址，
  尽力保留不丢数据；eip 已有值则跳过该行，避免覆盖真实数据）
- 通过 ORM 提交，asset_ip_index 事件钩子自动重建 IP 区间索引

用法：docker exec -w /app -e PYTHONPATH=/app soar-backend-dev \
    python scripts/migrate_cloud_host_security_ips.py
（需 compose 中 backend-dev 挂载了 ./backend/scripts:/app/scripts）
"""
import ipaddress

from app.database import SessionLocal
from app.models.asset import Asset


def _is_single_ip(value) -> bool:
    try:
        ipaddress.ip_address(str(value or "").strip())
        return True
    except ValueError:
        return False


def main() -> None:
    session = SessionLocal()
    try:
        rows = session.query(Asset).filter(Asset.type_code == "cloud_host_security").all()
        migrated = same = conflict = 0
        for asset in rows:
            if not _is_single_ip(asset.identifier):
                continue
            old_ip = str(asset.ip or "").strip()
            if not old_ip or asset.identifier == old_ip:
                same += 1
                continue
            extra = dict(asset.extra_fields or {})
            if str(extra.get("eip") or "").strip():
                conflict += 1
                continue
            # 原值可能是单 IP / 多值 / 范围（eip、出口地址覆盖产生），整体挪入 eip
            extra["eip"] = asset.ip
            # JSON 列变更检测需要整体重新赋值
            asset.extra_fields = extra
            asset.ip = asset.identifier
            migrated += 1
            if migrated % 500 == 0:
                session.commit()
        session.commit()
        print(
            f"total={len(rows)} migrated={migrated} "
            f"unchanged(identifier==ip)={same} conflict_skipped={conflict}"
        )
    finally:
        session.close()


if __name__ == "__main__":
    main()

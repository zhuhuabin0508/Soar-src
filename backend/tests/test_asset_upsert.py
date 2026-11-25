"""批量 upsert / 增量内容指纹的单元测试。"""
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.asset_upsert import _content_hash  # noqa: E402
from app.models.jiaotu_asset_item import JiaotuAssetItem  # noqa: E402
from app.models.jiaotu_host import JiaotuHostAsset  # noqa: E402
from app.models.qingteng_asset_item import QingtengAssetItem  # noqa: E402
from app.models.qingteng_component import QingtengComponentAsset  # noqa: E402
from app.models.qingteng_host import QingtengHostAsset  # noqa: E402
from app.models.tianqing_endpoint import TianqingEndpointAsset  # noqa: E402
from app.models.tianqing_software import TianqingSoftwareAsset  # noqa: E402


def test_content_hash_stable_and_order_insensitive():
    cols = ["name", "version"]
    assert _content_hash({"name": "nginx", "version": "1.24"}, cols) == _content_hash(
        {"version": "1.24", "name": "nginx"}, cols
    )
    assert _content_hash({"name": "nginx", "version": "1.24"}, cols) != _content_hash(
        {"name": "nginx", "version": "1.25"}, cols
    )


def test_asset_models_have_row_hash():
    for model in (
        QingtengHostAsset,
        QingtengComponentAsset,
        QingtengAssetItem,
        TianqingEndpointAsset,
        TianqingSoftwareAsset,
        JiaotuHostAsset,
        JiaotuAssetItem,
    ):
        assert hasattr(model, "row_hash"), model.__tablename__

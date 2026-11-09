"""资产索引 Redis 序列化往返（阶段三）。"""
import ipaddress

from app.core import asset_index_cache as aic


def test_serialize_deserialize_nets_roundtrip():
    nets = [
        (("net", ipaddress.ip_network("10.0.0.0/24")), 1, "net-asset"),
        (("range", ipaddress.ip_address("1.2.3.4"), ipaddress.ip_address("1.2.3.10")), 2, "r"),
    ]
    ser = aic._serialize_nets(nets)
    back = aic._deserialize_nets(ser)
    assert len(back) == 2
    aids = {row[1] for row in back}
    assert aids == {1, 2}
    from app.core.log_receiver_manager.pipeline import enricher_stage as es

    index = {"single": {"1.2.3.5": (2, "r")}, "nets": back}
    hit = es._match_asset_ip("1.2.3.5", index)
    assert hit == (2, "r")
    assert es._match_asset_ip("10.0.0.8", index) == (1, "net-asset")

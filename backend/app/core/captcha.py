"""滑块拼图验证码：生成 + 校验。

用户在登录页拖动滑块，把拼图块对准背景图缺口；松手后前端把滑块 x 坐标随
登录请求提交（``captcha_code`` 字段传 x 值），服务端与 Redis 中存储的目标
x 比较，偏差在容差内即通过。

设计要点：
- 背景图为随机几何拼贴（多边形 + 圆 + 噪点 + 干扰线），无文字、每次唯一，
  降低离线 OCR / 模板匹配的自动化破解能力
- ``captcha_id`` 使用 uuid + ``secrets.token_urlsafe``，作为 Redis 键的一部分难以枚举
- 目标 x 只存服务端，图片不含缺口位置信息以外的提示；校验通过立即删除
  （一次性消费，防重放），失败保留供用户拖动重试
- 容差 ``CAPTCHA_TOLERANCE``（像素），兼顾易用性与防脚本枚举（300px 宽度下
  5px 容差 ≈ 1.7% 命中率，脚本暴力尝试在限频约束下不可行）
"""
import base64
import io
import logging
import random
import secrets
import uuid

from PIL import Image, ImageDraw

from app.core.redis_client import get_redis

logger = logging.getLogger(__name__)

# Redis 键前缀与默认过期时间
CAPTCHA_KEY_PREFIX = "captcha:"
CAPTCHA_TTL_SECONDS = 300  # 5 分钟

# 滑块拼图几何参数（前端按此尺寸渲染拖动区）
BG_WIDTH = 300
BG_HEIGHT = 150
PIECE_SIZE = 44  # 拼图块直径（圆形）
CAPTCHA_TOLERANCE = 5  # 校验容差（像素）


def _b64(img: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _random_palette() -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """生成一组随机的主色 → 暗色渐变（蓝色系科技感基调，随机偏移）。"""
    base = random.randint(190, 255)
    c1 = (random.randint(20, 60), random.randint(90, 160), min(255, base))
    c2 = (c1[0] // 2, c1[1] // 2, max(20, c1[2] - random.randint(60, 120)))
    return c1, c2


def _gen_background() -> Image.Image:
    """随机几何拼贴背景：渐变底 + 多边形 + 圆斑 + 噪点 + 干扰弧线。"""
    c1, c2 = _random_palette()
    img = Image.new("RGB", (BG_WIDTH, BG_HEIGHT))
    draw = ImageDraw.Draw(img)
    # 1. 水平渐变底色
    for x in range(BG_WIDTH):
        t = x / BG_WIDTH
        draw.line(
            [(x, 0), (x, BG_HEIGHT)],
            fill=tuple(int(a * (1 - t) + b * t) for a, b in zip(c1, c2)),
        )
    # 2. 随机半透明多边形（叠加图层）
    overlay = Image.new("RGBA", (BG_WIDTH, BG_HEIGHT), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    for _ in range(18):
        color = (
            random.randint(30, 200), random.randint(60, 220),
            random.randint(100, 255), random.randint(28, 90),
        )
        pts = [
            (random.randint(-20, BG_WIDTH + 20), random.randint(-20, BG_HEIGHT + 20))
            for _ in range(random.randint(3, 6))
        ]
        odraw.polygon(pts, fill=color)
    for _ in range(10):
        color = (
            random.randint(30, 200), random.randint(60, 220),
            random.randint(100, 255), random.randint(24, 70),
        )
        r = random.randint(8, 36)
        x, y = random.randint(0, BG_WIDTH), random.randint(0, BG_HEIGHT)
        odraw.ellipse([x - r, y - r, x + r, y + r], fill=color)
    img = Image.alpha_composite(img.convert("RGBA"), overlay)
    # 3. 干扰弧线（细亮色，破坏直线拟合；bbox 端点先排序再随机，避免 x1<x0）
    draw = ImageDraw.Draw(img)
    for _ in range(4):
        color = tuple(min(255, c + random.randint(40, 80)) for c in c1)
        x0, x1 = sorted((random.randint(-60, BG_WIDTH), random.randint(BG_WIDTH // 2, BG_WIDTH + 80)))
        y0, y1 = sorted((random.randint(-60, BG_HEIGHT), random.randint(BG_HEIGHT // 2, BG_HEIGHT + 120)))
        draw.arc([x0, y0, x1, y1], random.randint(0, 360), random.randint(0, 360),
                 fill=color, width=1)
    # 4. 噪点
    px = img.load()
    for _ in range(BG_WIDTH * 2):
        x, y = random.randint(0, BG_WIDTH - 1), random.randint(0, BG_HEIGHT - 1)
        d = random.randint(-24, 24)
        r, g, b, a = px[x, y]
        px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)),
                   max(0, min(255, b + d)), a)
    return img


def _piece_mask() -> Image.Image:
    """圆形拼图块的 alpha 蒙版（边缘 2px 柔化，降低拼缝锯齿感）。"""
    m = Image.new("L", (PIECE_SIZE, PIECE_SIZE), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([1, 1, PIECE_SIZE - 1, PIECE_SIZE - 1], fill=255)
    d.ellipse([0, 0, PIECE_SIZE - 1, PIECE_SIZE - 1], outline=180)
    return m


def generate_captcha() -> dict:
    """生成滑块拼图验证码。

    返回:
        ``{"captcha_id", "image"（含缺口的背景）, "slider_image"（拼图块小图）,
        "slider_y", "slider_size"}``，均为 base64 PNG / 像素值。
    """
    bg = _gen_background()
    # 缺口位置：x 保证滑块从最左侧拖动有意义；y 避开上下边缘
    target_x = random.randint(PIECE_SIZE + 30, BG_WIDTH - PIECE_SIZE - 12)
    target_y = random.randint(8, BG_HEIGHT - PIECE_SIZE - 8)

    # 拼图块：从背景原始图裁出的圆形块（带 alpha 蒙版）
    piece = bg.crop((target_x, target_y, target_x + PIECE_SIZE, target_y + PIECE_SIZE))
    piece.putalpha(_piece_mask())

    # 背景挖缺口：半透明暗色圆 + 亮色描边
    overlay = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.ellipse(
        [target_x, target_y, target_x + PIECE_SIZE, target_y + PIECE_SIZE],
        fill=(0, 0, 0, 110), outline=(255, 255, 255, 160), width=2,
    )
    bg_with_hole = Image.alpha_composite(bg, overlay).convert("RGBA")

    captcha_id = f"{uuid.uuid4().hex}{secrets.token_urlsafe(8)}"
    redis_client = get_redis()
    redis_client.setex(f"{CAPTCHA_KEY_PREFIX}{captcha_id}", CAPTCHA_TTL_SECONDS, str(target_x))
    logger.debug("生成滑块验证码: captcha_id=%s, ttl=%ds", captcha_id, CAPTCHA_TTL_SECONDS)
    return {
        "captcha_id": captcha_id,
        "image": f"data:image/png;base64,{_b64(bg_with_hole)}",
        "slider_image": f"data:image/png;base64,{_b64(piece)}",
        "slider_y": target_y,
        "slider_size": PIECE_SIZE,
    }


def verify_captcha(captcha_id: str, captcha_code: str) -> bool:
    """校验滑块位置：``captcha_code`` 为用户拖动的 x 坐标（容差内通过）。

    Args:
        captcha_id: ``generate_captcha`` 返回的 captcha_id。
        captcha_code: 滑块松手时的 x 坐标（字符串或数字）。

    Returns:
        True 表示偏差在容差内；False 表示不存在、已过期、非数字或偏差过大。
    """
    if not captcha_id or captcha_code in (None, ""):
        return False
    redis_client = get_redis()
    key = f"{CAPTCHA_KEY_PREFIX}{captcha_id}"
    stored = redis_client.get(key)
    if not stored:
        return False
    try:
        target = int(stored)
        given = int(str(captcha_code).strip())
    except (TypeError, ValueError):
        logger.debug("滑块验证码格式非法: captcha_id=%s", captcha_id)
        return False
    # 校验通过：立即删除（一次性消费，防重放）
    if abs(given - target) <= CAPTCHA_TOLERANCE:
        redis_client.delete(key)
        redis_client.delete(f"{key}:fails")
        logger.debug("滑块验证码校验通过: captcha_id=%s", captcha_id)
        return True
    # 校验失败：累计失败次数（与预校验 check_captcha 共用同一计数键），
    # 达到上限删除验证码强制换图，防止绕过预检直接对登录接口暴力枚举位置
    fail_key = f"{key}:fails"
    fails = redis_client.incr(fail_key)
    redis_client.expire(fail_key, CAPTCHA_TTL_SECONDS)
    if int(fails) >= CHECK_MAX_FAILS:
        redis_client.delete(key)
        redis_client.delete(fail_key)
        logger.info("滑块验证码失败超限，验证码作废: captcha_id=%s", captcha_id)
        return False
    logger.debug("滑块验证码校验失败: captcha_id=%s, given=%s, target=%s", captcha_id, given, target)
    return False


# 验证码失败次数上限（预校验与登录校验共用）：达到后删除验证码强制换图
# （防脚本在单一验证图上暴力枚举位置；登录路径同样生效，防止绕过预检直调登录枚举）
CHECK_MAX_FAILS = 5


def check_captcha(captcha_id: str, x) -> tuple[bool, bool]:
    """滑块位置预校验（不消费验证码，用于登录前弹窗内即时反馈）。

    与 ``verify_captcha`` 的区别：
    - 通过时**不删除** Redis 键——登录请求仍走 ``verify_captcha`` 做最终校验并一次性消费
    - 失败时按验证码维度累计失败次数，达到 ``CHECK_MAX_FAILS`` 删除键并返回
      ``expired=True``（前端收到后自动换图，防止脚本在同一张图上穷举位置）

    Args:
        captcha_id: ``generate_captcha`` 返回的 captcha_id。
        x: 滑块松手时的 x 坐标（数字或数字字符串）。

    Returns:
        ``(passed, expired)``：passed=偏差在容差内；expired=验证码不存在/已失效/
        失败次数超限，前端应刷新验证图。
    """
    if not captcha_id or x in (None, ""):
        return False, False
    redis_client = get_redis()
    key = f"{CAPTCHA_KEY_PREFIX}{captcha_id}"
    stored = redis_client.get(key)
    if not stored:
        return False, True  # 不存在或已过期 → 提示换图
    try:
        target = int(stored)
        given = int(float(str(x).strip()))  # 兼容 "237" / "237.0" / 237 / 237.0
    except (TypeError, ValueError):
        logger.debug("滑块预校验格式非法: captcha_id=%s, x=%r", captcha_id, x)
        return False, False
    if abs(given - target) <= CAPTCHA_TOLERANCE:
        logger.debug("滑块预校验通过（未消费）: captcha_id=%s", captcha_id)
        return True, False
    # 失败计数（独立短键，跟随验证码过期）；超限删除验证码强制换图
    fail_key = f"{key}:fails"
    fails = redis_client.incr(fail_key)
    redis_client.expire(fail_key, CAPTCHA_TTL_SECONDS)
    if int(fails) >= CHECK_MAX_FAILS:
        redis_client.delete(key)
        redis_client.delete(fail_key)
        logger.info("滑块预校验失败超限，验证码作废: captcha_id=%s", captcha_id)
        return False, True
    logger.debug("滑块预校验失败: captcha_id=%s, given=%s, target=%s, fails=%s",
                 captcha_id, given, target, fails)
    return False, False

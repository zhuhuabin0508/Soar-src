"""报告中心统一错误类型与错误码。

渲染、采集、抽取、校验各环节都通过 ``ReportError`` 抛出带错误码的异常，
上层（API / Celery 任务）据此决定重试、降级或直接失败，避免异常信息丢失。
"""
from __future__ import annotations


class ReportError(Exception):
    """带错误码与上下文的报告中心异常。

    Args:
        code: 稳定错误码（见下方常量），供前端与运维按码处理。
        message: 面向用户的中文提示。
        detail: 可选的附加信息（字段名、状态码、响应片段等）。
    """

    def __init__(self, code: str, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "detail": self.detail}


# ===== 模板 / 规格 =====
TPL_INVALID = "TPL_INVALID"                # 模板规格不合法
TPL_UPLOAD_INVALID = "TPL_UPLOAD_INVALID"  # 上传文件不合法（扩展名/大小/zip 结构）
TPL_PARSE = "TPL_PARSE"                    # docx 无法解析
TPL_RENDER = "TPL_RENDER"                  # 渲染失败（语法/未定义变量）
TPL_RESIDUE = "TPL_RESIDUE"                # 产物存在未替换占位符

# ===== 数据采集 =====
SRC_INVALID = "SRC_INVALID"                # 数据源配置不合法
SRC_TIMEOUT = "SRC_TIMEOUT"
SRC_AUTH = "SRC_AUTH"
SRC_RATE_LIMIT = "SRC_RATE_LIMIT"
SRC_HTTP_4XX = "SRC_HTTP_4XX"
SRC_HTTP_5XX = "SRC_HTTP_5XX"
SRC_PARSE = "SRC_PARSE"
SRC_EMPTY = "SRC_EMPTY"
SRC_NETWORK = "SRC_NETWORK"

# ===== 映射 / 转换 =====
MAP_MISSING = "MAP_MISSING"
MAP_TYPE = "MAP_TYPE"
MAP_TRANSFORM = "MAP_TRANSFORM"

# ===== 校验 =====
VAL_CROSS_CHECK = "VAL_CROSS_CHECK"
VAL_REQUIRED_MISSING = "VAL_REQUIRED_MISSING"

# ===== 资源与流程 =====
PDF_UNAVAILABLE = "PDF_UNAVAILABLE"         # 环境缺少 LibreOffice，无法转 PDF
TPL_NOT_FOUND = "TPL_NOT_FOUND"
CFG_NOT_FOUND = "CFG_NOT_FOUND"
RUN_NOT_FOUND = "RUN_NOT_FOUND"
ARTIFACT_NOT_FOUND = "ARTIFACT_NOT_FOUND"
CONFLICT = "CONFLICT"
INVALID_STATE = "INVALID_STATE"
FORBIDDEN = "FORBIDDEN"

# ===== AI 辅助 =====
AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED"  # 平台未配置默认模型
AI_FAILED = "AI_FAILED"                  # 模型调用失败/超时
AI_BAD_OUTPUT = "AI_BAD_OUTPUT"          # 模型输出不符合约定结构

# 可重试错误码：仅网络/超时/限流/5xx 才重试，鉴权与参数错误重试无意义
RETRYABLE_CODES = {
    SRC_TIMEOUT,
    SRC_RATE_LIMIT,
    SRC_HTTP_5XX,
    SRC_NETWORK,
}


def is_retryable(code: str) -> bool:
    return code in RETRYABLE_CODES

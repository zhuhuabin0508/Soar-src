"""docx → PDF 保真预览：封装 LibreOffice headless 转换。

浏览器内的 ``docx-preview`` 只能做近似渲染，分页、页眉页脚与字体依赖客户端；
正式预览统一走服务端 LibreOffice 转换，保证与导出 PDF 一致。

未安装 LibreOffice 时抛出 ``PDF_UNAVAILABLE``，由前端提示安装，不静默降级。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from app.report.errors import PDF_UNAVAILABLE, ReportError

logger = logging.getLogger(__name__)

_WINDOWS_CANDIDATES = (
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
)

INSTALL_HINT = (
    "服务端未安装 LibreOffice：请在镜像中安装 libreoffice-writer 与 fonts-noto-cjk，"
    "或通过环境变量 REPORT_SOFFICE_BIN 指定 soffice 可执行文件路径。"
)


def find_soffice() -> str | None:
    """返回 soffice 可执行文件路径；优先级：环境变量 > PATH > Windows 默认安装。"""
    explicit = (os.environ.get("REPORT_SOFFICE_BIN") or "").strip()
    if explicit:
        if os.path.isfile(explicit):
            return explicit
        logger.warning("REPORT_SOFFICE_BIN 不存在: %s", explicit)
    for command in ("soffice", "libreoffice"):
        path = shutil.which(command)
        if path:
            return path
    for candidate in _WINDOWS_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return None


def is_available() -> bool:
    return find_soffice() is not None


def capability() -> dict:
    """PDF 转换能力探测，供前端决定是否展示预览入口。"""
    binary = find_soffice()
    return {
        "available": bool(binary),
        "binary": binary or "",
        "engine": "libreoffice" if binary else "",
        "hint": "" if binary else INSTALL_HINT,
    }


def _convert(docx: bytes, out_format: str, *, timeout: int = 120) -> bytes:
    """将 docx 字节转换为指定格式（pdf/html/txt），返回转换后字节。

    Raises:
        ReportError: ``PDF_UNAVAILABLE``，包含安装提示或转换失败原因。
    """
    binary = find_soffice()
    if not binary:
        raise ReportError(
            PDF_UNAVAILABLE,
            f"当前环境未安装 LibreOffice，无法生成 {out_format.upper()}",
            {"hint": INSTALL_HINT},
        )

    with tempfile.TemporaryDirectory(prefix="report_conv_") as workdir:
        source = os.path.join(workdir, "source.docx")
        profile = os.path.join(workdir, "profile")
        os.makedirs(profile, exist_ok=True)
        with open(source, "wb") as handle:
            handle.write(docx)

        # 每次使用独立 profile，避免并发的 headless 进程争抢同一用户配置目录
        command = [
            binary,
            "--headless",
            "--norestore",
            f"-env:UserInstallation={Path(profile).as_uri()}",
            "--convert-to",
            out_format,
            "--outdir",
            workdir,
            source,
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ReportError(
                PDF_UNAVAILABLE,
                f"{out_format.upper()} 转换超时（{timeout} 秒）",
                {"hint": INSTALL_HINT},
            ) from exc
        except OSError as exc:
            raise ReportError(
                PDF_UNAVAILABLE,
                f"{out_format.upper()} 转换失败: {exc}",
                {"hint": INSTALL_HINT},
            ) from exc

        target = os.path.join(workdir, f"source.{out_format}")
        if completed.returncode != 0 or not os.path.isfile(target):
            stderr = (completed.stderr or b"").decode("utf-8", errors="ignore")[-500:]
            raise ReportError(
                PDF_UNAVAILABLE,
                f"{out_format.upper()} 转换失败，请检查 LibreOffice 安装与模板字体",
                {"stderr": stderr, "returncode": completed.returncode},
            )
        with open(target, "rb") as handle:
            return handle.read()


def docx_to_pdf(docx: bytes, *, timeout: int = 120) -> bytes:
    """将 docx 字节转换为 PDF 字节。"""
    return _convert(docx, "pdf", timeout=timeout)


def docx_to_html(docx: bytes, *, timeout: int = 120) -> bytes:
    """将 docx 字节转换为 HTML 字节（LibreOffice HTML 导出）。"""
    return _convert(docx, "html", timeout=timeout)

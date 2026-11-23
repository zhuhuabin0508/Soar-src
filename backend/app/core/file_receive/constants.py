"""文件接收常量：状态、业务类型、格式白名单与 MIME 映射。"""

STATUS_LABELS: dict[str, str] = {
    "INIT": "待上传",
    "UPLOADING": "上传中",
    "MERGING": "合并中",
    "VERIFYING": "校验中",
    "SUCCESS": "接收成功",
    "FAILED": "接收失败",
    "EXPIRED": "已过期",
    "CANCELED": "已取消",
}

ACTIVE_STATUSES = ("INIT", "UPLOADING")
TERMINAL_STATUSES = ("SUCCESS", "FAILED", "EXPIRED", "CANCELED")

# 业务类型注册表：当前仅支持报告业务；后续如需扩展，只需在此增加条目
BIZ_TYPES: dict[str, dict] = {
    "report": {"label": "报告", "required_biz_fields": []},
}

# 默认允许格式（来源可增删，但全局禁用列表始终优先）
DEFAULT_ALLOWED_EXTS = [
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf",
    "zip", "rar", "7z", "txt", "csv", "md", "json", "xml",
]

# 全局禁用：无论来源如何配置都拒绝
FORBIDDEN_EXTS = {
    "exe", "dll", "bat", "cmd", "sh", "ps1", "vbs", "js", "jse", "wsf",
    "msi", "scr", "com", "pif", "hta", "jar", "class", "so", "dylib",
    "bin", "apk", "app", "reg", "lnk", "elf", "macho",
}

MIME_BY_EXT: dict[str, set[str]] = {
    "pdf": {"application/pdf", "application/octet-stream"},
    "doc": {"application/msword", "application/octet-stream"},
    "docx": {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
        "application/octet-stream",
    },
    "xls": {"application/vnd.ms-excel", "application/octet-stream"},
    "xlsx": {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/zip",
        "application/octet-stream",
    },
    "ppt": {"application/vnd.ms-powerpoint", "application/octet-stream"},
    "pptx": {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/octet-stream",
    },
    "zip": {"application/zip", "application/x-zip-compressed", "application/octet-stream"},
    "rar": {"application/vnd.rar", "application/x-rar-compressed", "application/octet-stream"},
    "7z": {"application/x-7z-compressed", "application/octet-stream"},
    "txt": {"text/plain", "application/octet-stream"},
    "csv": {"text/csv", "application/csv", "text/plain", "application/octet-stream"},
    "md": {"text/markdown", "text/plain", "application/octet-stream"},
    "json": {"application/json", "text/json", "text/plain", "application/octet-stream"},
    "xml": {"application/xml", "text/xml", "text/plain", "application/octet-stream"},
}

# 扩展名 -> 展示用 MIME（检测后兜底）
DEFAULT_MIME_BY_EXT: dict[str, str] = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
    "rar": "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    "txt": "text/plain",
    "csv": "text/csv",
    "md": "text/markdown",
    "json": "application/json",
    "xml": "application/xml",
}

EXECUTABLE_MAGICS = (
    b"MZ",                 # PE
    b"\x7fELF",            # ELF
    b"\xfe\xed\xfa\xce",   # Mach-O 32 BE
    b"\xfe\xed\xfa\xcf",   # Mach-O 64 BE
    b"\xcf\xfa\xed\xfe",   # Mach-O 64 LE
)

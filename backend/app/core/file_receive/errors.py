"""文件接收业务异常。

统一承载对外错误码、HTTP 状态、是否可重试与重试等待时间。
由 ``app.main`` 注册全局异常处理器转换为标准错误响应。
"""


class FileReceiveError(Exception):
    """文件接收业务异常。"""

    def __init__(
        self,
        code: str,
        http_status: int,
        message: str,
        *,
        retryable: bool = False,
        retry_after: int | None = None,
        details: list[dict] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.message = message
        self.retryable = retryable
        self.retry_after = retry_after
        self.details = details or []

    def __repr__(self) -> str:
        return f"<FileReceiveError {self.code} http={self.http_status}>"

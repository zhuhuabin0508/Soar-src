# ===== SOAR 后端镜像 =====
# Python 3.11 slim 基础镜像
FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 环境变量：避免生成 .pyc、不缓冲输出（日志即时可见）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# 出站代理：构建机无法直连外网时，通过 --build-arg 注入宿主代理（如
# HTTP_PROXY=http://127.0.0.1:8999）。未注入时为空，apt/pip 直连。
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY}
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null \
    || true
# 安装系统依赖
# libpq-dev：PostgreSQL 客户端库头文件（psycopg2-binary 为预编译，但保留以确保兼容）
# gcc + libc6-dev：部分依赖（jieba 等）在 ARM64 上无预编译 wheel，需从源码编译，需要 C 标准库头文件
# postgresql-client：pg_dump / psql 命令行工具（数据备份与恢复）
# libjpeg-dev + zlib1g-dev：Pillow（图形验证码）编译所需的 JPEG/PNG 库头文件
# libreoffice-writer + fonts-noto-cjk：报告 docx → PDF 保真预览（soffice --headless）；
#   镜像会增大约 400MB，如不需要 PDF 可移除，并通过 REPORT_SOFFICE_BIN 接入外部转换服务
RUN if [ -n "$HTTP_PROXY" ]; then \
        echo "Acquire::http::Proxy \"$HTTP_PROXY\";"  > /etc/apt/apt.conf.d/99proxy; \
        echo "Acquire::https::Proxy \"$HTTPS_PROXY\";" >> /etc/apt/apt.conf.d/99proxy; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
        libc6-dev \
        postgresql-client \
        libjpeg-dev \
        zlib1g-dev \
        libreoffice-writer \
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# 先单独复制 requirements.txt 安装依赖，利用 Docker 缓存层
# --mount=type=cache：pip 下载缓存跨构建持久化（QEMU 交叉构建中断后重试可复用已下载包）
# --prefer-binary：优先使用预编译 wheel，避免在 QEMU 下从源码编译
# --only-binary psutil：强制 psutil 使用 wheel（5.9.8 有 aarch64 abi3 wheel），避免 ~15min 的 C 编译
# 使用国内 pip 镜像源加速下载（离线构建环境无法直连 pypi.org）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com

# 构建时间戳（用于破坏缓存，确保每次构建都使用最新代码）
ARG BUILD_DATE=unknown
ENV BUILD_DATE=${BUILD_DATE}

# 复制应用代码与入口脚本
COPY app ./app
COPY scripts ./scripts
COPY entrypoint.sh ./entrypoint.sh

# 赋予入口脚本可执行权限
RUN chmod +x ./entrypoint.sh

# 暴露 FastAPI 服务端口
EXPOSE 8000

# 入口：等待 PG 就绪并建表，随后启动 uvicorn
ENTRYPOINT ["./entrypoint.sh"]

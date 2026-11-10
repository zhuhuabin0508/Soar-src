"""智能体文件 API：上传 / 列表 / 下载 / 删除。

上传的文件原样存储（不做 RAG 切片/向量化），供智能体通过 ``read_document`` 工具按需读取。
支持类型：xlsx / xls / docx / pdf / csv / txt / json / md。

归属隔离（双层）：
- 上传时记录 ``created_by``（上传用户）与 ``agent_id``（归属智能体，可选）。
- 列表/下载可见性：公共文件（agent_id 为空，含历史文件）+ 本人上传的文件
  （传 ``agent_id`` 时进一步限定为属于该智能体的文件）。
"""
import logging
import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models.agent_file import AgentFile
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/agent-files",
    tags=["agent-files"],
    dependencies=[Depends(get_current_user)],
)

# 上传文件保存目录：backend/uploads/agent_files/
# __file__ = backend/app/api/v1/agent_files.py，上溯 4 级到 backend/
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
    "agent_files",
)

# 允许的文件扩展名（小写，不含点）
ALLOWED_EXTENSIONS = {
    "xlsx", "xls", "docx", "pdf", "csv", "txt", "json", "md",
}

# 文件大小上限：50MB
MAX_FILE_SIZE = 50 * 1024 * 1024


def _ensure_upload_dir() -> None:
    """确保上传目录存在。"""
    os.makedirs(UPLOAD_DIR, exist_ok=True)


def _visible_filter(user_id: int, agent_id: int | None):
    """构造文件可见性过滤条件：公共文件 + 本人文件（可选限定归属智能体）。

    双层隔离规则：
    - ``agent_id`` 为空（公共/历史）→ 所有用户可见（兼容旧数据）。
    - 本人上传且（未指定智能体 或 属于当前智能体）→ 可见。
    - 他人上传到同一智能体的文件 → 不可见。
    """
    if agent_id is not None:
        return or_(
            AgentFile.agent_id.is_(None),
            and_(
                AgentFile.created_by == user_id,
                or_(
                    AgentFile.agent_id.is_(None),
                    AgentFile.agent_id == agent_id,
                ),
            ),
        )
    return or_(
        AgentFile.agent_id.is_(None),
        AgentFile.created_by == user_id,
    )


@router.post("/upload")
async def upload_agent_file(
    file: UploadFile = File(...),
    agent_id: int | None = Query(None, description="归属智能体 id（可选，用于隔离）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """上传一个文件（不做 RAG，原样存储）。

    记录上传用户（created_by）与归属智能体（agent_id，可选）；
    返回文件元数据（id / original_name / file_type / file_size）。
    前端拿到后可展示在文件列表中供用户勾选。
    """
    _ensure_upload_dir()

    original_name = file.filename or "unknown"
    # 取扩展名（小写）
    ext = ""
    if "." in original_name:
        ext = original_name.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: .{ext}，仅支持 {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    # 读取文件内容并检查大小
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过 50MB 限制")

    # 生成唯一存储文件名，避免冲突
    stored_name = f"{uuid.uuid4().hex}.{ext}"
    file_path = os.path.join(UPLOAD_DIR, stored_name)
    with open(file_path, "wb") as f:
        f.write(content)

    # 写入数据库（记录归属：上传用户 + 可选智能体；来源=用户上传）
    record = AgentFile(
        original_name=original_name,
        stored_name=stored_name,
        file_path=file_path,
        file_type=ext,
        file_size=len(content),
        agent_id=agent_id,
        created_by=current_user.id,
        source="upload",
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    logger.info("智能体文件上传成功: id=%s, name=%s, type=%s, size=%d, agent_id=%s, by=%s",
                record.id, record.original_name, record.file_type, record.file_size,
                record.agent_id, current_user.id)

    return {
        "id": record.id,
        "original_name": record.original_name,
        "stored_name": record.stored_name,
        "file_type": record.file_type,
        "file_size": record.file_size,
        "agent_id": record.agent_id,
        "source": record.source,
        "created_at": record.created_at.isoformat() if record.created_at else None,
    }


@router.get("")
def list_agent_files(
    agent_id: int | None = Query(None, description="按智能体过滤（可选）"),
    source: str | None = Query(
        None,
        description="按来源过滤（可选）：upload=用户上传，agent=对话中工具生成。",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出可见的智能体文件：公共文件 + 本人上传的文件（可选限定智能体/来源）。

    ``source=upload`` 供对话页"已上传文件"区域使用——工具在对话过程中生成的
    交付/中间产物（source=agent）不属于用户上传内容，不应出现在该列表中，
    它们只通过消息气泡内的下载卡片暴露。
    """
    query = db.query(AgentFile).filter(_visible_filter(current_user.id, agent_id))
    if source:
        query = query.filter(AgentFile.source == source)
    records = query.order_by(AgentFile.created_at.desc()).all()
    return [
        {
            "id": r.id,
            "original_name": r.original_name,
            "stored_name": r.stored_name,
            "file_type": r.file_type,
            "file_size": r.file_size,
            "agent_id": r.agent_id,
            "source": r.source,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in records
    ]


@router.get("/{file_id}/download")
def download_agent_file(
    file_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """下载已上传的文件（含 expand_risk_detail 等工具生成的输出文件）。

    仅允许下载：公共文件 + 本人上传的文件。以原始文件名作为下载文件名。
    """
    record = db.query(AgentFile).filter(AgentFile.id == file_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    if record.agent_id is not None and record.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="无权下载该文件（仅上传者或公共文件可下载）")
    if not os.path.exists(record.file_path):
        raise HTTPException(status_code=404, detail="文件在磁盘上不存在")
    # 原始文件名可能含中文/空格，FileResponse 自动做 RFC 5987 编码
    return FileResponse(
        record.file_path,
        filename=record.original_name,
        media_type="application/octet-stream",
    )


@router.delete("/{file_id}")
def delete_agent_file(
    file_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除一个已上传的文件（同时删除磁盘文件）。

    仅允许删除：本人上传的文件 + 公共文件（无归属）。
    """
    record = db.query(AgentFile).filter(AgentFile.id == file_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    if record.agent_id is not None and record.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除该文件（仅上传者或公共文件可删除）")

    # 删除磁盘文件
    try:
        if os.path.exists(record.file_path):
            os.remove(record.file_path)
    except OSError as exc:
        logger.warning("删除磁盘文件失败: %s, error=%s", record.file_path, exc)

    db.delete(record)
    db.commit()
    logger.info("智能体文件已删除: id=%s, name=%s", file_id, record.original_name)
    return {"ok": True, "deleted": file_id}

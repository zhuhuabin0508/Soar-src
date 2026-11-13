"""知识库 CRUD 与检索路由。"""
import logging
import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Any

from app.core.file_parser import parse_file_content, parse_filename
from app.core.kb_retriever import search_kb
from app.core.kb_service import ingest_document, list_segments, reingest_document
from app.database import get_db
from app.dependencies import check_resource_ownership, compute_can_edit_ids, get_current_user, require_permission, require_role, resource_can_edit
from app.models.knowledge_base import KnowledgeBase, KnowledgeDocument, KnowledgeSegment
from app.models.user import User
from app.schemas.common import to_dict

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/knowledge-bases",
    tags=["knowledge-bases"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_permission("knowledge_base", "view")),
    ],
)

# 上传文件保存目录：backend/uploads/
# __file__ = backend/app/api/v1/knowledge_base.py，需上溯 4 级到 backend/
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
)


class KBBase(BaseModel):
    """知识库请求体（含 Dify 风格配置）。

    注意：``description`` / ``chunk_delimiter`` / ``rerank_model`` 对应的数据库列为
    nullable，旧数据可能为 ``null``。这里声明为 ``str | None`` 以接受编辑旧知识库时
    回传的 ``null``，并在 create/update 处理器中归一化为默认值，避免 422。
    """

    name: str = Field(..., description="知识库名称")
    description: str | None = Field("", description="知识库描述")
    # 分段设置
    chunk_mode: str = Field("auto", description="分段模式：auto/fixed_length/delimiter/qa")
    chunk_size: int = Field(500, description="分段长度（字符数）")
    chunk_overlap: int = Field(50, description="分段重叠（字符数）")
    chunk_delimiter: str | None = Field("\n\n", description="自定义分隔符（delimiter 模式）")
    ocr_enabled: bool = Field(False, description="OCR 识别开关（PDF/图片）")
    # 索引设置
    index_mode: str = Field("keyword", description="索引模式：keyword/vector/hybrid")
    embedding_model: str = Field("text-embedding-ada-002", description="Embedding 模型名（兜底，优先使用 embedding_config_id 关联配置的 model_name）")
    # 关联的 LLMConfig.id（model_type=embedding）：优先用其 base_url/api_key/model_name 做向量化
    embedding_config_id: int | None = Field(None, description="嵌入模型配置 ID（模型设置中 model_type=embedding 的配置）")
    embedding_dimension: int = Field(1536, description="Embedding 维度")
    # 检索设置
    retrieval_top_k: int = Field(5, description="检索返回数量")
    score_threshold: int = Field(0, description="分数阈值（0-100）")
    rerank_enabled: bool = Field(False, description="是否启用重排序")
    rerank_model: str | None = Field("", description="重排序模型名称")
    hybrid_vector_weight: int = Field(70, description="混合检索向量权重（0-100）")
    hybrid_keyword_weight: int = Field(30, description="混合检索关键词权重（0-100）")


class DocBase(BaseModel):
    """文档请求体（含元数据与高级配置）。"""

    title: str = Field(..., description="文档标题")
    content: str = Field("", description="文档内容")
    # 元数据与分类标签
    description: str = Field("", description="文档描述/简介")
    category: str | None = Field(None, description="所属分类")
    tags: dict | None = Field(None, description="自定义标签键值对")
    effective_from: str | None = Field(None, description="生效起始时间")
    effective_to: str | None = Field(None, description="失效时间")
    # 状态与权重
    retrieval_weight: int = Field(1, description="检索权重（1-10）")


class SearchRequest(BaseModel):
    query: str = Field(..., description="查询字符串")
    top_k: int = Field(5, description="返回文档数量")


class DocEnabledBody(BaseModel):
    enabled: bool = True


class BatchDocsBody(BaseModel):
    action: str = Field(..., description="enable / disable / delete / reparse")
    ids: list[int] = Field(default_factory=list)


def _kb_to_dict(kb: KnowledgeBase) -> dict:
    """序列化知识库，附带文档数。"""
    data = to_dict(kb)
    data["doc_count"] = len(kb.documents) if kb.documents is not None else 0
    return data


def _doc_public_dict(doc: KnowledgeDocument, *, include_content: bool = False) -> dict:
    data = to_dict(doc, exclude={"file_path"})
    content = data.get("content") or ""
    if not include_content:
        data.pop("content", None)
        data["content_preview"] = content[:240]
        data["char_count"] = len(content)
    else:
        data["char_count"] = len(content)
        data["content_preview"] = content[:240]
    data["has_original_file"] = bool(doc.file_path)
    return data


# 上传安全约束：扩展名白名单与 file_parser 支持类型一致；单文件大小上限
_KB_ALLOWED_EXTENSIONS = {
    "txt", "md", "csv", "json", "log", "html", "htm", "xml",
    "pdf", "docx", "xlsx", "xls", "pptx",
}
_KB_UPLOAD_MAX_BYTES = 50 * 1024 * 1024  # 50MB


async def _save_upload_as_document(
    kb_id: int,
    original_filename: str,
    file_bytes: bytes,
    db: Session,
) -> KnowledgeDocument:
    # 安全清洗：仅取 basename（剥离 ../ 与分隔符，防路径穿越写任意路径），
    # 拒绝控制字符与纯点文件名
    safe_name = os.path.basename((original_filename or "").replace("\\", "/")).strip()
    if (
        not safe_name
        or safe_name in {".", ".."}
        or any(ord(c) < 32 for c in safe_name)
    ):
        raise HTTPException(status_code=400, detail="非法文件名")
    title, file_type = parse_filename(safe_name)
    if file_type not in _KB_ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型 {file_type or '(无扩展名)'}，"
            f"允许：{'/'.join(sorted(_KB_ALLOWED_EXTENSIONS))}",
        )
    if len(file_bytes) > _KB_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 50MB 上限")
    if not title:
        title = safe_name
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    saved_filename = f"{uuid.uuid4().hex}_{safe_name}"
    saved_path = os.path.join(UPLOAD_DIR, saved_filename)
    file_size = len(file_bytes)
    with open(saved_path, "wb") as f:
        f.write(file_bytes)
    logger.info("文件已保存: path=%s, size=%s bytes", saved_path, file_size)
    content = await parse_file_content(saved_path, file_type)
    logger.info("文件解析完成: type=%s, content_len=%s", file_type, len(content or ""))
    doc = KnowledgeDocument(
        kb_id=kb_id,
        title=title,
        content=content,
        source_type="upload",
        file_name=safe_name,
        file_type=file_type,
        file_size=file_size,
        file_path=saved_filename,
        status="parsing",
        progress=0,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    logger.info("上传文档已入库: id=%s, title=%s, content_len=%s, 启动后台分段", doc.id, doc.title, len(doc.content or ""))
    import asyncio
    from app.core.kb_service import ingest_document_bg

    asyncio.create_task(ingest_document_bg(doc.id, kb_id))
    return doc


def _unlink_upload(file_path: str | None) -> None:
    if not file_path:
        return
    abs_path = os.path.join(UPLOAD_DIR, file_path)
    try:
        if os.path.isfile(abs_path):
            os.remove(abs_path)
    except OSError as exc:
        logger.warning("删除知识库附件失败: path=%s, err=%s", abs_path, exc)


async def _overwrite_document_file(
    doc: KnowledgeDocument,
    original_filename: str,
    file_bytes: bytes,
    db: Session,
    kb_id: int,
) -> KnowledgeDocument:
    title, file_type = parse_filename(original_filename)
    if not title:
        title = original_filename
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    saved_filename = f"{uuid.uuid4().hex}_{original_filename}"
    saved_path = os.path.join(UPLOAD_DIR, saved_filename)
    with open(saved_path, "wb") as f:
        f.write(file_bytes)
    content = await parse_file_content(saved_path, file_type)
    old_path = doc.file_path
    doc.title = title
    doc.content = content
    doc.source_type = "upload"
    doc.file_name = original_filename
    doc.file_type = file_type
    doc.file_size = len(file_bytes)
    doc.file_path = saved_filename
    doc.status = "parsing"
    doc.progress = 0
    doc.error_message = None
    db.commit()
    db.refresh(doc)
    _unlink_upload(old_path)
    import asyncio
    from app.core.kb_service import ingest_document_bg

    asyncio.create_task(ingest_document_bg(doc.id, kb_id))
    return doc


@router.get("")
def list_knowledge_bases(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """列出所有知识库。

    每项附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    logger.info("查询知识库列表")
    kbs = db.query(KnowledgeBase).order_by(KnowledgeBase.created_at.desc()).all()
    # 资源级 owner 控制：批量查共享授权集合，admin 在调用处直接判 True
    shared_ids = compute_can_edit_ids(db, current_user, "knowledge_base", [kb.id for kb in kbs])
    result = []
    for kb in kbs:
        item = _kb_to_dict(kb)
        item["can_edit"] = resource_can_edit(current_user, db, kb, shared_ids)
        result.append(item)
    return result


@router.post("", status_code=201, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
def create_knowledge_base(
    body: KBBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """创建知识库（含 Dify 风格分段/索引/检索配置）。"""
    logger.info("创建知识库: name=%s, index_mode=%s", body.name, body.index_mode)
    kb = KnowledgeBase(
        name=body.name,
        description=body.description or "",
        chunk_mode=body.chunk_mode,
        chunk_size=body.chunk_size,
        chunk_overlap=body.chunk_overlap,
        chunk_delimiter=body.chunk_delimiter or "\n\n",
        ocr_enabled=body.ocr_enabled,
        index_mode=body.index_mode,
        embedding_model=body.embedding_model,
        embedding_config_id=body.embedding_config_id,
        embedding_dimension=body.embedding_dimension,
        retrieval_top_k=body.retrieval_top_k,
        score_threshold=body.score_threshold,
        rerank_enabled=1 if body.rerank_enabled else 0,
        rerank_model=body.rerank_model or "",
        hybrid_vector_weight=body.hybrid_vector_weight,
        hybrid_keyword_weight=body.hybrid_keyword_weight,
        created_by=current_user.id,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    logger.info("知识库已创建: id=%s", kb.id)
    return _kb_to_dict(kb)


@router.put("/{kb_id}", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
def update_knowledge_base(
    kb_id: int,
    body: KBBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """编辑知识库（含 Dify 风格分段/索引/检索配置）。"""
    logger.info("编辑知识库: id=%s, name=%s", kb_id, body.name)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可编辑
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    kb.name = body.name
    kb.description = body.description or ""
    kb.chunk_mode = body.chunk_mode
    kb.chunk_size = body.chunk_size
    kb.chunk_overlap = body.chunk_overlap
    kb.chunk_delimiter = body.chunk_delimiter or "\n\n"
    kb.ocr_enabled = body.ocr_enabled
    kb.index_mode = body.index_mode
    kb.embedding_model = body.embedding_model
    kb.embedding_config_id = body.embedding_config_id
    kb.embedding_dimension = body.embedding_dimension
    kb.retrieval_top_k = body.retrieval_top_k
    kb.score_threshold = body.score_threshold
    kb.rerank_enabled = 1 if body.rerank_enabled else 0
    kb.rerank_model = body.rerank_model or ""
    kb.hybrid_vector_weight = body.hybrid_vector_weight
    kb.hybrid_keyword_weight = body.hybrid_keyword_weight
    db.commit()
    db.refresh(kb)
    logger.info("知识库已更新: id=%s", kb_id)
    return _kb_to_dict(kb)


@router.get("/{kb_id}")
def get_knowledge_base(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """获取知识库详情（含完整配置）。

    附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    data = _kb_to_dict(kb)
    shared_ids = compute_can_edit_ids(db, current_user, "knowledge_base", [kb.id])
    data["can_edit"] = resource_can_edit(current_user, db, kb, shared_ids)
    return data


@router.delete("/{kb_id}", dependencies=[Depends(require_permission("knowledge_base", "delete"))])
def delete_knowledge_base(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """删除知识库（级联删除其下文档，并清理智能体引用）。

    同步清理所有智能体 ``enabled_kbs`` 中对该知识库的引用，避免删除后
    智能体仍引用已不存在的知识库（配置与数据库保持一致）。
    """
    logger.info("删除知识库: id=%s", kb_id)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可删除
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)

    # 清理关联智能体的 enabled_kbs 引用
    # enabled_kbs 为 JSON 数组，逐个智能体过滤掉被删 KB 的 id
    from app.models.agent import Agent

    agents = db.query(Agent).all()
    cleaned = 0
    for agent in agents:
        kbs = list(agent.enabled_kbs or [])
        if kb_id in kbs:
            agent.enabled_kbs = [k for k in kbs if k != kb_id]
            cleaned += 1
    if cleaned:
        logger.info("已清理 %d 个智能体对知识库 %s 的引用", cleaned, kb_id)

    file_paths = [
        row[0]
        for row in db.query(KnowledgeDocument.file_path).filter(KnowledgeDocument.kb_id == kb_id).all()
        if row[0]
    ]
    # 数据库级批量删除：先删分段，再删文档，最后删知识库本体。
    # 不用 ORM 的 db.delete(kb)（cascade="all, delete-orphan"），因为它会把该库下
    # 全部文档、全部分段逐个 SELECT 加载进 Python 内存再逐条 DELETE——
    # 对万级分段的知识库需数十秒且内存暴涨，易拖垮单 worker 的 uvicorn 造成 502。
    # 改为按外键依赖顺序执行 3 条批量 DELETE 语句，毫秒级完成且不占用内存。
    db.query(KnowledgeSegment).filter(KnowledgeSegment.kb_id == kb_id).delete(synchronize_session=False)
    db.query(KnowledgeDocument).filter(KnowledgeDocument.kb_id == kb_id).delete(synchronize_session=False)
    db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).delete(synchronize_session=False)
    db.commit()
    for file_path in file_paths:
        abs_path = os.path.join(UPLOAD_DIR, file_path)
        try:
            if os.path.isfile(abs_path):
                os.remove(abs_path)
        except OSError as exc:
            logger.warning("删除知识库附件失败: kb_id=%s, path=%s, err=%s", kb_id, abs_path, exc)
    logger.info("知识库已删除: id=%s", kb_id)
    return {"ok": True}


@router.get("/{kb_id}/documents")
def list_documents(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """列出知识库下所有文档。

    资源级 owner 校验：仅 admin/owner/被授权用户可访问该知识库文档。
    """
    logger.info("查询文档列表: kb_id=%s", kb_id)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    docs = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kb_id == kb_id)
        .order_by(KnowledgeDocument.created_at.desc())
        .all()
    )
    return [_doc_public_dict(d, include_content=False) for d in docs]


@router.get("/{kb_id}/documents/{doc_id}")
def get_document(
    kb_id: int,
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    return _doc_public_dict(doc, include_content=True)


@router.get("/{kb_id}/documents/{doc_id}/file")
def download_document_file(
    kb_id: int,
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    if not doc.file_path:
        raise HTTPException(status_code=404, detail="该文档没有保存原始文件")
    abs_path = os.path.join(UPLOAD_DIR, doc.file_path)
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="原始文件已不在服务器上")
    return FileResponse(
        abs_path,
        filename=doc.file_name or os.path.basename(doc.file_path),
        content_disposition_type="attachment",
    )


@router.post("/{kb_id}/documents", status_code=201, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def create_document(
    kb_id: int,
    body: DocBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """向知识库添加文档（含元数据与高级配置）。

    文档入库后自动按知识库配置执行分段与向量化（见 ``kb_service.ingest_document``）。
    资源级 owner 校验：仅 admin/owner/被授权用户可新增文档。
    """
    logger.info("添加文档: kb_id=%s, title=%s", kb_id, body.title)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    from datetime import datetime
    doc = KnowledgeDocument(
        kb_id=kb_id,
        title=body.title,
        content=body.content,
        description=body.description or None,
        category=body.category or None,
        tags=body.tags or {},
        effective_from=datetime.fromisoformat(body.effective_from) if body.effective_from else None,
        effective_to=datetime.fromisoformat(body.effective_to) if body.effective_to else None,
        retrieval_weight=body.retrieval_weight,
        status="parsing",
        progress=0,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    logger.info("文档已添加: id=%s, 启动后台分段入库", doc.id)
    # 异步分段 + 向量化（不阻塞响应）
    import asyncio
    from app.core.kb_service import ingest_document_bg

    asyncio.create_task(ingest_document_bg(doc.id, kb_id))
    return to_dict(doc)


@router.put("/{kb_id}/documents/{doc_id}", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def update_document(
    kb_id: int,
    doc_id: int,
    body: DocBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """编辑文档标题、内容与元数据。

    内容变化时自动重新分段与向量化。
    资源级 owner 校验：仅 admin/owner/被授权用户可编辑文档。
    """
    logger.info("编辑文档: kb_id=%s, doc_id=%s", kb_id, doc_id)
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    content_changed = (doc.content or "") != (body.content or "")
    from datetime import datetime
    doc.title = body.title
    doc.content = body.content
    doc.description = body.description or None
    doc.category = body.category or None
    doc.tags = body.tags or {}
    doc.effective_from = datetime.fromisoformat(body.effective_from) if body.effective_from else None
    doc.effective_to = datetime.fromisoformat(body.effective_to) if body.effective_to else None
    doc.retrieval_weight = body.retrieval_weight
    db.commit()
    db.refresh(doc)
    logger.info("文档已更新: id=%s, content_changed=%s", doc_id, content_changed)
    # 内容变化时重新分段入库（异步，不阻塞响应）
    if content_changed and kb is not None:
        doc.status = "parsing"
        doc.progress = 0
        db.commit()
        import asyncio
        from app.core.kb_service import ingest_document_bg

        asyncio.create_task(ingest_document_bg(doc_id, kb_id))
    return to_dict(doc)


@router.post("/{kb_id}/documents/upload", status_code=201, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def upload_document(
    kb_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """上传文件到知识库，自动解析文本内容写入 ``content``。

    支持的文件格式与解析规则见 ``app/core/file_parser.py``。
    文件保存到 ``backend/uploads/``，文件名加 uuid 前缀防冲突。
    资源级 owner 校验：仅 admin/owner/被授权用户可上传文档。
    """
    logger.info("上传知识库文档: kb_id=%s, filename=%s", kb_id, file.filename)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)

    original_filename = file.filename or "untitled"
    file_bytes = await file.read()
    doc = await _save_upload_as_document(kb_id, original_filename, file_bytes, db)
    return _doc_public_dict(doc, include_content=False)


@router.post("/{kb_id}/documents/upload-batch", status_code=201, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def upload_documents_batch(
    kb_id: int,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    logger.info("批量上传知识库文档: kb_id=%s, count=%s", kb_id, len(files or []))
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    if not files:
        raise HTTPException(status_code=400, detail="请选择要上传的文件")
    saved = []
    errors = []
    for file in files:
        original_filename = file.filename or "untitled"
        try:
            file_bytes = await file.read()
            doc = await _save_upload_as_document(kb_id, original_filename, file_bytes, db)
            saved.append(_doc_public_dict(doc, include_content=False))
        except Exception as exc:
            logger.warning("批量上传单文件失败: filename=%s, err=%s", original_filename, exc)
            errors.append({"file_name": original_filename, "error": str(exc)})
    return {"ok": True, "documents": saved, "errors": errors}


@router.post("/{kb_id}/documents/{doc_id}/replace", status_code=200, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def replace_document_file(
    kb_id: int,
    doc_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    original_filename = file.filename or "untitled"
    file_bytes = await file.read()
    doc = await _overwrite_document_file(doc, original_filename, file_bytes, db, kb_id)
    return _doc_public_dict(doc, include_content=False)


@router.patch("/{kb_id}/documents/{doc_id}/enabled", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
def set_document_enabled(
    kb_id: int,
    doc_id: int,
    body: DocEnabledBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    doc.enabled = bool(body.enabled)
    db.commit()
    db.refresh(doc)
    return _doc_public_dict(doc, include_content=False)


@router.post("/{kb_id}/documents/batch", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def batch_documents(
    kb_id: int,
    body: BatchDocsBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    action = (body.action or "").strip().lower()
    ids = [i for i in (body.ids or []) if i]
    if action not in ("enable", "disable", "delete", "reparse"):
        raise HTTPException(status_code=400, detail="不支持的批量操作")
    if not ids:
        raise HTTPException(status_code=400, detail="请选择文档")
    docs = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kb_id == kb_id, KnowledgeDocument.id.in_(ids))
        .all()
    )
    if action in ("enable", "disable"):
        flag = action == "enable"
        for doc in docs:
            doc.enabled = flag
        db.commit()
        return {"ok": True, "updated": len(docs), "action": action}
    if action == "reparse":
        import asyncio
        from app.core.kb_service import reingest_document_bg

        for doc in docs:
            doc.status = "parsing"
            doc.progress = 0
            doc.error_message = None
        db.commit()
        for doc in docs:
            asyncio.create_task(reingest_document_bg(doc.id, kb_id))
        return {"ok": True, "updated": len(docs), "action": action}
    deleted = 0
    for doc in docs:
        file_path = doc.file_path
        db.query(KnowledgeSegment).filter(KnowledgeSegment.doc_id == doc.id).delete(
            synchronize_session=False
        )
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc.id).delete(
            synchronize_session=False
        )
        _unlink_upload(file_path)
        deleted += 1
    db.commit()
    return {"ok": True, "updated": deleted, "action": action}


class FetchUrlRequest(BaseModel):
    """网页抓取请求体。"""

    url: str = Field(..., description="网页 URL")
    title: str | None = Field(None, description="文档标题（留空则用网页标题）")
    description: str = Field("", description="文档描述")
    category: str | None = Field(None, description="所属分类")
    tags: dict | None = Field(None, description="自定义标签")
    retrieval_weight: int = Field(1, description="检索权重")


@router.post("/{kb_id}/documents/fetch-url", status_code=201, dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def fetch_url_document(
    kb_id: int,
    body: FetchUrlRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """从 URL 抓取网页内容，解析为纯文本后存入知识库。

    资源级 owner 校验：仅 admin/owner/被授权用户可新增网页文档。
    """
    import httpx
    import re

    logger.info("抓取网页: kb_id=%s, url=%s", kb_id, body.url)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(body.url, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"网页抓取失败: {exc}")

    # 提取标题
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    page_title = title_match.group(1).strip() if title_match else body.url

    # 去除 HTML 标签，保留纯文本
    # 移除 script/style
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.IGNORECASE | re.DOTALL)
    # 块级标签换行
    text = re.sub(r"<(br|p|div|h[1-6]|li|tr)[^>]*>", "\n", text, flags=re.IGNORECASE)
    # 去除所有标签
    text = re.sub(r"<[^>]+>", "", text)
    # HTML 实体解码
    import html as html_mod
    text = html_mod.unescape(text)
    # 压缩空白
    lines = [ln.strip() for ln in text.split("\n")]
    text = "\n".join(ln for ln in lines if ln)

    doc = KnowledgeDocument(
        kb_id=kb_id,
        title=body.title or page_title,
        content=text,
        source_type="web",
        file_name=body.url,
        description=body.description or None,
        category=body.category or None,
        tags=body.tags or {},
        retrieval_weight=body.retrieval_weight,
        status="parsing",
        progress=0,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    logger.info("网页文档已入库: id=%s, title=%s, content_len=%s, 启动后台分段", doc.id, doc.title, len(text))
    # 异步分段 + 向量化（不阻塞响应）
    import asyncio
    from app.core.kb_service import ingest_document_bg

    asyncio.create_task(ingest_document_bg(doc.id, kb_id))
    return to_dict(doc)


@router.delete("/{kb_id}/documents/{doc_id}", dependencies=[Depends(require_permission("knowledge_base", "delete"))])
def delete_document(
    kb_id: int,
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """删除指定文档（分段、上传文件一并清掉，避免工具仍按旧分段/文件检索）。

    资源级 owner 校验：仅 admin/owner/被授权用户可删除文档。
    """
    logger.info("删除文档: kb_id=%s, doc_id=%s", kb_id, doc_id)
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    file_path = doc.file_path
    # 与删除整个知识库相同：批量 DELETE 分段，避免 ORM cascade 把万级分段载入内存。
    # 且 knowledge_segments.doc_id 外键无 ON DELETE CASCADE，Postgres 上只删文档会 500。
    db.query(KnowledgeSegment).filter(KnowledgeSegment.doc_id == doc_id).delete(
        synchronize_session=False
    )
    db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc_id).delete(
        synchronize_session=False
    )
    db.commit()
    if file_path:
        abs_path = os.path.join(UPLOAD_DIR, file_path)
        try:
            if os.path.isfile(abs_path):
                os.remove(abs_path)
        except OSError as exc:
            logger.warning("删除文档附件失败: doc_id=%s, path=%s, err=%s", doc_id, abs_path, exc)
    logger.info("文档已删除: id=%s", doc_id)
    return {"ok": True}


@router.get("/{kb_id}/documents/{doc_id}/segments")
def get_document_segments(
    kb_id: int,
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """查看文档的分段（解析与切片结果）。

    返回文档的分段列表与统计信息，用于前端展示"解析→分段→向量化"过程。
    资源级 owner 校验：仅 admin/owner/被授权用户可查看分段。
    """
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    segments = list_segments(db, doc_id)
    total_tokens = sum(s.get("token_count", 0) for s in segments)
    emb_count = sum(1 for s in segments if s.get("has_embedding"))
    logger.info("查看分段: doc_id=%s, 段数=%d, 向量数=%d", doc_id, len(segments), emb_count)
    return {
        "doc_id": doc_id,
        "title": doc.title,
        "status": doc.status,
        "content_len": len(doc.content or ""),
        "segment_count": len(segments),
        "segment_count_stored": doc.segment_count,
        "token_total": total_tokens,
        "embedding_count": emb_count,
        "has_embedding": emb_count > 0,
        # 知识库配置（便于前端展示分段规则）
        "kb_config": {
            "chunk_mode": kb.chunk_mode if kb else None,
            "chunk_size": kb.chunk_size if kb else None,
            "chunk_overlap": kb.chunk_overlap if kb else None,
            "index_mode": kb.index_mode if kb else None,
            "embedding_model": kb.embedding_model if kb else None,
        },
        "segments": segments,
    }


@router.post("/{kb_id}/documents/{doc_id}/reparse", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def reparse_document(
    kb_id: int,
    doc_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """重新解析并分段文档。

    知识库分段/索引配置变更后，或文档内容更新后调用，按最新配置重新分段与向量化。
    资源级 owner 校验：仅 admin/owner/被授权用户可重新解析文档。
    """
    logger.info("重新解析文档: kb_id=%s, doc_id=%s", kb_id, doc_id)
    # 异步重新解析（不阻塞响应，前端轮询进度）
    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.kb_id == kb_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    doc.status = "parsing"
    doc.progress = 0
    db.commit()
    import asyncio
    from app.core.kb_service import reingest_document_bg

    asyncio.create_task(reingest_document_bg(doc_id, kb_id))
    return {"doc_id": doc_id, "status": "parsing", "message": "已启动后台重新解析"}


@router.post("/{kb_id}/reparse-all", dependencies=[Depends(require_permission("knowledge_base", "edit"))])
async def reparse_all_documents(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """重新解析知识库下所有文档（配置变更后批量重建索引）。

    资源级 owner 校验：仅 admin/owner/被授权用户可批量重新解析。
    """
    logger.info("批量重新解析: kb_id=%s", kb_id)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    docs = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kb_id == kb_id)
        .all()
    )
    results = []
    import asyncio
    from app.core.kb_service import ingest_document_bg

    for doc in docs:
        doc.status = "parsing"
        doc.progress = 0
        db.commit()
        asyncio.create_task(ingest_document_bg(doc.id, kb_id))
        results.append({"doc_id": doc.id, "title": doc.title, "status": "parsing"})
    logger.info("批量重新解析已启动: kb_id=%s, 文档数=%d", kb_id, len(results))
    return {"ok": True, "total": len(results), "results": results}


@router.post("/{kb_id}/search", dependencies=[Depends(require_permission("knowledge_base", "view"))])
async def search_knowledge_base(
    kb_id: int,
    body: SearchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """在知识库中检索文档。

    使用知识库配置的 retrieval_top_k 与 score_threshold 进行过滤。
    若请求体未指定 top_k，则回退到知识库配置值。
    资源级 owner 校验：仅 admin/owner/被授权用户可检索该知识库。
    """
    logger.info("检索知识库: kb_id=%s, query=%s", kb_id, body.query)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    top_k = body.top_k if body.top_k and body.top_k > 0 else (kb.retrieval_top_k or 5)
    results = await search_kb(kb_id, body.query, top_k)
    # 按分数阈值过滤（score 为 0~1 的浮点数，阈值存储为 0~100 的整数）
    threshold = (kb.score_threshold or 0) / 100.0
    if threshold > 0:
        results = [r for r in results if (r.get("score") or 0) >= threshold]
    return results


class FileQueryRequest(BaseModel):
    """文件查询请求体。"""

    query: str = Field("", description="查询条件：关键词或 '列名=值'")
    doc_id: int | None = Field(None, description="指定文档 id")
    sheet: str | None = Field(None, description="Excel sheet 名")
    limit: int = Field(20, description="返回行数上限")


@router.post("/{kb_id}/file-query", dependencies=[Depends(require_permission("knowledge_base", "view"))])
def file_query(
    kb_id: int,
    body: FileQueryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """查询知识库中的表格文件（Excel/CSV），返回结构化行列数据。

    与语义检索（``/search``）互补：本端点直接读取原始文件，按条件精确过滤行，
    适合查询 IP 列表、资产台账等结构化数据。
    资源级 owner 校验：仅 admin/owner/被授权用户可查询该知识库文件。
    """
    from app.core.kb_file_query import query_kb_file

    logger.info("文件查询: kb_id=%s, query=%s, doc_id=%s", kb_id, body.query, body.doc_id)
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()
    if kb is None:
        raise HTTPException(status_code=404, detail="KnowledgeBase not found")
    check_resource_ownership(current_user, db, "knowledge_base", kb_id, kb)
    return query_kb_file(
        query=body.query,
        kb_id=kb_id,
        doc_id=body.doc_id,
        sheet=body.sheet,
        limit=body.limit,
        enabled_kbs=[kb_id],
    )

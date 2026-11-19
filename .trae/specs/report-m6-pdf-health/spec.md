# M6：报告 PDF 保真预览与配置健康检查

## 1. 目标与范围

在已完成的 M0~M5 报告中心基础上补齐 M6 的两项能力：

1. **PDF 保真预览**：将已生成的 docx（配置预览 / 运行产物 / 审核产物）通过 LibreOffice headless 转为 PDF，在浏览器内联预览并支持下载。
2. **配置健康检查**：只读检查模板版本、占位符绑定、数据源、cron、表格列映射、最近运行与 PDF 能力，输出分级结论；可选「样例探针」实际采集一次并校验映射命中。

不在本次范围：运行看板、失败告警（M6 其余项）。

### 约束

- 不改变现有 docx 渲染与运行主流程；PDF 为按需生成并缓存。
- 环境未安装 LibreOffice 时明确返回 `PDF_UNAVAILABLE`，前端展示安装提示，不静默失败。
- 健康检查默认只读、不发起外部请求；只有 `probe` 端点会采集样例，且需要 `report:execute` 权限。
- 不新增数据表/字段（`report_artifacts.pdf_path` 已存在）。

---

## 2. 后端改动

### 2.1 新增 `backend/app/report/pdf.py`

职责：docx → PDF 转换封装与能力探测。

- `find_soffice() -> str | None`
  - 优先 `REPORT_SOFFICE_BIN` 环境变量；
  - 其次 `shutil.which("soffice")` / `shutil.which("libreoffice")`；
  - 最后探测 Windows 默认安装路径
    `C:\Program Files\LibreOffice\program\soffice.exe`、
    `C:\Program Files (x86)\LibreOffice\program\soffice.exe`。
- `is_available() -> bool`
- `capability() -> dict`：`{available, binary, engine: "libreoffice"|"", hint}`；
  `hint` 固定为安装说明（`apt-get install libreoffice-writer fonts-noto-cjk` 或设置 `REPORT_SOFFICE_BIN`）。
- `docx_to_pdf(docx: bytes, *, timeout: int = 120) -> bytes`
  - 无 soffice → `ReportError(PDF_UNAVAILABLE, "当前环境未安装 LibreOffice，无法生成 PDF 预览", {"hint": ...})`；
  - 临时目录写 `source.docx`，使用唯一 `-env:UserInstallation=file://<tmp>/profile`；
  - 命令：`<soffice> --headless --norestore -env:UserInstallation=... --convert-to pdf --outdir <tmp> <source.docx>`；
  - 超时/非零退出/缺少 PDF → `ReportError(PDF_UNAVAILABLE, ...)`，`detail` 带 stderr 尾部 500 字符；
  - 成功返回 PDF 字节。

### 2.2 `backend/app/report/errors.py`

新增常量：`PDF_UNAVAILABLE = "PDF_UNAVAILABLE"`。

### 2.3 `backend/app/main.py`

`_REPORT_ERROR_STATUS` 增加：`"PDF_UNAVAILABLE": 503`。

### 2.4 `backend/app/report/service.py`

新增导入：`from app.report import pdf as pdf_export`。

- `preview_pdf_bytes(preview_id: str) -> bytes`
  - `preview_id` 必须匹配 `[0-9a-f]{32}`，否则 `ARTIFACT_NOT_FOUND`；
  - 若 `report_previews/{preview_id}.pdf` 已存在则直接读取（缓存）；
  - 否则读取 `report_previews/{preview_id}.docx`（不存在 → `ARTIFACT_NOT_FOUND`），调用 `pdf_export.docx_to_pdf`，用 `_write_file` 落盘后返回。
- `artifact_pdf_bytes(db: Session, artifact: ReportArtifact) -> bytes`
  - `artifact.pdf_path` 存在且文件存在 → 直接读取；
  - 否则读取 docx（`load_artifact_bytes`），转换后写入
    `os.path.splitext(artifact.file_path)[0] + ".pdf"`，更新 `artifact.pdf_path` 并 `db.commit()`；
  - 返回 PDF 字节。
- `async def config_health(db, config_id, *, version_id=None, params=None, probe=False) -> dict`
  - 返回结构：
    ```json
    {
      "config_id": 1, "config_name": "月度安全报告-生产", "config_status": "published",
      "version_id": 3, "version_no": 2, "version_status": "published",
      "checked_at": "2026-11-16T12:00:00+08:00",
      "level": "ok|warning|error", "ok": true,
      "summary": {"pass": 8, "info": 2, "warning": 0, "error": 0},
      "checks": [
        {"key": "required_bindings", "title": "必填占位符绑定", "status": "pass|info|warning|error",
         "message": "...", "details": {}}
      ],
      "probe": {"sources": {}, "issues": [], "context_keys": [], "lineage": []}
    }
    ```
  - `status` 语义：`pass`/`info` 不影响结论；`warning` 使 `level=warning`；`error` 使 `level=error` 且 `ok=false`。
  - 检查项（顺序固定）：
    1. `config_status`：published→pass；draft→warning「配置尚未发布」；disabled→warning「配置已停用，不会参与运行」。
    2. `schedule_cron`：空→info「未配置定时，仅支持手动/API 触发」；合法→pass；非法→error（直接用 `croniter.is_valid`，不抛异常）。
    3. `config_version`：无可用版本→error 并**直接返回**只有该检查项的结果；草稿→warning；已发布→pass。
    4. `template_version`：所选模板版本 `status == "published"`→pass，否则 error。
    5. `data_sources`：`validate_data_sources` 无问题→pass；有问题→error（`details.issues`）。
    6. `mapping_schema`：`validate_mapping(mapping, placeholders, require_complete=False)` 无问题→pass；否则 error。
    7. `required_bindings`：统计必填占位符中未绑定 token/id → error（`details.tokens`），否则 pass。
    8. `binding_sources`：绑定引用的 `source_key` 不在数据源集合中 → warning（`details.items`），否则 pass。
    9. `table_columns`：表格绑定的 `columns` 相对 manifest 列 key 缺失 → warning；多出 → info；否则 pass。
    10. `last_run`：最近一次运行 succeeded→pass；partial→warning；failed→warning（带 error_code/message）；无记录→info。
    11. `pdf_export`：`pdf_export.capability()` 可用→pass；不可用→warning（`details.hint`）。
  - `probe=True` 时追加：
    12. `sample_collection`：调用 `collect_and_build(data_sources, bindings, params, cross_checks=...)`；所有 source ok→pass，否则 error（`details.sources`）。
    13. `mapping_hits`：采集结果 `issues` 中存在 error→error（`details.issues`）；否则 pass。
    - 同时把 `sources` / `issues` / `context` 的 key 列表 / `lineage` 写入返回的 `probe`。
    - 采集异常捕获 `ReportError` 与其他异常，转为 error 检查项，不向 API 抛出。

### 2.5 `backend/app/api/v1/reports.py`

- 新增 `_pdf_response(content: bytes, filename: str)`：`StreamingResponse`，`media_type="application/pdf"`，`Content-Disposition: inline; filename*=UTF-8''...`。
- 新增端点（全部沿用现有 `require_permission`）：
  - `GET /reports/pdf/capability`（view）→ `service.pdf_export.capability()`。
  - `GET /reports/configs/{config_id}/previews/{preview_id}/pdf`（view，先 `service.get_config`）→ `_pdf_response(service.preview_pdf_bytes(preview_id), "preview.pdf")`。
  - `GET /reports/runs/{run_id}/pdf`（view）→ 运行无 `artifact_id` 时抛 `ARTIFACT_NOT_FOUND`；否则 `service.artifact_pdf_bytes(db, artifact)`，文件名 `os.path.splitext(artifact.file_name)[0] + ".pdf"`。
  - `GET /reports/artifacts/{artifact_id}/pdf`（view）→ 同上，文件名 `os.path.splitext(artifact.file_name)[0] + ".pdf"`。
  - `GET /reports/configs/{config_id}/health`（view，query `version_id`）→ `await service.config_health(db, config_id, version_id=version_id, probe=False)`。
  - `POST /reports/configs/{config_id}/health/probe`（execute，body `{version_id, params}`）→ `await service.config_health(..., params=body.get("params") or {}, probe=True)`。

### 2.6 `backend/Dockerfile`

在 apt 安装块增加 `libreoffice-writer` 与 `fonts-noto-cjk`（用于 headless 转 PDF 与中文字体一致性），并加注释说明镜像体积影响与 `REPORT_SOFFICE_BIN` 可覆盖路径。开发容器不重建时自动降级为 `PDF_UNAVAILABLE`。

### 2.7 测试 `backend/tests/test_report_service.py`

新增：

1. `test_config_health_ok_and_missing_binding(env)`
   - 已发布模板/配置 → `asyncio.run(service.config_health(db, config.id))`：
     `ok is True`、`summary["error"] == 0`，`required_bindings` 为 pass。
   - 新建配置保存草稿（缺少必填 `summary.total_alert` 绑定）→ 健康检查 `ok is False`，存在 `key == "required_bindings"` 且 `status == "error"`。
2. `test_config_health_probe_static(env)`
   - 已发布配置静态数据源，`probe=True`：`probe` 字段存在、`sample_collection` 为 pass；把绑定 path 改为 `$.missing` 的草稿版本探针 → `mapping_hits` 为 error。
3. `test_preview_pdf_cache_and_unavailable(env, monkeypatch)`
   - monkeypatch `service.pdf_export.docx_to_pdf` 返回 `b"%PDF-1.4 test"` 并计数；先 `asyncio.run(service.preview_config(...))` 生成 docx，连续两次 `preview_pdf_bytes` → 内容一致且转换仅调用 1 次。
   - monkeypatch 转换函数抛 `ReportError(PDF_UNAVAILABLE, ...)`，新 preview id → 断言 `exc.code == PDF_UNAVAILABLE`。

---

## 3. 前端改动

### 3.1 `frontend/src/api/reports.js`

- 新增 `_fetchBlob(path)`：带 `Authorization` 头，非 2xx 时解析 `{detail, code}`，抛出带 `err.code` 的错误。
- 新增：
  - `reportApi.pdf.capability()`
  - `reportApi.configs.health(id, versionId)` → `GET /reports/configs/{id}/health`
  - `reportApi.configs.healthProbe(id, versionId, params)` → `POST .../health/probe`
  - `reportApi.configs.previewPdf(id, previewId)` → blob
  - `reportApi.runs.pdf(id)` → blob
  - `reportApi.artifacts.pdf(id)` → blob

### 3.2 `frontend/src/pages/reports/shared.jsx`

新增 `PdfPreviewPanel`（通用）：

- props：`{ load, filename, onError }`；内部状态 `{url, loading, error}`。
- 点击「加载 PDF」→ `const blob = await load()` → `URL.createObjectURL(blob)` → `<iframe src={url} className="h-[70vh] w-full">`。
- `useEffect` 卸载时 `URL.revokeObjectURL`。
- 错误：若 `err.code === 'PDF_UNAVAILABLE'`，展示黄色提示（安装 LibreOffice 或设置 `REPORT_SOFFICE_BIN`）；否则红色错误。
- 提供「下载 PDF」按钮（blob 下载，文件名由 `filename` 决定）。

### 3.3 `frontend/src/pages/reports/ReportConfigEditor.jsx`

- 父组件新增状态：`health`、`healthLoading`、`healthProbe`（默认 false）。
- `runHealth(probe)`：调用 `configs.health` 或 `configs.healthProbe`（带上 `versionId` 与 `sampleParams`），错误 toast。
- Step 4「预览与发布」：
  - 预览成功后的操作行增加「预览 PDF」，展开 `PdfPreviewPanel`（`load = () => reportApi.configs.previewPdf(config.id, preview.preview_id)`，`filename="preview.pdf"`）。
  - 新增「配置健康检查」卡片：
    - 按钮「运行健康检查」（只读）与「样例探针」（需 `report:execute`，复用 `sampleParams`）。
    - 结果：`level` 徽章（ok=success / warning / error）、`summary` 计数、检查项列表（status 颜色：pass=success、info=neutral、warning=warning、error=danger，展示 title + message，`details.issues/tokens/items` 折叠为 JSON）。
    - 探针结果展示数据源状态与 issues。

### 3.4 `frontend/src/pages/reports/ReportRuns.jsx`

- 运行详情 footer 当 `detail.artifact` 存在时增加「预览 PDF」按钮，打开 `Modal size="xl"`，内容 `PdfPreviewPanel`（`load = () => reportApi.runs.pdf(run.id)`，`filename` 由 artifact.file_name 改 `.pdf`）。

### 3.5 `frontend/src/pages/reports/ReportAudits.jsx`

- 产物操作列增加「PDF 预览」按钮，打开 Modal + `PdfPreviewPanel`（`load = () => reportApi.artifacts.pdf(row.id)`），保留原有 docx 下载。

---

## 4. 验收与验证

### 后端

```powershell
docker cp backend/app/report/pdf.py soar-backend-dev:/app/app/report/pdf.py
docker cp backend/app/report/service.py soar-backend-dev:/app/app/report/service.py
docker cp backend/app/report/errors.py soar-backend-dev:/app/app/report/errors.py
docker cp backend/app/api/v1/reports.py soar-backend-dev:/app/app/api/v1/reports.py
docker cp backend/app/main.py soar-backend-dev:/app/app/main.py
docker cp backend/tests/test_report_service.py soar-backend-dev:/app/tests/test_report_service.py
docker restart soar-backend-dev
docker exec -e PYTHONPATH=/app -w /app soar-backend-dev python -m pytest tests/test_report_service.py -q
```

- 期望全部通过（现有 8 个 + 新增 3 个）。
- `GET /reports/pdf/capability` 在未装 LibreOffice 的开发容器返回 `available: false` 与安装提示。

### 前端

```powershell
npm run build   # 工作目录 frontend
```

### 手工核对

1. 配置向导第 4 步能运行健康检查，草稿配置出现 `required_bindings` 错误；发布后为 ok。
2. 生成预览后点击「预览 PDF」：装 LibreOffice 的环境内联显示；未装时显示黄色安装提示。
3. 运行详情与产物审核页可内联预览 PDF，原 docx 下载不受影响。

---

## 5. 风险与说明

- **镜像体积**：`libreoffice-writer` + 中文字体会显著增大后端镜像；仅生产/Docker 构建生效，开发容器需重建或手动安装后才可用 PDF。
- **转换耗时**：首次转换通常数秒；PDF 按 preview/artifact 缓存，避免重复转换。
- **字体差异**：Dockerfile 安装 `fonts-noto-cjk`，但模板专用字体仍需按需补充，否则 PDF 分页可能与 Word 有差异。
- **健康检查不落库**：结果实时计算，不做历史留存；后续告警（M6 其余）再考虑定时快照。

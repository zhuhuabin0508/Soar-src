# M6 任务清单：PDF 保真预览与配置健康检查

## 后端

- [x] T1 新增 `backend/app/report/pdf.py`（soffice 探测、`capability`、`docx_to_pdf`）
- [x] T2 `errors.py` 增加 `PDF_UNAVAILABLE`；`main.py` 映射为 503
- [x] T3 `service.py` 增加 `preview_pdf_bytes`、`artifact_pdf_bytes`（PDF 缓存）
- [x] T4 `service.py` 增加 `config_health`（11 项静态检查 + probe 采集/映射命中）
- [x] T5 `api/v1/reports.py` 增加 PDF capability / 预览 / 运行 / 产物 4 个 PDF 端点与 2 个健康检查端点
- [x] T6 `backend/Dockerfile` 安装 `libreoffice-writer`、`fonts-noto-cjk`
- [x] T7 `tests/test_report_service.py` 增加 3 个测试（健康检查、探针、PDF 缓存与不可用）
- [x] T8 复制代码到 `soar-backend-dev` 并运行报告测试，全部通过（11 passed）

## 前端

- [x] T9 `api/reports.js` 增加 `_fetchBlob` 与 PDF/健康检查 API
- [x] T10 `shared.jsx` 增加通用 `PdfPreviewPanel`（内联 iframe + 下载 + PDF 不可用提示）
- [x] T11 `ReportConfigEditor.jsx` 第 4 步接入 PDF 预览与健康检查面板（含探针）
- [x] T12 `ReportRuns.jsx` 运行详情增加 PDF 预览弹窗
- [x] T13 `ReportAudits.jsx` 产物列表增加 PDF 预览弹窗
- [x] T14 `npm run build` 通过

## 验证

- [x] backend pytest 全绿（11 passed）
- [x] `GET /reports/pdf/capability` 在开发容器返回 `available: false` + hint
- [x] 前端构建通过；健康检查与 PDF 降级提示已接入

"""报告中心核心库：模板解析、渲染、采集、抽取与校验。"""

from app.report.collector import (  # noqa: F401
    SourceResult,
    collect_and_build,
    collect_sources,
    default_fetchers,
)
from app.report.errors import ReportError  # noqa: F401
from app.report.manifest import (  # noqa: F401
    diff_manifests,
    extract_manifest,
    validate_docx_upload,
)
from app.report.renderer import (  # noqa: F401
    check_rendered_docx,
    render_report,
)
from app.report.spec import (  # noqa: F401
    validate_data_sources,
    validate_mapping,
    validate_template_spec,
)
from app.report.transform import (  # noqa: F401
    apply_transforms,
    build_data_context,
    extract_jsonpath,
    run_cross_checks,
)

__all__ = [
    "ReportError",
    "SourceResult",
    "apply_transforms",
    "build_data_context",
    "check_rendered_docx",
    "collect_and_build",
    "collect_sources",
    "default_fetchers",
    "diff_manifests",
    "extract_jsonpath",
    "extract_manifest",
    "render_report",
    "run_cross_checks",
    "validate_data_sources",
    "validate_docx_upload",
    "validate_mapping",
    "validate_template_spec",
]

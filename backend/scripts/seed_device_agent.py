"""设备运营助手智能体播种脚本：意图驱动的设备 API 调用 + clarify 澄清。

用法（容器内，backend 目录）:
    docker exec -w /app -e PYTHONPATH=/app soar-backend-dev python /tmp/seed_device_agent.py

逻辑:
  1. 先调用 ensure_preset_tools 同步工具目录（确保 execute_device_action 已入库）。
  2. 创建/更新 Agent(name=设备运营助手)，enabled_tools 绑定
     query_device_actions / execute_device_action / clarify。
  3. model_config_id 取第一个可用 LLMConfig；无则留空（需后在平台 UI 配置）。

工作流（system_prompt 亦按此约定）:
  意图不明 → query_device_actions 发现设备/动作 → clarify 让用户选择/确认
  → execute_device_action 执行（处置类必须先确认）。
"""
import json
import logging

from sqlalchemy.orm import Session

from app.core.tools.seed_service import ensure_preset_tools
from app.database import SessionLocal
from app.models.agent import Agent
from app.models.llm_config import LLMConfig

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("seed_device_agent")

_AGENT_NAME = "设备运营助手"

_DEVICE_AGENT_TOOLS = [
    "query_device_actions",
    "execute_device_action",
    "export_device_action_to_excel",
    "clarify",
]

_SYSTEM_PROMPT = """你是设备运营助手，负责根据用户意图调用平台对接设备（如青藤万相主机安全平台等）的 API。严格按以下流程工作：

【第一步：发现】接到设备相关请求后，先调用 query_device_actions 了解可用设备与动作：
- 不确定有哪些设备时，先不传 device_id 获取设备摘要列表；
- 根据用户意图用 keyword 过滤候选动作（如 keyword=主机、弱密码、进程、资产），必要时 full=true 获取完整参数定义。

【第二步：澄清】出现以下任一情况，必须调用 clarify 工具向用户提问，不得擅自猜测：
- 多个设备都可能满足请求（如多台设备都能查主机信息）：让用户选择设备；
- 多个候选动作含义接近：让用户选择动作；
- 动作存在必填参数但用户未提供（如 IP、主机名、时间范围）：向用户询问参数值；
- 用户要求的动作属于处置类或中高风险（risk_level 为 medium/high，如封禁 IP、隔离主机、删除数据、变更配置）：描述将执行的动作、目标与影响，请用户确认。
clarify 的 choices 最多 4 个选项，选项文本应清晰（含设备名/动作名）；用户回答后按其选择继续。

【第三步：执行】调用 execute_device_action，传入确定的 action_id 与完整参数：
- 查询类动作（只读、risk_level=low）确认参数齐全后直接执行；
- 处置类动作必须在用户明确确认后才能执行；
- 结果用中文汇总：成功时提炼关键数据（数量、列表摘要），失败时说明错误原因与建议（如设备凭据未配置、网络不通）。

【数据统计与报告规范】
1. 口径区分：查询结果通常「一行 = 一个数据库实例」。汇报必须同时给出三个数字：实例数（结果总行数）、主机数（按连接 IP 或主机名去重）、唯一连接 IP 数；不得用实例数冒充主机数，标题与正文口径保持一致。
2. 数据库类型：按 version / version_comment 识别产品，含 MariaDB 的实例不得计入 MySQL，版本分布中 MySQL 与 MariaDB 分列统计。版本统计统一到「主.次」粒度（如 8.0、5.7、10.3），完整版本号只在明细中保留，不得同一张表混用两种粒度。
3. 业务归属：优先采用 bizGroup 字段；hostTagList 仅作补充参考。两者冲突时以 bizGroup 为准，并在报告中说明冲突实例数量，避免同一实例出现两个业务组。
4. 端口与监听：端口统计必须写明具体端口及对应实例数（如 3306=24、17306=5），不得用「3306 等标准端口」之类模糊表述；监听地址为 0.0.0.0 或 :: 的实例必须单独列出。
5. 数据质量：明细必须包含可唯一标识实例的字段组合（连接 IP + 端口，或平台实例 ID）；主机名重复（如多个 localhost.localdomain）需在报告中标明，不得把主机名当作唯一键；重复记录、非常规端口、关键字段为空等异常单独成段说明。
6. 风险与建议：必须列出已停止维护（EOL）的版本、任意地址监听、非默认端口等风险，并给出可执行建议（如升级到受支持版本、限制绑定地址、补充业务组归属）；只报数量不报风险视为不合格。
7. 覆盖范围：多平台或多动作查询（如 Linux 动作与 Windows 动作）必须分别说明各动作命中数量，结果为 0 的也要明示「未发现」，不得只报合并后的数字；报告中注明数据来源动作名称与查询条件。
8. 时间口径：注明查询执行时间（北京时间）与数据为实时快照，避免读者误读为历史统计。
9. 呈现规范：回复标题只出现一次、不使用 emoji；正文摘要与交付文档的工作表名、表头命名保持一致；展示示例明细时须按明确规则选取（如按风险等级或版本排序取前 N 条）并注明选取规则。

【执行效率】
1. 每次调用工具前只用一句话说明目的，不要复述上一轮已给出的相同分析和结论；
2. 同一动作、相同参数只调用一次；需要更大范围时改动参数，禁止原样重复调用；query_device_actions 只在需要查动作定义时调用，full=true 全量定义最多取一次；
3. 用户需要「完整明细/全部数据」的 Excel 时，直接用 export_device_action_to_excel 一步导出（服务端分页拉全量），禁止用 execute_device_action 逐页取数再拼文档；多平台时每台设备各导出一次或分次导出；
4. 需要在对话中分析数据时才用 execute_device_action 取样（分页固定 size=40）；当返回 pagination.restart_page / restart_size 时，说明单条响应被裁剪、原 next_page 会漏行，必须按 restart_page / restart_size 从头重新取数；只有出现 next_page 时才按它翻页，不要用其它 size 反复试探；
5. 非设备数据生成文档（报告、总结类）：generate_document 只写「标题 + 表头 + 首批 ≤50 行」，行数多时用 append_document(file_id, content) 分批追加（每批 ≤50 行）；延续表格时追加内容直接以 | 数据行 | 开头，不要重复表头。严禁因数据量大传空 content 或只给示例；
6. 用户未明确要求完整明细且超过约 50 条时，交付文档可只放「统计汇总 + 按明确规则选取的前 50 条示例明细」；
7. 最终回答只输出结论与关键数据（示例明细不超过 10 条），完整明细写入交付文档，不在对话中罗列全部原始记录；
8. 数据不足以支撑结论时，直接说明缺少什么并给出下一步建议，不要重复重试同一查询。

【纪律】
- 严禁编造 action_id 或参数名，一切以 query_device_actions 返回为准；
- 执行前核对动作归属，确认动作来自用户指定或选择的设备；
- 不执行用户意图之外的任何动作；
- 设备返回错误时如实转述，不虚构结果。"""


def _first_llm_config(db: Session):
    return db.query(LLMConfig).order_by(LLMConfig.id.asc()).first()


def _upsert_agent(db: Session) -> None:
    llm_cfg = _first_llm_config(db)
    agent = db.query(Agent).filter(Agent.name == _AGENT_NAME).first()
    data = dict(
        description=(
            "设备运营助手：根据用户意图调用设备对接 API 查询/处置。"
            "自动发现设备与动作，目标不明确时弹出选项让用户选择，"
            "处置类动作执行前向用户确认。"
        ),
        model_config_id=llm_cfg.id if llm_cfg else None,
        system_prompt=_SYSTEM_PROMPT,
        enabled_tools=_DEVICE_AGENT_TOOLS,
        enabled_skills=[],
        enabled_kbs=[],
        enabled_asset_types=[],
        engine="hermes",
        temperature=0.2,
        # 4096 对“长表格 + 长工具参数”偏小，容易在输出中途被 max_tokens 截断
        max_tokens=8192,
        # 设备取数需「发现→澄清→分页取数→生成文档」多轮，8 轮易在生成文档前耗尽
        max_iterations=16,
        enable_memory=False,
        tone_style="professional",
    )
    if agent is None:
        agent = Agent(name=_AGENT_NAME, **data)
        db.add(agent)
        logger.info("Agent 已创建: name=%s", _AGENT_NAME)
        return
    for k, v in data.items():
        # 已绑定模型的智能体不覆盖模型选择：播种脚本不应改变运维在平台上
        # 选定的模型（首条 LLMConfig 未必可用，覆盖会导致 model_not_found）。
        if k == "model_config_id" and agent.model_config_id:
            continue
        setattr(agent, k, v)
    logger.info("Agent 已更新: name=%s", _AGENT_NAME)


def _sync_device_tool_descriptions(db: Session) -> None:
    """同步设备工具的 description（预置工具同步只修复代码/分类，不会更新描述）。

    工具描述直接决定模型是否按分页取数、是否重复调用，必须与代码保持一致。
    """
    from app.core.tools.definitions import device_query
    from app.models.tool import Tool

    for defn in device_query.DEVICE_QUERY_TOOLS:
        tool = db.query(Tool).filter(Tool.name == defn["name"]).first()
        if tool is not None and tool.description != defn["description"]:
            tool.description = defn["description"]
            logger.info("工具描述已同步: %s", defn["name"])


def _sync_document_tools(db: Session) -> None:
    """同步文档生成/追加工具的 code / description / 参数 schema 到 DB。

    code 型工具执行的是 DB 中存储的 code（ensure_preset_tools 只插入新工具、
    不更新已存在的），代码或描述变更后必须在这里同步，否则改动不生效。
    """
    from app.core.tools.definitions.builtin import HERMES_BUILTIN_TOOLS
    from app.models.tool import Tool

    wanted = {"generate_document", "append_document"}
    for defn in HERMES_BUILTIN_TOOLS:
        if defn.get("name") not in wanted:
            continue
        tool = db.query(Tool).filter(Tool.name == defn["name"]).first()
        if tool is None:
            logger.info("文档工具不存在（将随预置工具播种创建）: %s", defn["name"])
            continue
        changed = False
        if tool.description != defn["description"]:
            tool.description = defn["description"]
            changed = True
        if tool.code != defn["code"]:
            tool.code = defn["code"]
            changed = True
        # parameters_schema 是 JSON 列：必须直接赋 list，json.dumps 会双重编码，
        # 读回 str 后 _build_args_model 迭代出错（'str' object has no attribute 'get'）
        schema = defn["parameters_schema"]
        current = tool.parameters_schema
        if isinstance(current, str):
            # 双重编码的历史值：即使解析后内容一致也必须重写为 list
            tool.parameters_schema = schema
            changed = True
        elif current != schema:
            tool.parameters_schema = schema
            changed = True
        if changed:
            logger.info("文档工具已同步: %s", defn["name"])


def main() -> None:
    # 先同步工具目录，确保 execute_device_action 新工具已入库
    ensure_preset_tools()
    db: Session = SessionLocal()
    try:
        _sync_device_tool_descriptions(db)
        _sync_document_tools(db)
        _upsert_agent(db)
        db.commit()
        logger.info("播种完成: 智能体=%s, 工具=%s", _AGENT_NAME, _DEVICE_AGENT_TOOLS)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("播种失败: %s", exc)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()

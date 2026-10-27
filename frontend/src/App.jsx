import { createBrowserRouter, RouterProvider, Navigate, Outlet } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import AppShell, { getFirstPermittedPath } from './components/AppShell'
import { hasPermission } from './utils/permissions'
import { toast } from './store/toastStore'
import { GlobalLoadingProvider } from './components/GlobalLoading'
import ToastContainer from './components/ToastContainer'
import { ConfirmDialogHost } from './components/ConfirmDialog'
import { ErrorBoundary, RouteErrorFallback } from './components/ErrorBoundary'
import { useHotkeys } from './hooks/useHotkeys'
import Login from './pages/Login'
import { useAuthStore } from './store/authStore'
import WorkflowEditor from './pages/WorkflowEditor'
import WorkflowQuickCreate from './pages/WorkflowQuickCreate'
import WorkflowMonitor from './pages/WorkflowMonitor'
import Studio from './pages/Studio'
import AgentWorkspace from './pages/AgentWorkspace'
import AgentEditor from './pages/AgentEditor'
import ToolList from './pages/ToolList'
import ToolEditor from './pages/ToolEditor'
import KnowledgeBase from './pages/KnowledgeBase'
import SkillList from './pages/SkillList'
import LLMConfig from './pages/LLMConfig'
import DeviceManagement from './pages/devices/DeviceManagement'
import DeviceOnboard from './pages/devices/DeviceOnboard'
import AgentMonitor from './pages/AgentMonitor'
import ApprovalCenter from './pages/ApprovalCenter'
import ExecutionDetail from './pages/ExecutionDetail'
import LogCenter from './pages/LogCenter'
import Dashboard from './pages/Dashboard'
import BigScreen from './pages/BigScreen'
import BigScreen2 from './pages/BigScreen2'
import ChatPage from './pages/ChatPage'
import UserManagement from './pages/UserManagement'
import RoleManagement from './pages/RoleManagement'
import SystemSettings from './pages/SystemSettings'
import SystemMonitor from './pages/SystemMonitor'
import AuditLogs from './pages/audit/AuditLogs'
import NotificationCenter from './pages/NotificationCenter'
import BackupManagement from './pages/BackupManagement'
import Assets from './pages/Assets'
import AssetOverview from './pages/AssetOverview'
import AssetList from './pages/AssetList'
import AssetTemplates from './pages/AssetTemplates'
import Profile from './pages/Profile'
import AgentTutorial from './pages/AgentTutorial'
import About from './pages/About'
import MyFeedback from './pages/MyFeedback'
import FeedbackAdmin from './pages/FeedbackAdmin'
import DeliverableManagement from './pages/DeliverableManagement'
import GovCloudAssets from './pages/GovCloudAssets'
import DutyMemberManagement from './pages/DutyMemberManagement'
import DutySchedule from './pages/DutySchedule'
import DutyScheduleGraph from './pages/DutyScheduleGraph'
import DutyLeave from './pages/DutyLeave'
import DutyAdjustmentLogs from './pages/DutyAdjustmentLogs'
import StrategyList from './pages/StrategyList'
import StrategyEdit from './pages/StrategyEdit'
import ReceiverList from './pages/logcollect/ReceiverList'
import SourceEntryList from './pages/logcollect/SourceEntryList'
import SourceEntryDetail from './pages/logcollect/SourceEntryDetail'
import AlertList from './pages/AlertList'
import AlertRules from './pages/AlertRules'
import AlertRuleEditPage from './pages/AlertRuleEditPage'
import IngestionMonitor from './pages/IngestionMonitor'
import LineageView from './pages/LineageView'
import BanTriggerRules from './pages/ban/BanTriggerRules'
import TicketCenter from './pages/TicketCenter'
import TicketDetail from './pages/TicketDetail'
import TicketGroupManage from './pages/TicketGroupManage'
import TicketFlowList from './pages/TicketFlowList'
import TicketSlaConfig from './pages/TicketSlaConfig'
import TicketFlowEdit from './pages/TicketFlowEdit'
import TicketMonitorScreen from './pages/TicketMonitorScreen'

// 路由守卫：未登录跳转 /login
// 作为布局路由使用：通过则渲染 <Outlet />（子路由），否则跳转登录页。
function ProtectedRoute() {
  const token = useAuthStore((s) => s.token)
  if (!token) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}

// 权限感知首页：按导航菜单顺序重定向到当前用户第一个有权限访问的页面。
// 替代原先固定跳 /dashboard（无大屏权限的账户不应落到运营大屏）。
function HomeRedirect() {
  return <Navigate to={getFirstPermittedPath()} replace />
}

// 页面级权限守卫：无权限时 toast 提示并回首页（再由 HomeRedirect 落到有权限的页面）。
// 菜单已隐藏对应入口，此处防止直接输入 URL 或页面内跨模块链接绕过。
// perm: [module, action] 单一要求；permAny: [[module, action], ...] 任一满足即放行。
function RequirePermission({ perm, permAny, label, children }) {
  const notifiedRef = useRef(false)
  const allowed = perm
    ? hasPermission(perm[0], perm[1])
    : (permAny || []).some(([m, a]) => hasPermission(m, a))
  useEffect(() => {
    if (!allowed && !notifiedRef.current) {
      notifiedRef.current = true
      toast.error(`权限不足：没有「${label || '该功能'}」访问权限，请联系管理员在角色管理中授权`)
    }
  }, [allowed, label])
  if (!allowed) {
    return <Navigate to="/" replace />
  }
  return children
}

// 使用 createBrowserRouter 创建 data router。
// ⚠️ useBlocker / useFetcher 等 hook 必须在 data router 上下文中使用，
// 旧的 <BrowserRouter> 不提供 data router 上下文，会导致编辑页面的
// useUnsavedChanges（内部用 useBlocker）报错：
//   "useBlocker must be used within a data router"
// 改用 createBrowserRouter + RouterProvider 后，所有 data router hook 均可用。
const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
    errorElement: <RouteErrorFallback />,
  },
  {
    element: <ProtectedRoute />,
    errorElement: <RouteErrorFallback />,
    children: [
      // 工单监控大屏：独立全屏路由（不嵌 AppShell 侧边栏，供投屏使用）
      { path: '/ticket-monitor', element: <RequirePermission perm={['ticket_monitor', 'view']} label="工单监控大屏"><TicketMonitorScreen /></RequirePermission> },
      {
        element: <AppShell />,
        errorElement: <RouteErrorFallback />,
        children: [
          { path: '/', element: <HomeRedirect /> },
          { path: '/chat', element: <RequirePermission perm={['chat', 'view']} label="对话"><ChatPage /></RequirePermission> },
          { path: '/studio', element: <RequirePermission permAny={[['agent', 'view'], ['workflow_list', 'view'], ['workflow_editor', 'view']]} label="应用"><Studio /></RequirePermission> },
          { path: '/editor', element: <RequirePermission perm={['workflow_editor', 'view']} label="工作流编排"><WorkflowEditor /></RequirePermission> },
          { path: '/workflows/new', element: <RequirePermission perm={['workflow_list', 'view']} label="工作流"><WorkflowQuickCreate /></RequirePermission> },
          { path: '/workflows', element: <Navigate to="/studio?tab=workflow" replace /> },
          { path: '/workflows/:id/monitor', element: <RequirePermission perm={['workflow_list', 'view']} label="工作流"><WorkflowMonitor /></RequirePermission> },
          { path: '/agents', element: <Navigate to="/studio?tab=agent" replace /> },
          { path: '/agents/quick', element: <Navigate to="/agents/new" replace /> },
          { path: '/agents/new', element: <RequirePermission perm={['agent', 'view']} label="智能体"><AgentWorkspace /></RequirePermission> },
          { path: '/agents/:id/edit', element: <RequirePermission perm={['agent', 'view']} label="智能体"><AgentWorkspace /></RequirePermission> },
          { path: '/agents/:id/advanced', element: <RequirePermission perm={['agent', 'view']} label="智能体"><AgentEditor /></RequirePermission> },
          { path: '/agents/:id/monitor', element: <RequirePermission perm={['agent', 'view']} label="智能体"><AgentMonitor /></RequirePermission> },
          { path: '/agent-tutorial', element: <AgentTutorial /> },
          { path: '/tools', element: <RequirePermission perm={['tool', 'view']} label="工具"><ToolList /></RequirePermission> },
          { path: '/tools/new', element: <RequirePermission perm={['tool', 'view']} label="工具"><ToolEditor /></RequirePermission> },
          { path: '/tools/:id/edit', element: <RequirePermission perm={['tool', 'view']} label="工具"><ToolEditor /></RequirePermission> },
          { path: '/knowledge-base', element: <RequirePermission perm={['knowledge_base', 'view']} label="知识库"><KnowledgeBase /></RequirePermission> },
          { path: '/skills', element: <RequirePermission perm={['skill', 'view']} label="技能库"><SkillList /></RequirePermission> },
          { path: '/llm-configs', element: <RequirePermission perm={['llm_config', 'view']} label="模型设置"><LLMConfig /></RequirePermission> },
          { path: '/devices', element: <RequirePermission perm={['device', 'view']} label="设备对接"><DeviceManagement /></RequirePermission> },
          { path: '/device-onboard', element: <RequirePermission perm={['device', 'view']} label="设备对接"><DeviceOnboard /></RequirePermission> },
          { path: '/approvals', element: <RequirePermission perm={['approval', 'view']} label="工作台"><ApprovalCenter /></RequirePermission> },
          { path: '/executions', element: <RequirePermission perm={['execution', 'view']} label="日志中心"><LogCenter /></RequirePermission> },
          { path: '/executions/:id', element: <RequirePermission perm={['execution', 'view']} label="日志中心"><ExecutionDetail /></RequirePermission> },
          { path: '/logs', element: <RequirePermission perm={['execution', 'view']} label="日志中心"><LogCenter /></RequirePermission> },
          { path: '/banned-ips', element: <HomeRedirect /> },
          { path: '/assets', element: <RequirePermission perm={['asset_overview', 'view']} label="资产总览"><AssetOverview /></RequirePermission> },
          { path: '/assets/list', element: <RequirePermission perm={['asset_list', 'view']} label="资产清单"><AssetList /></RequirePermission> },
          { path: '/assets/templates', element: <RequirePermission perm={['asset_templates', 'view']} label="类型模板"><AssetTemplates /></RequirePermission> },
          { path: '/assets/discovery', element: <RequirePermission perm={['asset_discovery', 'view']} label="资产发现"><GovCloudAssets /></RequirePermission> },
          { path: '/assets/legacy', element: <RequirePermission perm={['asset_list', 'view']} label="资产清单"><Assets /></RequirePermission> },
          // 大屏路由：菜单隐藏之外再加页面级守卫，无 view 权限时回首页
          { path: '/dashboard', element: <RequirePermission perm={['dashboard', 'view']} label="运营大屏"><Dashboard /></RequirePermission> },
          { path: '/bigscreen', element: <RequirePermission perm={['bigscreen', 'view']} label="盾立方W"><BigScreen /></RequirePermission> },
          { path: '/bigscreen2', element: <RequirePermission perm={['bigscreen2', 'view']} label="盾立方指挥大屏"><BigScreen2 /></RequirePermission> },
          // 系统配置
          { path: '/users', element: <RequirePermission perm={['user', 'view']} label="用户管理"><UserManagement /></RequirePermission> },
          { path: '/roles', element: <RequirePermission perm={['role', 'view']} label="角色管理"><RoleManagement /></RequirePermission> },
          { path: '/system-settings', element: <RequirePermission perm={['system_config', 'view']} label="系统设置"><SystemSettings /></RequirePermission> },
          { path: '/system-monitor', element: <RequirePermission perm={['system_monitor', 'view']} label="系统监控"><SystemMonitor /></RequirePermission> },
          { path: '/audit-logs', element: <RequirePermission perm={['audit_log', 'view']} label="审计日志"><AuditLogs /></RequirePermission> },
          { path: '/notifications', element: <RequirePermission perm={['notification', 'view']} label="通知中心"><NotificationCenter /></RequirePermission> },
          { path: '/backup', element: <RequirePermission perm={['system_config', 'view']} label="备份恢复"><BackupManagement /></RequirePermission> },
          { path: '/about', element: <RequirePermission perm={['system_config', 'view']} label="关于"><About /></RequirePermission> },
          // 个人中心
          { path: '/profile', element: <Profile /> },
          // 系统反馈
          { path: '/feedbacks/mine', element: <MyFeedback /> },
          { path: '/feedbacks/admin', element: <RequirePermission perm={['feedback', 'view']} label="反馈管理"><FeedbackAdmin /></RequirePermission> },
          { path: '/deliverables', element: <RequirePermission perm={['deliverable', 'view']} label="材料管理"><DeliverableManagement /></RequirePermission> },
          { path: '/govcloud', element: <Navigate to="/assets/discovery" replace /> },
          // 运营管理 - 值班
          { path: '/duty/members', element: <RequirePermission perm={['duty_member', 'view']} label="值班人员"><DutyMemberManagement /></RequirePermission> },
          { path: '/duty/schedule', element: <RequirePermission perm={['duty_schedule', 'view']} label="值班表"><DutySchedule /></RequirePermission> },
          { path: '/duty/schedule/graph', element: <RequirePermission perm={['duty_schedule', 'view']} label="值班表（图形化）"><DutyScheduleGraph /></RequirePermission> },
          { path: '/duty/leaves', element: <RequirePermission perm={['duty_leave', 'view']} label="请假管理"><DutyLeave /></RequirePermission> },
          { path: '/duty/logs', element: <RequirePermission perm={['duty_log', 'view']} label="调班记录"><DutyAdjustmentLogs /></RequirePermission> },
          // 运营管理 - 工单（工单中心 / 处理分组 / 流程模板）
          { path: '/tickets', element: <RequirePermission perm={['ticket', 'view']} label="工单中心"><TicketCenter /></RequirePermission> },
          { path: '/tickets/:id', element: <RequirePermission perm={['ticket', 'view']} label="工单中心"><TicketDetail /></RequirePermission> },
          { path: '/ticket-config/groups', element: <RequirePermission perm={['ticket_config', 'view']} label="工单配置"><TicketGroupManage /></RequirePermission> },
          { path: '/ticket-config/sla', element: <RequirePermission perm={['ticket_config', 'view']} label="工单配置"><TicketSlaConfig /></RequirePermission> },
          { path: '/ticket-config/flows', element: <RequirePermission perm={['ticket_config', 'view']} label="工单配置"><TicketFlowList /></RequirePermission> },
          { path: '/ticket-config/flows/new', element: <RequirePermission perm={['ticket_config', 'view']} label="工单配置"><TicketFlowEdit /></RequirePermission> },
          { path: '/ticket-config/flows/:id/edit', element: <RequirePermission perm={['ticket_config', 'view']} label="工单配置"><TicketFlowEdit /></RequirePermission> },
          // 连接配置 - 设备对接（设备列表 / 接收器 / 数据源条目 / 解析模板 / 告警列表 / 入库监控）
          { path: '/receivers', element: <RequirePermission perm={['device', 'view']} label="接收器"><ReceiverList /></RequirePermission> },
          { path: '/source-entries', element: <RequirePermission perm={['device', 'view']} label="数据源条目"><SourceEntryList /></RequirePermission> },
          { path: '/source-entries/:id', element: <RequirePermission perm={['device', 'view']} label="数据源条目"><SourceEntryDetail /></RequirePermission> },
          { path: '/strategies', element: <RequirePermission perm={['strategy', 'view']} label="解析模板"><StrategyList /></RequirePermission> },
          { path: '/strategies/new', element: <RequirePermission perm={['strategy', 'view']} label="解析模板"><StrategyEdit /></RequirePermission> },
          { path: '/strategies/:id/edit', element: <RequirePermission perm={['strategy', 'view']} label="解析模板"><StrategyEdit /></RequirePermission> },
          // 告警接入 - 告警列表 / 告警规则 / 解析入库监控
          { path: '/alerts', element: <RequirePermission perm={['alert', 'view']} label="告警列表"><AlertList /></RequirePermission> },
          { path: '/alert-rules', element: <RequirePermission perm={['alert', 'view']} label="告警规则"><AlertRules /></RequirePermission> },
          { path: '/alert-rules/new', element: <RequirePermission perm={['alert', 'view']} label="告警规则"><AlertRuleEditPage /></RequirePermission> },
          { path: '/alert-rules/:id/edit', element: <RequirePermission perm={['alert', 'view']} label="告警规则"><AlertRuleEditPage /></RequirePermission> },
          { path: '/ingest-monitor', element: <RequirePermission perm={['monitor', 'view']} label="入库监控"><IngestionMonitor /></RequirePermission> },
          { path: '/lineage', element: <RequirePermission perm={['device', 'view']} label="数据血缘"><LineageView /></RequirePermission> },
          // 告警自动封禁工作流：触发规则独立页面；审批/封禁/历史已合并进工作台 Tab
          { path: '/ban-workflow/instances', element: <Navigate to="/approvals?tab=all" replace /> },
          { path: '/ban-workflow/approvals', element: <Navigate to="/approvals" replace /> },
          { path: '/ban-workflow/banned', element: <Navigate to="/approvals?tab=banned" replace /> },
          { path: '/ban-workflow/rules', element: <RequirePermission perm={['ban_workflow', 'view']} label="封禁工作流"><BanTriggerRules /></RequirePermission> },
          // 兜底：未匹配的受保护路由重定向到当前用户有权限的第一个页面
          { path: '*', element: <HomeRedirect /> },
        ],
      },
    ],
  },
])

// 应用根组件：用 RouterProvider 挂载 data router，
// 外层包 GlobalLoadingProvider 提供全局加载态。
// ToastContainer / ConfirmDialogHost 为全局反馈层，挂载在路由外层。
// ErrorBoundary 包裹整个应用，捕获路由 errorElement 处理不到的同步异常。
function App() {
  return (
    <ErrorBoundary>
      <GlobalLoadingProvider>
        <RouterProvider router={router} />
        <ToastContainer />
        <ConfirmDialogHost />
      </GlobalLoadingProvider>
    </ErrorBoundary>
  )
}

// 顶层快捷键监听器:全局挂在 RouterProvider 外不可,需在 Router 内才能用 useNavigate
// 故单独组件,由路由树内的根路由(AppShell/ProtectedRoute)渲染
export function GlobalHotkeys() {
  useHotkeys()
  return null
}

export default App

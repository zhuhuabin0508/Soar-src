// 文件接收上传指导：密钥生成入口 + 对接步骤 + 接口地址
import { Copy, KeyRound, ShieldCheck, UploadCloud } from 'lucide-react'
import { Button } from '../../components/ui'
import { Drawer } from '../../components/Dialog'
import { toast } from '../../store/toastStore'

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请手动选择复制')
  }
}

function Step({ index, title, children }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
        {index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export default function FileReceiveGuideDrawer({
  open,
  onClose,
  canManage,
  onGoSources,
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://平台域名'
  const baseUrl = `${origin}/api/v1/file-receive/open`

  return (
    <Drawer
      open={open}
      title="外部系统上传指导"
      onClose={onClose}
      width="w-[680px]"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>}
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="text-xs leading-relaxed text-muted-foreground">
              本功能使用 <span className="font-medium text-foreground">Access Key + Secret 签名</span> 认证。
              外部系统仅携带 Access Key 不能上传成功，必须使用 Secret 对请求签名。
            </div>
          </div>
        </div>

        <Step index="1" title="在来源管理中生成密钥">
          进入「来源管理」→「新建来源」，保存后平台会生成并仅展示一次 Access Key / Secret。
          请立即复制保存；遗失后只能轮换密钥。
          {canManage && (
            <div className="mt-3">
              <Button variant="primary" size="sm" onClick={onGoSources}>
                <KeyRound className="mr-1 h-3.5 w-3.5" /> 去生成密钥
              </Button>
            </div>
          )}
          {!canManage && (
            <div className="mt-2 rounded-md bg-secondary px-3 py-2 text-xs">
              当前账号没有来源管理权限，请联系管理员生成密钥后再对接。
            </div>
          )}
        </Step>

        <Step index="2" title="配置来源白名单与格式">
          在来源中配置 IP 白名单、允许的扩展名、QPS 和单文件上限。外部系统必须从白名单 IP 发起请求，
          且文件格式必须在允许列表中；可执行文件始终被拒绝。
        </Step>

        <Step index="3" title="按三段式协议上传">
          创建任务时只传 <span className="font-mono">source_system</span>、<span className="font-mono">file_name</span>、
          <span className="font-mono">content_type</span> 三个字段；request_id、报告编号、大小、SHA-256
          等全部由平台生成。随后上传分片并完成，支持断点续传和幂等重试。
          <div className="mt-3 space-y-2">
            <div className="rounded-md border border-border bg-card p-2.5">
              <div className="mb-1 text-[11px] text-muted-foreground">Base URL</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{baseUrl}</code>
                <Button variant="ghost" size="sm" onClick={() => copyText(baseUrl)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-2.5 font-mono text-[11px] leading-6">
              <div>POST&nbsp;&nbsp;{baseUrl}/receipts</div>
              <div>PUT&nbsp;&nbsp;&nbsp;{baseUrl}/receipts/&#123;upload_id&#125;/parts/&#123;part_no&#125;</div>
              <div>POST&nbsp;&nbsp;{baseUrl}/receipts/&#123;upload_id&#125;/complete</div>
              <div>GET&nbsp;&nbsp;&nbsp;{baseUrl}/receipts/by-request/&#123;request_id&#125;</div>
            </div>
          </div>
        </Step>

        <Step index="4" title="每次请求携带签名头">
          <div className="rounded-md border border-border bg-card p-2.5 font-mono text-[11px] leading-6">
            <div>X-Access-Key: ak_...</div>
            <div>X-Timestamp: 1764000000000（毫秒）</div>
            <div>X-Nonce: 每次请求唯一随机串</div>
            <div>X-Signature: HMAC-SHA256(Secret, 规范化请求串)</div>
            <div>X-Content-SHA256: 分片上传必填</div>
          </div>
          <div className="mt-2">
            规范化请求串为：`METHOD + \n + PATH + \n + AccessKey + \n + Timestamp + \n + Nonce + \n + BodySHA256`。
            签名使用小写十六进制。时间戳允许 ±5 分钟，Nonce 10 分钟内不可重复。
          </div>
        </Step>

        <Step index="5" title="失败重试">
          429/503 严格按响应头 `Retry-After` 退避；分片缺失时先查询断点，只补传缺失分片；
          SHA-256 不一致、格式校验失败等 4xx 不要盲目重试，应修正后使用新的 `request_id`。
        </Step>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          <UploadCloud className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            完整字段、错误码、Python/Java/Node 示例见项目文档：
            <span className="ml-1 font-mono">docs/跨系统文件接收上传对接指南.md</span>。
            联调时请确保外部服务器时间已校准，且 Secret 未写入日志或前端代码。
          </div>
        </div>
      </div>
    </Drawer>
  )
}

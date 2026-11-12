// 表格高度自适应 hook：让表格占满所在滚动容器的剩余可视高度。
// 固定 maxHeight（如 26rem）在大屏下只占可展示区域一半，浪费容器空间；
// 这里实测「容器可视高度 - 表格上方内容 - 表格下方分页栏 - 容器/卡片底部留白」
// 得到表格可用高度，窗口尺寸或上方提示条变化时自动重新测量。
//
// 用法：
//   const tableBoxRef = useRef(null)  // 表格外层容器
//   const footerRef = useRef(null)    // 表格下方保留区（分页栏等，可空）
//   const tableMaxHeight = useTableFillHeight(tableBoxRef, footerRef)
//   <DataTable maxHeight={tableMaxHeight ?? '26rem'} />
import { useLayoutEffect, useState } from 'react'

// 最小高度：约 4 行数据，窗口极小时仍可正常滚动与翻页
const MIN_HEIGHT = 240
// 安全余量：吸收像素取整误差，避免整页多出一条滚动条
const SAFETY_GAP = 8

export function useTableFillHeight(boxRef, footerRef) {
  const [maxHeight, setMaxHeight] = useState(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    // 向上查找最近的可滚动祖先（工作台 Tab 内容区 / 独立页面主内容区）
    let host = box.parentElement
    while (host && host !== document.body) {
      const { overflowY } = window.getComputedStyle(host)
      if (overflowY === 'auto' || overflowY === 'scroll') break
      host = host.parentElement
    }
    if (!host || host === document.body) return undefined

    const card = box.closest('.card')
    // 底部固定留白：滚动容器内边距 + 卡片内容区内边距 + 卡片边框
    // （host.clientHeight 已含其自身内边距，需扣除，否则会多出一条整页滚动）
    const bodyEl = box.parentElement
    const hostPadBottom = parseFloat(window.getComputedStyle(host).paddingBottom) || 0
    const bodyPadBottom = bodyEl
      ? parseFloat(window.getComputedStyle(bodyEl).paddingBottom) || 0
      : 0
    const cardBorderBottom = card
      ? parseFloat(window.getComputedStyle(card).borderBottomWidth) || 0
      : 0
    const bottomFixed = hostPadBottom + bodyPadBottom + cardBorderBottom

    const measure = () => {
      const hostRect = host.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      // 表格在容器内容中的纵向偏移（不受当前滚动位置影响）
      const usedTop = boxRect.top - hostRect.top + host.scrollTop
      // 表格下方保留区：分页栏高度 + 其 mt-3 间距（12px）
      const usedBottom = footerRef?.current ? footerRef.current.offsetHeight + 12 : 0
      const avail = host.clientHeight - usedTop - usedBottom - bottomFixed - SAFETY_GAP
      setMaxHeight(Math.max(MIN_HEIGHT, Math.round(avail)))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host) // 窗口缩放 / 侧栏折叠
    if (card) observer.observe(card) // 提示条出现、统计行换行等上方内容变化
    return () => observer.disconnect()
  }, [boxRef, footerRef])

  return maxHeight
}

export default useTableFillHeight

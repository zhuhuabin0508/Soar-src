// 防 FOUC：在 React 渲染前先按 localStorage 偏好应用 dark class
// themeStore 会接管后续逻辑，这里只保证首屏不闪烁
// 放在 public/ 下：Vite 构建时原样拷贝到 dist 根，index.html 以同步外部脚本引用，
// 保证在任何渲染发生前执行；同源外链脚本符合 CSP script-src 'self'（无内联）
;(function () {
  try {
    var t = localStorage.getItem('soar_theme') || 'light'
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    var resolved = t === 'system' ? (prefersDark ? 'dark' : 'light') : t
    var root = document.documentElement
    if (resolved === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    root.style.colorScheme = resolved
  } catch (e) { /* ignore */ }
})()

/** @type {import('tailwindcss').Config} */
// 设计令牌：语义色映射到 CSS 变量（见 index.css），令牌驱动明暗主题。
// 所有页面与组件应优先使用语义别名（bg-background / text-foreground / border-border），
// 避免直接使用 gray-xxx / cyan-xxx 等原始色，保证明暗切换零改动。
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // 语义色：映射到 CSS 变量，由 index.css 的 :root / .dark 提供值。
      // 这样 bg-background / text-primary / border-border 等工具类会随主题切换。
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "oklch(var(--primary) / <alpha-value>)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "oklch(var(--destructive) / <alpha-value>)",
          foreground: "var(--destructive-foreground)",
        },
        success: {
          DEFAULT: "oklch(var(--success) / <alpha-value>)",
          foreground: "var(--success-foreground)",
        },
        warning: {
          DEFAULT: "oklch(var(--warning) / <alpha-value>)",
          foreground: "var(--warning-foreground)",
        },
        info: {
          DEFAULT: "oklch(var(--info) / <alpha-value>)",
          foreground: "var(--info-foreground)",
        },
        neutral: {
          DEFAULT: "var(--neutral)",
          foreground: "var(--neutral-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        // 图表色板（ECharts / 统计卡片统一引用，支持透明度）
        chart: {
          1: "oklch(var(--chart-1) / <alpha-value>)",
          2: "oklch(var(--chart-2) / <alpha-value>)",
          3: "oklch(var(--chart-3) / <alpha-value>)",
          4: "oklch(var(--chart-4) / <alpha-value>)",
          5: "oklch(var(--chart-5) / <alpha-value>)",
        },
        // 侧边栏专用令牌
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "oklch(var(--sidebar-primary) / <alpha-value>)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
        // 兼容旧代码：brand 色板仍保留，但指向 primary 体系（避免现有页面大面积报错）
        brand: {
          50: "#ecfeff",
          100: "#cffafe",
          200: "#a5f3fc",
          300: "#67e8f9",
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
          700: "#0e7490",
          800: "#155e75",
          900: "#164e63",
          950: "#083344",
        },
      },
      // 圆角体系：由单一基准 --radius 派生，保持视觉协调
      borderRadius: {
        sm: "calc(var(--radius) * 0.6)",
        DEFAULT: "calc(var(--radius) * 0.8)",
        md: "calc(var(--radius) * 0.8)",
        lg: "var(--radius)",
        xl: "calc(var(--radius) * 1.4)",
        "2xl": "calc(var(--radius) * 1.8)",
        "3xl": "calc(var(--radius) * 2.2)",
      },
      // z-index 层级体系（消除 z-10/z-20/z-30/z-40/z-50 随意使用）
      zIndex: {
        base: "0", // 常规内容
        dropdown: "20", // 下拉菜单 / popover
        sticky: "30", // 粘性头部 / 侧边栏
        drawer: "40", // 抽屉
        modal: "50", // 模态框
        toast: "60", // Toast 通知（最高）
      },
      // 动画时长统一（交互反馈）
      transitionDuration: {
        DEFAULT: "150ms",
      },
      // 骨架屏流光动画
      keyframes: {
        "skeleton-shimmer": {
          "0%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "-100% 50%" },
        },
        "table-row-enter": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // 会话操作菜单展开
        "menu-in": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // 消息气泡入场（仅新增消息，不重复播放历史消息）
        "msg-enter": {
          from: { opacity: "0", transform: "translateY(6px) scale(0.99)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "skeleton-shimmer": "skeleton-shimmer 1.8s ease-in-out infinite",
        "table-row-enter": "table-row-enter 0.2s cubic-bezier(0.33, 1, 0.68, 1) both",
        "menu-in": "menu-in 0.14s ease-out both",
        "msg-enter": "msg-enter 0.22s cubic-bezier(0.33, 1, 0.68, 1) both",
      },
    },
  },
  plugins: [],
}

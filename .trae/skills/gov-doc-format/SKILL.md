---
name: gov-doc-format
description: 生成符合 GB/T 9704 党政机关公文格式的 Word 文档，自动识别一二三四级标题并套用二号方正小标宋、三号黑体/楷体/仿宋、28 磅行距与首行缩进 2 字符。用户要求公文、红头文件、正式报告排版或公文格式转换时使用。不用于网页、幻灯片或非 Word 排版。
---

# 党政机关公文格式（GB/T 9704）

用于把纯文本内容排版成符合党政机关公文格式国家标准的 `.docx`。所有参数集中在 [rules.py](file:///d:/trae%20project/soar-src/.trae/skills/gov-doc-format/scripts/rules.py)，生成器 [gongwen.py](file:///d:/trae%20project/soar-src/.trae/skills/gov-doc-format/scripts/gongwen.py) 与校验器 [validate.py](file:///d:/trae%20project/soar-src/.trae/skills/gov-doc-format/scripts/validate.py) 共用同一套阈值。不要手工改格式，直接调用脚本或 `GovDocBuilder`。

## 一步生成

```bash
python scripts/gongwen.py 正文.txt -o 通知.docx --title "关于开展XX工作的通知"
python scripts/validate.py 通知.docx
```

- `正文.txt`：一行一段，UTF-8 或 GBK 编码，空行自动忽略。
- `--title` 省略时，取文本中第一个 `# 标题` 行作为主标题。
- `--latin-font "Times New Roman"`：仅当明确要求西文字体与中文不同才传，默认西文跟随所在段落的中文字体。

`gongwen.py` 依赖 `python-docx`；`validate.py` 只依赖标准库，直接解压 OOXML 校验，任何环境都能跑。

在代码中调用：

```python
import sys
sys.path.insert(0, r".trae/skills/gov-doc-format/scripts")
from gongwen import GovDocBuilder

b = GovDocBuilder()
b.add_title("关于开展XX工作的通知")
b.add_auto("一、总体要求")          # 自动识别为一级标题
b.add_auto("（一）指导思想")        # 自动识别为二级标题
b.add_auto("1.坚持问题导向")        # 自动识别为三级标题
b.add_auto("（1）压实主体责任")     # 自动识别为四级标题
b.add_auto("其他需要说明的事项。")   # 无编号，按正文处理
b.save("通知.docx")
```

也可以显式指定：`add_title(text)`、`add_heading(text, 1~4)`、`add_body(text)`、`save(path)`。

## 格式基线（不得改动）

| 项目 | 参数 |
| --- | --- |
| 页面 | A4，上 3.7cm、下 3.5cm、左 2.8cm、右 2.6cm |
| 行间距 | 全文固定值 28 磅（`lineRule=exact`） |
| 缩进 | 所有段落首行缩进 2 字符（`firstLineChars=200`） |
| 主标题 | 二号 22pt 方正小标宋简体，居中，不缩进 |
| 一级标题 | 三号 16pt 黑体，`一、` 单独成行 |
| 二级标题 | 三号 16pt 楷体_GB2312，`（一）` 单独成行 |
| 三级标题 | 三号 16pt 仿宋_GB2312，`1.` |
| 四级标题 | 三号 16pt 仿宋_GB2312，`（1）` |
| 正文 | 三号 16pt 仿宋_GB2312，两端对齐 |

西文与数字默认跟随所在段落的中文字体（标题行即黑体/楷体，正文即仿宋_GB2312），避免 Word 回退 Calibri。

## 层级自动识别

`parse_line()` 按行首编号判断，顺序为二级 → 四级 → 三级 → 一级，避免括号编号被误判：

- `一、` `二、` → 一级（黑体）
- `（一）` `(一)` → 二级（楷体_GB2312）
- `1.` `1．` → 三级（仿宋_GB2312），要求点号后不是数字，防止把 `2024.10` 日期误判为标题
- `（1）` `(1)` → 四级（仿宋_GB2312）
- `# 标题` → 主标题；`##` 起为一级标题，依此类推至 `#####` 为四级
- 其余 → 正文

内容有明确编号但属于正文叙述时，用 `add_body()` 显式指定，不要依赖自动识别。

## 实施要点

1. 中文与西文字体必须分别写入 `w:rFonts` 的 `w:eastAsia` 与 `w:ascii/w:hAnsi`，只设 `run.font.name` 会导致中文回退。
2. 行距用 `paragraph_format.line_spacing = Pt(28)` 且 `line_spacing_rule = WD_LINE_SPACING.EXACTLY`；不要用倍数行距或「最小值」。
3. 首行缩进必须写 `w:ind/@w:firstLineChars="200"`，仅写绝对值会在字号变化时偏差。
4. 标题不加粗：黑体、小标宋、楷体本身已有字重，`bold=True` 会破坏国标观感。
5. 不插入空行做间距，段间距统一为 0，靠 28 磅行距撑开版面。
6. 不使用 Word 内置「标题 1/2/3」样式，避免主题字体覆盖中文字体。

## 交付前校验

生成后必须跑一遍：

```bash
python scripts/validate.py 通知.docx
```

校验器直接解析 `word/document.xml` 与 `word/styles.xml`，逐项核对：页面尺寸与页边距、Normal 样式的字体/字号/行距/缩进、每个段落的固定 28 磅行距、首行缩进 2 字符（标题为 0）、四级标题字体映射、字号、对齐方式与是否加粗。全部符合时退出码为 0；有偏差时逐条列出「第N段 + 实际值 + 应为值」，退出码为 1。

生成时用了 `--latin-font`，校验时需传同一个值。

字体缺失时（如未安装「方正小标宋简体」），Word 会静默替换，需先安装字体再交付；不得擅自改用宋体替代。

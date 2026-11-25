# wechat-article

简体中文 | [English](./README.en.md)

写微信公众号文章最烦的几件事：Markdown 粘进去格式全乱、想做个折叠块微信又不支持 JS、每次发文都要打开设计软件给头图加标题、改个错别字重传草稿箱又多出一份。

这个工具专门解决这些琐事。**你只管写纯 Markdown**，剩下的交给它：
1. **源稿只读，不乱改字**：绝不擅自改写你的文字或补充段落，严格按固定模板映射成稳定的公众号富文本，原生支持中英文混排与行尾标点加粗强化解析。
2. **双层 SVG 半透明渐隐折叠 + GitHub 引导卡片**：支持 `::: details` 半透明渐隐预览折叠（无重复顶栏，整块点击展开，右下角小按钮收起，不触发微信弹窗）与 `::: githubcard <repo> :::` 仓库引导卡片。
3. **自动合成 2.35:1 高清头图与 1:1 智能裁切**：基于 `templates/template-*.html`（支持杂志风、深色矩阵风、双色书卷宣纸风），自动排入标题、专著/散篇标识、期号、字数存量与运行坐标，输出 1800×766（2.35:1）封面图，并自动注入微信 1:1 正方形安全区裁剪参数。
4. **原地更新草稿**：正文图片自动传微信图床并缓存，多次推送同一篇文章会原地更新对应草稿，不会产生一堆重复草稿。

---

## 快速上手

```bash
# 1. 安装轻量依赖（markdown-it + juice 原生内联）
pnpm install

# 2. 用标准模板本地生成排版预览（不联网、不需要公众号凭证）
node scripts/wechat.mjs gen templates/editorial.md
```

生成结果保存在 `~/.wechat-article/work/<文章名>/`（可通过 `WECHAT_WORK_DIR` 修改）：
- `body.html`：可以直接复制到公众号后台或查看的最终富文本 HTML
- `layout.json`：每一行命中了哪条排版规则，方便排查
- `meta.json`：标题、封面与 SVG 统计等元数据

### 推送到微信公众号草稿箱

```bash
# 配置环境变量（WECHAT_APP_ID / WECHAT_APP_SECRET 或指向凭证文件）
cp .env.example .env

# 一键上传图片、合成封面并推送草稿
node scripts/wechat.mjs push path/to/your-post.md
```

---

## 它是怎么运作的

1. **固定模板展开**：读取 Markdown，按唯一标准模板（见 `templates/editorial.md`）将章节标题（`##` 统一为 `01` 墨青方块页签、`###` 为左竖线小节）、提示块（`TIP`/`NOTE`/`WARNING`/`IMPORTANT`）、`::: githubcard`、`::: details` 半透明渐隐折叠与长引出处展开为结构化片段。
2. **样式内联（原生引擎）**：结合 `assets/theme.css` 与 `juice` 将 Markdown 渲染为微信支持的纯内联样式 HTML，并修补 SVG 高度属性以保证在微信客户端可正常点击展开/收起。
3. **头图合成与智能裁切**：优先使用 Chrome（自动回退 Edge）无头模式渲染 1800×766 封面图（支持 `template-a/b/c.html` 风格），并在发布时注入微信 1:1 正方形裁剪坐标（精准锁定右侧规格信息卡，避免标题被生硬腰斩）。
4. **素材与草稿同步**：上传本地图片替换外链并记录文件 Hash 缓存，通过 `drafts.json` 记录 `media_id` 实现幂等更新。

---

## 仓库结构

- `scripts/wechat.mjs`：核心 CLI（`gen` 本地渲染 / `push` 推送草稿）
- `components/`：组件层，`cards.mjs`（卡片、提示块、引文与代码块）与 `svg-fold.mjs`（双层 SVG 半透明渐隐折叠）
- `assets/`：公众号主题样式 `theme.css`、默认封面与底图
- `templates/`：标准正文与样式规范模板 `editorial.md` 及封面 HTML 模板（`template-a/b/c.html`）
- `docs/`：历史排版规范与参考文档
- `SKILL.md`：给 AI Agent 用的技能触发与执行说明

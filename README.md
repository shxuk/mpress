# wechat-article

简体中文 | [English](./README.en.md)

写微信公众号文章最烦的几件事：Markdown 粘进去格式全乱、想做个折叠块微信又不支持 JS、每次发文都要打开设计软件给头图加标题、改个错别字重传草稿箱又多出一份。

这个工具专门解决这些琐事。**你只管写纯 Markdown**，剩下的交给它：
1. **源稿只读，不乱改字**：绝不擅自改写你的文字或补充段落，严格按 Markdown 语法映射成稳定的公众号富文本。
2. **纯 SVG 交互折叠**：支持 `:::details` 和 ````fold```` 语法，直接生成微信里能点开收起的折叠卡片。
3. **自动合成头图**：输入无字底图，脚本自动叠加遮罩并把标题、摘要排进安全区，生成 2.35:1 封面图。
4. **原地更新草稿**：正文图片自动传微信图床并缓存，多次推送同一篇文章会原地更新对应草稿，不会产生一堆重复草稿。

---

## 快速上手

```bash
# 1. 安装轻量依赖（markdown-it + juice 原生内联）
pnpm install

# 2. 本地生成排版预览（不联网、不需要公众号凭证）
pnpm gen docs/样例/style-overview.md
```

生成结果保存在 `~/.wechat-article/work/<文章名>/`（可通过 `WECHAT_WORK_DIR` 修改）：
- `body.html`：可以直接复制到公众号后台或查看的最终富文本 HTML
- `layout.json`：每一行命中了哪条排版规则，方便排查
- `meta.json`：标题、摘要、封面等元数据

### 推送到微信公众号草稿箱

```bash
# 复制环境变量模板并填入你的 AppID / AppSecret
cp .env.example .env

# 一键上传图片、合成封面并推送草稿
pnpm push path/to/your-post.md
```

---

## 它是怎么运作的

1. **规则展开（AST / 字面匹配）**：读取 Markdown，把提示块（`TIP`/`NOTE`/`WARNING`）、折叠块（`:::details` / ````fold````）、引用出处等展开成固定 HTML 结构。
2. **样式内联（自研轻量原生引擎）**：结合 `assets/theme.css` 与 `juice` 将 Markdown 渲染为微信支持的纯内联样式 HTML，并自动修补 SVG 高度属性防止在微信端变形。
3. **头图合成**：取无字底图叠加遮罩，按字数自动缩放字号排入左侧安全区，输出标准 1800×766 封面图。
4. **素材与草稿同步**：上传本地图片替换外链并记录文件 Hash 缓存，通过 `drafts.json` 记录 `media_id` 实现幂等更新。

---

## 仓库结构

- `scripts/wechat.mjs`：核心 CLI 脚本（`gen` 本地渲染 / `push` 推送草稿）
- `assets/`：公众号主题样式 `theme.css`、默认封面与底图、SVG 折叠组件
- `templates/`：头图排版 HTML 模板
- `docs/`：排版规范与示例 Markdown
- `SKILL.md`：给 AI Agent 用的技能触发与执行说明

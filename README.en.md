# wechat-article

[简体中文](./README.md) | English

Publishing Markdown articles to a WeChat Official Account (微信公众号) is notoriously tedious: pasted formatting breaks, JavaScript is stripped (breaking interactive toggles), cover images need manual text overlays every time, and re-uploading after fixing a typo creates duplicate drafts.

This tool & AI Agent Skill automates the entire pipeline while keeping your source Markdown **strictly read-only**:
1. **Zero text alteration**: never rewrites your prose; maps literal Markdown structures to clean, consistent WeChat-compatible HTML.
2. **Pure SVG interactive folds**: turns `:::details` and ````fold```` blocks into clickable expand/collapse cards using pure CSS/SVG.
3. **Automated cover generation**: composites title and summary onto a text-free base image inside safe margins (2.35:1, 1800×766).
4. **Idempotent draft publishing**: uploads local images to WeChat's media library with hash caching, and updates the existing draft (`media_id`) on repeated pushes.

---

## Quick Start

```bash
# 1. Install dependencies (pure native lightweight markdown-it + juice engine)
pnpm install

# 2. Generate local HTML preview (offline, no WeChat credentials needed)
pnpm gen docs/样例/style-overview.md
```

Outputs are written to `~/.wechat-article/work/<slug>/` (configurable via `WECHAT_WORK_DIR`):
- `body.html`: final WeChat-ready inline HTML
- `layout.json`: line-by-line rule match report
- `meta.json`: extracted title, summary, and cover metadata

### Push to WeChat Drafts

```bash
cp .env.example .env
# Fill in WECHAT_APP_ID and WECHAT_APP_SECRET, then:
pnpm push path/to/your-post.md
```

---

## How It Works

1. **Literal component expansion**: parses Markdown and expands callouts (`TIP`/`NOTE`/`WARNING`), fold blocks, and attributed quotes into fixed HTML primitives.
2. **Inline CSS rendering**: utilizes lightweight native `juice` engine with `assets/theme.css` to inline all styles directly and patches SVG height attributes so animations render properly inside WeChat.
3. **Cover compositing**: overlays a tinted mask onto a clean base image and auto-fits the title/summary within the left safe zone.
4. **Media & draft sync**: uploads local images once (cached by content hash) and creates or updates the draft via the Official Account API.

---

## Repository Layout

- `scripts/wechat.mjs`: main CLI (`gen` / `push`)
- `assets/`: `theme.css`, default cover/base images, SVG fold primitives
- `templates/`: cover layout HTML templates
- `docs/`: visual specs and sample Markdown
- `SKILL.md`: AI Agent Skill specification

#!/usr/bin/env node

function getSiteStats(blogRoot) {
	let totalChars = 0;
	let runningDays = 12;

	try {
		const contentDir = blogRoot ? path.join(blogRoot, "content") : "";
		if (contentDir && fs.existsSync(contentDir)) {
			function scan(dir) {
				for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, ent.name);
					if (ent.isDirectory()) { if (!ent.name.includes("backup") && !ent.name.startsWith(".")) scan(full); }
					else if (/\.(md|mdx)$/i.test(ent.name)) {
						const raw = fs.readFileSync(full, "utf8");
						const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
						const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
						// 仅统计纯中文字符数，精准真实
						totalChars += cjk;
					}
				}
			}
			scan(contentDir);
		}
	} catch (e) {
		console.error("统计字数失败:", e);
	}

	try {
		const cfgPath = blogRoot ? path.join(blogRoot, "src", "config", "siteConfig.ts") : "";
		if (cfgPath && fs.existsSync(cfgPath)) {
			const text = fs.readFileSync(cfgPath, "utf8");
			const m = text.match(/siteStartDate:\s*["'](\d{4}-\d{2}-\d{2})["']/);
			if (m) {
				const start = new Date(m[1]).getTime();
				runningDays = Math.ceil(Math.abs(Date.now() - start) / 86400000);
			}
		}
	} catch (e) {
		console.error("统计天数失败:", e);
	}

	const wordCountLabel = totalChars > 0 ? `${totalChars.toLocaleString()} 字总结` : "151,710 字总结";
	const statusLabel = `DAY ${runningDays} · 推进中`;

	return { totalChars, wordCountLabel, runningDays, statusLabel };
}
/**
 * wechat-publisher 的唯一入口，两个动作：
 *
 *   node scripts/wechat.mjs gen  <任意.md>   固定形态映射 + 内联 HTML + layout.json，不联网
 *   node scripts/wechat.mjs push <任意.md>   生成 + 换图片地址 + 新建/更新草稿
 *
 * 不依赖博客仓库、MCP、npx、npm install：渲染器来自本目录的 vendor/，凭证来自本目录的 credentials。
 * 两者只在私有运行包里存在，Git 仓库里只有源码。
 * 两者都可加 --timing（或 WECHAT_TIMING=1），把每个阶段耗时打到 stderr，产物不变。
 * 失败时只归到一类：凭证 / 白名单 / 图片 / 结构（网络异常单列）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import juice from "juice";

const md = new MarkdownIt({
	html: true,
	breaks: true,
	linkify: true,
});

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const CWD = process.cwd();
// 产物和草稿状态留在仓库外，源码目录保持只读
const WORK = process.env.WECHAT_WORK_DIR || path.join(os.homedir(), ".wechat-article", "work");
const STATE_DIR = path.join(WORK, "state");
const THEME = path.join(SKILL_DIR, "assets", "theme.css");
const DEFAULT_COVER = path.join(SKILL_DIR, "assets", "default-cover.png");
const HEAD_BASE = path.join(SKILL_DIR, "assets", "head-base.jpg");
const DRAFTS = path.join(STATE_DIR, "drafts.json");
const UPLOADS = path.join(STATE_DIR, "uploads.json");
const AUTHOR = process.env.WECHAT_AUTHOR || "";
const API = "https://api.weixin.qq.com/cgi-bin";

/** 只有显式给了 BLOG_ROOT 才做站内链接补全和 /public 图片解析；独立使用时不依赖博客仓库 */
const BLOG_ROOT = (() => {
	if (process.env.BLOG_ROOT && fs.existsSync(process.env.BLOG_ROOT)) return process.env.BLOG_ROOT;
	if (fs.existsSync(path.join(process.cwd(), "astro.config.mjs"))) return process.cwd();
	return "";
})();

const EXIT_CODES = { 凭证: 2, 白名单: 3, 图片: 4, 结构: 5, 网络: 6 };

// ---------- 计时 ----------

const TIMING = process.env.WECHAT_TIMING === "1" || process.argv.includes("--timing");
const timingStart = performance.now();
let timingLast = timingStart;
const timingRows = [];

function mark(name) {
	if (!TIMING) return;
	const now = performance.now();
	timingRows.push([name, now - timingLast]);
	timingLast = now;
}

function printTiming(label) {
	if (!TIMING) return;
	console.error(
		`\n耗时（${label}）：进程内 ${(performance.now() - timingStart).toFixed(0)} ms · 含 Node 启动 ${(process.uptime() * 1000).toFixed(0)} ms`,
	);
	for (const [name, ms] of timingRows) console.error(`  ${name} ${ms.toFixed(0)} ms`);
}

class PublishError extends Error {
	constructor(kind, message, hint) {
		super(message);
		this.kind = kind;
		this.hint = hint;
	}
}

function fail(kind, message, hint) {
	throw new PublishError(kind, message, hint);
}

const readJson = (file, fallback) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
};

const writeJson = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

// ---------- 生成 ----------

function parseFrontmatter(text) {
	const data = {};
	const unquote = (value) =>
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
			? value.slice(1, -1)
			: value;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		if (kv[2].trim()) {
			data[kv[1]] = unquote(kv[2].trim());
			continue;
		}
		// book 文章把封面写在 banner 下：banner:\n  image: "../banners/x.jpg"
		const nested = {};
		while (i + 1 < lines.length) {
			const child = lines[i + 1].match(/^\s{1,}([A-Za-z_][\w-]*):\s*(.*)$/);
			if (!child) break;
			i++;
			if (child[2].trim()) nested[child[1]] = unquote(child[2].trim());
		}
		if (Object.keys(nested).length) data[kv[1]] = nested;
	}
	return data;
}

function resolveAsset(src, sourcePath) {
	if (!src || /^(https?:|data:)/i.test(src)) return src;
	if (src.startsWith("/") && !BLOG_ROOT) {
		fail(
			"图片",
			`站内图片需要站点根目录：${src}`,
			"设 BLOG_ROOT 指向仓库根，或把图片改成相对源稿的路径",
		);
	}
	const local = src.startsWith("/")
		? path.join(BLOG_ROOT, "public", src)
		: path.resolve(path.dirname(sourcePath), decodeURIComponent(src));
	if (!fs.existsSync(local)) {
		fail("图片", `找不到图片：${src}`, `期望路径 ${local}`);
	}
	return local;
}

// ---------- 折叠块：```fold 标题｜摘要 → 两层 SVG ----------

const FOLD_TEMPLATE = path.join(SKILL_DIR, "assets", "wechat-svg-fold.html");
const FOLD_W = 686;
const FOLD_CHARS = 23;
const NO_LINE_START = "，。、；：？！）」』】》”’%";

let foldTemplate = "";

const xml = (s) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 作者会用 &lt;details&gt; 这种实体避开 HTML 解析，展开成组件时要先还原再转义
const decode = (s) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");

const charWidth = (ch) => (/[\x00-\xff]/.test(ch) ? 0.5 : 1);

function wrapLines(text) {
	const lines = [];
	let line = "";
	let width = 0;
	for (const ch of [...text]) {
		if (width + charWidth(ch) > FOLD_CHARS && line && !NO_LINE_START.includes(ch)) {
			lines.push(line);
			line = "";
			width = 0;
		}
		line += ch;
		width += charWidth(ch);
	}
	if (line) lines.push(line);
	return lines;
}

/** 折叠块内只渲染纯文本：链接降级为「文字（地址）」，去掉强调记号与引用箭头，列表符号保留 */
const foldPlain = (line) =>
	line
		.trim()
		.replace(/^>\s?/, "")
		.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
			text.trim() === url.trim() ? url.trim() : `${text.trim()}（${url.trim()}）`,
		)
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`([^`]*)`/g, "$1");

function foldHtml(title, summary, body, { keepLines = false } = {}) {
	if (!foldTemplate) {
		// 空行会截断 Markdown 的 HTML 块，模板里的空行必须去掉
		foldTemplate = fs
			.readFileSync(FOLD_TEMPLATE, "utf8")
			.replace(/<!--[\s\S]*?-->/g, "")
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.join("\n");
	}
	const lines = keepLines
		? body
				.split(/\r?\n/)
				.map(foldPlain)
				.filter(Boolean)
				.flatMap(wrapLines)
		: body
				.split(/\n{2,}/)
				.map((p) => p.split(/\r?\n/).map(foldPlain).join(""))
				.filter(Boolean)
				.flatMap(wrapLines);
	if (!lines.length) fail("结构", "fold 块没有正文", "在 ```fold 标题｜摘要 下面写内容");

	// details 没有摘要：收起态只留一行标题 + 右侧展开提示；fold 有摘要时才多留一行。
	const firstY = summary ? 142 : 106;
	const lineHeight = 44;
	const collapsedHeight = summary ? 100 : 64;
	const viewBoxH = firstY + (lines.length - 1) * lineHeight + 30;
	const expandedVw = ((viewBoxH / FOLD_W) * 100 * 0.92).toFixed(1);
	const collapsedVw = ((collapsedHeight / FOLD_W) * 100 * 0.92).toFixed(1);
	const bodyLines = lines
		.map(
			(line, i) =>
				`<text x="24" y="${firstY + i * lineHeight}" font-size="27" fill="#111819" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif">${xml(line)}</text>`,
		)
		.join("\n");
	const summaryLine = summary
		? `<text x="24" y="84" font-size="24" fill="#5d6667" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif">${xml(summary)}</text>`
		: "";

	return foldTemplate
		.replaceAll("{{COLLAPSED_VW}}", collapsedVw)
		.replaceAll("{{EXPANDED_VW}}", expandedVw)
		.replaceAll("{{VIEWBOX_W}}", String(FOLD_W))
		.replaceAll("{{VIEWBOX_H}}", String(viewBoxH))
		.replaceAll("{{TITLE}}", xml(title))
		.replaceAll("{{EXPAND_LABEL}}", "点击展开 ↓")
		.replace("{{SUMMARY_LINE}}", summaryLine)
		.replace("{{BODY_LINES}}", bodyLines)
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.join("\n");
}

// ---------- 作者层 Markdown → 内联 HTML 组件 ----------

const BOX_KINDS = { TIP: "tip", NOTE: "note", WARNING: "warning", IMPORTANT: "important" };

/** `**加粗**` 紧跟中文时不是合法闭合（CommonMark），这里补成 <strong> */
function cjkStrong(text) {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2
				? part
				: part.replace(
						/\*\*(?!\s)([^*\n]*?[^\s*])\*\*(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g,
						"<strong>$1</strong>",
					),
		)
		.join("");
}

/** 组件内的文本：先还原本体，再转义，再补 <strong> */
const compText = (s) => cjkStrong(xml(decode(s)));

function boxHtml(kind, bodyLines, title = "") {
	const label = Object.keys(BOX_KINDS).find((k) => BOX_KINDS[k] === kind);
	const body = bodyLines
		.join("\n")
		.split(/\n{2,}/)
		.map((p) => p.replace(/\s*\n\s*/g, "").trim())
		.filter(Boolean)
		.map((p) => `<p class="wx-box-body">${compText(p)}</p>`)
		.join("\n");
	const heading = title ? `<p class="wx-box-title">${compText(title)}</p>\n` : "";
	return `<section class="wx-box wx-box-${kind}"><p class="wx-box-label">${label}</p>\n${heading}${body}</section>`;
}

function quoteHtml(paragraphs, source) {
	const body = paragraphs
		.join("\n")
		.split(/\n{2,}/)
		.map((p) => p.replace(/\s*\n\s*/g, "").trim())
		.filter(Boolean)
		.map((p) => `<p class="wx-quote-text">${compText(p)}</p>`)
		.join("\n");
	return `<section class="wx-quote">\n${body}\n<p class="wx-quote-source">${xml(source)}</p>\n</section>`;
}

function codeHtml(lang, lines) {
	const label = lang ? `<p class="wx-pre-lang">${xml(lang.toUpperCase())}</p>\n` : "";
	const body = lines.map((line) => `<p class="wx-pre-line">${xml(line)}</p>`).join("\n");
	return `<section class="wx-pre">\n${label}<section class="wx-pre-body">\n${body}\n</section>\n</section>`;
}

function figureHtml(alt, src, caption) {
	const figure = `<section class="wx-figure"><img src="${xml(src)}" alt="${xml(alt)}"></section>`;
	return caption ? `${figure}\n<p class="wx-caption">${compText(caption)}</p>` : figure;
}

function chapterHtml(no, text, isFirst = false) {
	const style = isFirst ? ' style="margin-top: 8px;"' : '';
	return `<section class="wx-h2"${style}><span class="wx-h2-no">${xml(no)}</span><span class="wx-h2-text">${compText(text)}</span></section>`;
}

function blockHtml(cls, textCls, lines) {
	const text = lines.join(" ").replace(/\s+/g, " ").trim();
	const p = textCls ? `<p class="${textCls}">` : "<p>";
	return `<section class="${cls}">${p}${compText(text)}</p></section>`;
}

const PLAIN_SKIP = /^(?:[-*+]\s|\d+\.\s|\||>|#|!\[|---|___|\*\*\*)/;

/**
 * 把作者写得出的 Markdown 组件展开成主题的 wx-* 结构，交给内置 juice 引擎内联样式。
 * 规则固定这一套，不再扩展。
 */
function expandComponents(body) {
	const lines = body.split(/\r?\n/);
	const out = [];
	const mappings = [];
	let h2Counter = 1;
	const mapped = (rule, line) => mappings.push({ line: line + 1, rule });
	const hasChapter = /^#\s+\S/m.test(body);
	let seenChapter = false;
	let leadDone = !hasChapter;

	const gap = () => {
		if (out.length && out[out.length - 1] !== "") out.push("");
	};

	for (let i = 0; i < lines.length; ) {
		let line = lines[i];
		// 链接包图片 [![alt](src)](href)：微信会剥掉 <a>，只保留图片，否则渲染出乱码
		const withoutLink = line.replace(/\[(!\[[^\]]*\]\([^)\s]+\))\]\([^)\s]+\)/g, "$1");
		if (withoutLink !== line) {
			mapped("image:linked-stripped", i);
			line = withoutLink;
		}

		// 站点容器：:::tip[标题] / :::details[标题]，闭合行为单独的 :::
		const container = line.match(/^:::([A-Za-z]+)(?:\[(.*)\])?\s*$/);
		if (container) {
			const kind = container[1].toLowerCase();
			const title = (container[2] || "").trim();
			const buf = [];
			let j = i + 1;
			while (j < lines.length && lines[j].trim() !== ":::") {
				buf.push(lines[j]);
				j++;
			}
			if (j >= lines.length) fail("结构", "::: 容器没有闭合", "补一行单独的 :::");
			const openLine = i;
			i = j + 1;
			if (kind === "details") {
				mapped("container:details", openLine);
				// Astro 的 :::details 是作者显式折叠，标题照抄，正文按行保留
				gap();
				out.push(foldHtml(title, "", buf.join("\n"), { keepLines: true }));
				out.push("");
				continue;
			}
			if (kind === "caution" || BOX_KINDS[kind.toUpperCase()]) {
				const boxKind = kind === "caution" ? "warning" : BOX_KINDS[kind.toUpperCase()];
				mapped(`container:${kind}`, openLine);
				gap();
				out.push(boxHtml(boxKind, buf, title));
				out.push("");
				continue;
			}
			// 未知容器不猜语义：整块原样交回原生 Markdown
			out.push(line);
			out.push(...buf);
			out.push(":::");
			i = j + 1;
			continue;
		}

		// 围栏：fold / end / sign / mermaid / 普通代码
		const fence = line.match(/^```([A-Za-z0-9_-]+)?(?:\s+(.*))?$/);
		if (fence) {
			const lang = (fence[1] || "").toLowerCase();
			const meta = (fence[2] || "").trim();
			const buf = [];
			let j = i + 1;
			while (j < lines.length && !/^```\s*$/.test(lines[j])) {
				buf.push(lines[j]);
				j++;
			}
			if (j >= lines.length) fail("结构", "代码块没有闭合", "补一行 ```");
			mapped(`fence:${lang || "code"}`, i);
			i = j + 1;
			gap();
			if (lang === "fold") {
				const [title, ...rest] = meta.split("｜");
				if (!title) fail("结构", "fold 块缺少标题", "写成 ```fold 标题｜摘要");
				out.push(foldHtml(title.trim(), rest.join("｜").trim(), buf.join("\n")));
			} else if (lang === "end") {
				out.push(blockHtml("wx-end", "wx-end-text", buf));
			} else if (lang === "sign") {
				out.push(blockHtml("wx-sign", "", buf));
			} else if (lang === "mermaid") {
				out.push("```mermaid", ...buf, "```");
			} else {
				out.push(codeHtml(lang, buf));
			}
			out.push("");
			continue;
		}

		// 引用块：提示块（关键词后可跟粗标题）/ 长引（出处以 —— 开头）/ 普通引用
		if (/^>/.test(line)) {
			const buf = [];
			let j = i;
			while (j < lines.length && /^>/.test(lines[j])) {
				buf.push(lines[j].replace(/^>\s?/, ""));
				j++;
			}
			const first = (buf[0] || "").trim();
			const boxToken = first.split(/\s+/, 1)[0];
			const boxKind = BOX_KINDS[boxToken];
			const boxTitle = boxKind ? first.slice(boxToken.length).trim() : "";
			const isLongQuote = /^——/.test((buf[buf.length - 1] || "").trim());
			mapped(boxKind ? `box:${boxToken.toLowerCase()}` : isLongQuote ? "quote:source" : "quote", i);
			i = j;
			gap();
			if (boxKind) {
				out.push(boxHtml(boxKind, buf.slice(1), boxTitle));
			} else if (isLongQuote) {
				out.push(quoteHtml(buf.slice(0, -1), buf[buf.length - 1].trim()));
			} else {
				// 不再提供独立短引样式，普通引用按正文段落输出。
				const paragraphs = buf
					.join("\n")
					.split(/\n{2,}/)
					.map((p) => p.replace(/\s*\n\s*/g, "").trim())
					.filter(Boolean);
				out.push(...paragraphs.map((p) => `<p>${compText(p)}</p>`));
			}
			out.push("");
			continue;
		}

		// 标题：首个 H1 在公众号正文剥除，避免与微信自带大标题重复
		const h1 = line.match(/^#\s+(.+)$/);
		if (h1) {
			if (!seenChapter) {
				mapped("chapter:stripped-for-wechat", i);
				seenChapter = true;
				i++;
				continue;
			}
			mapped("chapter", i);
			gap();
			out.push(`<h1 class="wx-chapter">${compText(h1[1].trim())}</h1>`);
			out.push("");
			i++;
			continue;
		}
		const h2Match = line.match(/^##\s+(?:(\d{1,2})\s+)?(\S.*)$/);
		if (h2Match) {
			mapped("chapter-tab", i);
			gap();
			let no = h2Match[1];
			let titleText = h2Match[2].trim();
			if (no) {
				no = String(parseInt(no, 10)).padStart(2, "0");
				h2Counter = parseInt(no, 10) + 1;
			} else {
				no = String(h2Counter++).padStart(2, "0");
			}
			out.push(chapterHtml(no, titleText, out.length === 0 || (out.length === 1 && out[0] === "")));
			out.push("");
			i++;
			continue;
		}
		const h3 = line.match(/^###\s+(.+)$/);
		if (h3) {
			mapped("heading-3", i);
			gap();
			out.push(`<h3 class="wx-h3">${compText(h3[1].trim())}</h3>`);
			out.push("");
			i++;
			continue;
		}

		// 图片 + 下一行斜体图注
		const img = line.match(/^!\[(.*?)\]\((.+?)\)\s*$/);
		if (img) {
			let k = i + 1;
			while (k < lines.length && !lines[k].trim()) k++;
			const cap = k < lines.length ? lines[k].trim().match(/^\*([^*].*)\*$/) : null;
			mapped(cap ? "figure:caption" : "figure", i);
			gap();
			out.push(figureHtml(img[1], img[2], cap ? cap[1].trim() : ""));
			i = cap ? k + 1 : i + 1;
			out.push("");
			continue;
		}

		// 导语：不再强制自动加 wx-lead 绿框，保持纯正文

		if (line.trim()) mapped("native", i);
		out.push(cjkStrong(line));
		i++;
	}
	return { body: out.join("\n"), mappings };
}


/**
 * 产物只允许落在 WORK 下。
 * 源稿只读：脚本对源稿只做 readFile，不写、不建目录。
 */
function assertWritable(target) {
	const workRel = path.relative(WORK, target);
	if (!workRel || workRel.startsWith("..") || path.isAbsolute(workRel)) {
		fail("结构", `产物目录越界：${target}`, "slug 不能指向上级目录");
	}
}

function buildArticle(source, sourceUrl) {
	if (/\.mdx$/i.test(source)) {
		fail("结构", "MDX 不支持：公众号没有 Astro 运行时", "改用纯 .md");
	}
	const abs = path.resolve(CWD, source);
	if (path.extname(abs).toLowerCase() !== ".md") {
		fail("结构", "源文件必须是纯 .md", "不要传 .mdx、Astro 组件或派生稿");
	}
	if (!fs.existsSync(abs)) {
		fail("结构", `源文件不存在：${abs}`, "路径按当前目录解析，例如 ./文章.md");
	}
	// 站内稿按 content/ 之后的相对路径做 slug，避免跨章同名；其他位置用文件名
	const contentRoot = BLOG_ROOT ? path.join(BLOG_ROOT, "content") : "";
	if (!sourceUrl && contentRoot) {
		const rel = path.relative(contentRoot, abs).replace(/\\/g, "/");
		const site = siteUrl();
		if (site && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			if (rel.startsWith("essay/")) {
				sourceUrl = `${site}/essay/${rel.replace(/^essay\//, "").replace(/\.md$/i, "")}/`;
			} else if (rel.startsWith("books/")) {
				sourceUrl = `${site}/case/${rel.replace(/^books\//, "").replace(/\.md$/i, "")}/`;
			}
		}
	}
	let sourceRel = path.basename(abs);
	let slug = path.basename(abs, path.extname(abs));
	if (contentRoot) {
		const contentRel = path.relative(contentRoot, abs);
		if (!contentRel.startsWith("..") && !path.isAbsolute(contentRel)) {
			sourceRel = contentRel;
			slug = contentRel.replace(/\.md$/i, "").split(path.sep).join("-");
		}
	}
	if (path.basename(path.dirname(abs)) === "样例") slug = `sample-${slug}`;

	const raw = fs.readFileSync(abs, "utf8");
	const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
	const data = parseFrontmatter(fm?.[1] || "");
	let body = fm ? raw.slice(fm[0].length) : raw;

	// 标题：frontmatter → 首个 H1 → 文件名，保证独立文稿不用先补 frontmatter
	// 必须在组件展开前取，展开后 H1 已经变成 wx-chapter 结构
	let title = (data.title || "").trim();
	if (!title) {
		const h1 = body.match(/^#\s+(.+)$/m);
		if (h1) title = h1[1].trim();
	}

	const expanded = expandComponents(body);
	body = expanded.body;

	body = body.replace(
		/(!\[[^\]]*\]\()([^)\s]+)(\))/g,
		(_, head, src, tail) => head + resolveAsset(src, abs) + tail,
	);
	body = body.replace(
		/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi,
		(_, head, src, tail) => head + resolveAsset(src, abs) + tail,
	);

	// 标题：frontmatter → 首个 H1 → 文件名，保证独立文稿不用先补 frontmatter
	if (!title) title = path.basename(abs, path.extname(abs));

	// 封面：frontmatter.image → banner.image → 正文第一张本地图 → 内置默认封面
	let cover = resolveAsset((data.image || data.banner?.image || "").trim(), abs);
	if (!cover) {
		const first = body.match(/!\[[^\]]*\]\(([^)\s]+)\)/) || body.match(/<img\b[^>]*?\bsrc=["']([^"']+)["']/i);
		if (first && !/^https?:/i.test(first[1])) cover = first[1];
	}
	if (!cover && fs.existsSync(DEFAULT_COVER)) cover = DEFAULT_COVER;
	if (!cover) fail("图片", "没有封面，正文里也没有本地图片", "在 assets/default-cover.png 放一张默认封面");

	// 头图文案：两层（标题 + 摘要），书稿再加第三层书名
	const summary = (data.description || data.summary || data.digest || "").trim();
	const book = (data.banner?.book || data.book || bookTitleOf(abs) || "").trim();
	// 底图必须无字：优先 banner.image（书稿插画），其次运行包内置底图；封面图常带字，不作底图
	const headBase = process.env.WECHAT_HEAD_BASE
		? path.resolve(CWD, process.env.WECHAT_HEAD_BASE)
		: resolveAsset((data.banner?.image || "").trim(), abs) ||
			(fs.existsSync(HEAD_BASE) ? HEAD_BASE : cover);

	const images =
		(body.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length + (body.match(/<img\b/gi) || []).length;
	const inlineSvg = (body.match(/<svg\b/gi) || []).length;
	const mermaid = (body.match(/^```mermaid\b/gm) || []).length;

	if (!/^[^\s/\\]+$/.test(slug)) {
		fail("结构", `slug 不合法：${slug}`, "只写一段，不含空格和路径分隔符");
	}
	const dir = path.join(WORK, slug);
	assertWritable(dir);
	fs.mkdirSync(dir, { recursive: true });

	const lines = [
		"---",
		`title: ${JSON.stringify(title)}`,
		...(cover ? [`cover: ${JSON.stringify(cover)}`] : []),
		`author: ${AUTHOR}`,
		...(sourceUrl ? [`source_url: ${JSON.stringify(sourceUrl)}`] : []),
		"---",
		"",
		body.trimStart(),
	];
	fs.writeFileSync(path.join(dir, "article.md"), lines.join("\n"), "utf8");
	const frontmatterLines = fm ? fm[0].split(/\r?\n/).length - 1 : 0;
	writeJson(path.join(dir, "layout.json"), {
		source: sourceRel.split(path.sep).join("/"),
		mappings: expanded.mappings.map(({ line, rule }) => ({
			line: line + frontmatterLines,
			rule,
		})),
	});
	writeJson(path.join(dir, "meta.json"), {
		source: abs,
		title,
		cover,
		images,
		inlineSvg,
		mermaid,
	});

	return { abs, dir, slug, title, cover, headBase, summary, book, sourceUrl, images, inlineSvg, mermaid };
}

/** 书稿第三层用书名：content/books/<name>/ 下的文章读 content/books/<name>.md 的 title */
function bookTitleOf(abs) {
	if (!BLOG_ROOT) return "";
	const rel = path.relative(path.join(BLOG_ROOT, "content", "books"), abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return "";
	const name = rel.split(path.sep)[0];
	const index = path.join(BLOG_ROOT, "content", "books", `${name}.md`);
	if (!fs.existsSync(index)) return "";
	const fm = fs.readFileSync(index, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return fm ? (parseFrontmatter(fm[1]).title || "").trim() : "";
}


/**
 * CSS 内联引擎有时会给 svg 补一条 `height: auto`，它会压住 height 属性，
 * 也会压住 SMIL 对 height 的动画。带长度 height 的 svg 必须把 CSS height 去掉。
 * 长度可以是纯数字、px、vw 或百分比——折叠块用的是 vw。
 */
function restoreSvgHeight(html) {
	return html.replace(/<svg\b[^>]*>/gi, (tag) => {
		if (!/\bheight="(?:\d+(?:\.\d+)?(?:px|vw|%)?)"/i.test(tag)) return tag;
		const style = tag.match(/\bstyle="([^"]*)"/i);
		if (!style) return tag;
		const kept = style[1]
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part && !/^height\s*:/i.test(part));
		return tag.replace(style[0], `style="${kept.join("; ")}"`);
	});
}

/**
 * 微信拒收草稿里的站内相对链接（45166 invalid content）。
 * 站点域名优先读 WECHAT_SITE_URL；只有设了 BLOG_ROOT 才回退到它的 siteConfig.ts。
 * 两者都没有时返回空串，站内链接会在 checkLinkForms 里被拦下并提示。
 */
function siteUrl() {
	if (process.env.WECHAT_SITE_URL) return process.env.WECHAT_SITE_URL.replace(/\/+$/, "");
	if (!BLOG_ROOT) return "";
	const file = path.join(BLOG_ROOT, "src", "config", "siteConfig.ts");
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
	const matched = text.match(/^\s*site_url:\s*["']([^"']+)["']/m);
	return matched ? matched[1].replace(/\/+$/, "") : "";
}

/** 只处理 <a href="/...">：绝对地址、协议相对地址、锚点、mailto 都不动。 */
function absolutizeLinks(html, siteUrl) {
	return html.replace(
		/(<a\b[^>]*?\bhref\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
		(_, head, quote, rest) => `${head}${quote}${siteUrl}/${rest}${quote}`,
	);
}

/**
 * 实测微信 draft/add：href="/..."、href="#锚点"、mp.weixin.qq.com 都会 45166，必须本地拦下。
 * 其余非标准形态（无前导斜杠的相对路径、//host、javascript:、空 href）能提交，
 * 但微信保存时会剥成纯文字，因此只提示、不阻断。
 */
function checkLinkForms(html) {
	const fatal = [];
	const soft = [];
	for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi)) {
		const href = m[2].trim();
		if (/^https?:\/\//i.test(href)) {
			if (/^https?:\/\/mp\.weixin\.qq\.com(\/|$)/i.test(href)) {
				fatal.push([href, "公众号文章地址会返回 45166"]);
			}
			continue;
		}
		if (/^(mailto:|tel:)/i.test(href)) continue;
		if (href.startsWith("#")) {
			fatal.push([href, "锚点会返回 45166"]);
		} else if (href.startsWith("/")) {
			fatal.push([href, "站内相对地址没有被补成绝对地址"]);
		} else {
			soft.push(href || "(空 href)");
		}
	}
	if (fatal.length) {
		const list = fatal
			.slice(0, 5)
			.map(([href, why]) => `${href}（${why}）`)
			.join("；");
		fail(
			"结构",
			`链接形态微信不接受：${list}`,
			"外链写 https:// 完整地址；站内链接要先设 WECHAT_SITE_URL；不要写 #锚点 或 mp.weixin.qq.com 地址",
		);
	}
	if (soft.length) {
		console.error(
			`提示：微信会把以下链接剥成纯文字，读者无法点击：${soft.slice(0, 5).join("；")}`,
		);
	}
}

// 自研轻量内联渲染器：原生 MarkdownIt + Juice，无需外部 CLI 子进程
function renderArticle(built) {
	const mdPath = path.join(built.dir, "article.md");
	if (!fs.existsSync(mdPath)) {
		fail("结构", `文章源文件不存在：${mdPath}`, "请检查生成流程");
	}
	const mdContent = fs.readFileSync(mdPath, "utf8");
	const rawHtml = md.render(mdContent);
	const themeCss = fs.existsSync(THEME) ? fs.readFileSync(THEME, "utf8") : "";

	// 注入根容器并执行样式内联
	const wrappedHtml = `<section class="wx-article-root" id="wx-article">\n${rawHtml}\n</section>`;
	let inlinedHtml = wrappedHtml;
	try {
		inlinedHtml = juice.inlineContent(wrappedHtml, themeCss, {
			inlinePseudoElements: false,
			preserveImportant: true,
		});
	} catch (e) {
		fail("结构", `CSS 样式内联失败：${e.message}`, "请检查 theme.css 语法规范");
	}

	mark("inline-render");
	const site = siteUrl();
	const html = site ? absolutizeLinks(restoreSvgHeight(inlinedHtml), site) : restoreSvgHeight(inlinedHtml);
	checkLinkForms(html);
	fs.writeFileSync(path.join(built.dir, "body.html"), html, "utf8");
	mark("svg-fix-write");
	return html;
}

// ---------- 头图：底图 + 由页面排上去的文字 ----------

const HEAD_W = 1800;
const HEAD_H = 766;

const esc = (s) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CHROME_CANDIDATES =
	process.platform === "win32"
		? [
				"C:/Program Files/Google/Chrome/Application/chrome.exe",
				"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
			]
		: process.platform === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
			: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

function chromePath() {
	const pinned = process.env.WECHAT_CHROME;
	if (pinned) return fs.existsSync(pinned) ? pinned : "";
	return CHROME_CANDIDATES.find((file) => fs.existsSync(file)) || "";
}

async function localizeBase(base, dir) {
	if (!/^https?:/i.test(base)) return base;
	const res = await fetch(base);
	if (!res.ok) fail("图片", `头图底图下载失败 HTTP ${res.status}`, base);
	const file = path.join(dir, "head-base.jpg");
	fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	return file;
}

/**
 * 站点头图规格搬到 1800×766：四边安全区各 8%，压 58% 墨青保证白字可读，文字只占左侧。
 * 标题超长先缩字号（79 → 34px），仍放不下再截断到三行；摘要超长由页面自然折行。
 */
function headHtml(base, { title, summary, book }) {
	const pad = Math.round(HEAD_W * 0.08);
	const unit = (v) => Math.round(HEAD_W * v);
	return `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${HEAD_W}px;height:${HEAD_H}px;overflow:hidden}
.cover{position:relative;width:${HEAD_W}px;height:${HEAD_H}px;overflow:hidden;background:#007275}
.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0;background:rgba(0,114,117,.58)}
.safe{position:absolute;inset:0;padding:${pad}px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;color:#fff}
.stack{display:flex;flex-direction:column;gap:${unit(0.022)}px;max-width:76%}
.title{margin:0;font-family:"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;font-weight:700;font-size:${unit(0.044)}px;line-height:1.15;letter-spacing:-0.02em;text-wrap:balance}
.summary{display:flex;align-items:flex-start;gap:${unit(0.016)}px}
.rule{flex:none;width:${unit(0.045)}px;height:1px;margin-top:.85em;background:rgba(255,255,255,.45)}
.summary p{margin:0;font-family:"Noto Serif CJK SC","Songti SC",serif;font-size:${unit(0.0215)}px;line-height:1.6}
.book{margin:0;padding-top:${unit(0.016)}px;border-top:1px solid rgba(255,255,255,.32);font-family:"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;font-size:${unit(0.02)}px;line-height:1.2;letter-spacing:.18em}
</style></head><body>
<div class="cover"><img class="bg" src="${pathToFileURL(base).href}" alt="">
<div class="shade"></div>
<div class="safe"><div class="stack"><p class="title" id="t">${esc(title)}</p>${
		summary ? `\n<div class="summary"><span class="rule"></span><p>${esc(summary)}</p></div>` : ""
	}</div>${book ? `<p class="book" id="b">${esc(book)}</p>` : ""}</div></div>
<script>
const safe = document.querySelector(".safe");
const stack = document.querySelector(".stack");
const title = document.getElementById("t");
const bookEl = document.getElementById("b");
const pad = parseFloat(getComputedStyle(safe).paddingTop);
const avail = safe.clientHeight - pad * 2 - (bookEl ? bookEl.offsetHeight + 20 : 0);
let size = parseFloat(getComputedStyle(title).fontSize);
while (stack.scrollHeight > avail && size > 34) {
	size -= 2;
	title.style.fontSize = size + "px";
}
if (stack.scrollHeight > avail) {
	title.style.display = "-webkit-box";
	title.style.webkitLineClamp = "3";
	title.style.overflow = "hidden";
}
document.documentElement.dataset.headSize = String(Math.round(size));
</script></body></html>`;
}

async function buildHeadImage(built) {
	const tplChoice = (process.env.WECHAT_COVER_TEMPLATE || "c").toLowerCase();
	const tplName = tplChoice === "b" ? "template-b.html" : tplChoice === "c" ? "template-c.html" : "template-a.html";
	const tplPath = path.join(SKILL_DIR, "templates", tplName);

	const tag = (built.tags && built.tags[0]) || (built.category) || "ESSAY · 观点";
	const now = new Date();
	const issueDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}`;
	const issue = `ISSUE // ${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

	const siteStats = getSiteStats(BLOG_ROOT);
	let html = "";
	if (fs.existsSync(tplPath)) {
		html = fs.readFileSync(tplPath, "utf8")
			.replaceAll("{{TITLE}}", esc(built.title))
			.replaceAll("{{TAG}}", esc(tag))
			.replaceAll("{{ISSUE}}", esc(issue))
			.replaceAll("{{ISSUE_DATE}}", esc(issueDate))
			.replaceAll("{{WORD_COUNT_LABEL}}", esc(siteStats.wordCountLabel))
			.replaceAll("{{STATUS_LABEL}}", esc(siteStats.statusLabel));
	} else {
		const base = await localizeBase(built.headBase, built.dir);
		html = headHtml(base, built);
	}

	const htmlPath = path.join(built.dir, "head.html");
	const pngPath = path.join(built.dir, "head-1800x766.png");
	fs.writeFileSync(htmlPath, html, "utf8");

	const chrome = chromePath();
	if (!chrome) {
		fail("结构", "找不到 Chrome，无法生成头图", "安装 Chrome，或用 WECHAT_CHROME 指向可执行文件");
	}
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-head-"));
	const run = spawnSync(
		chrome,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--hide-scrollbars",
			"--force-device-scale-factor=1",
			`--window-size=${HEAD_W},${HEAD_H}`,
			"--virtual-time-budget=5000",
			`--user-data-dir=${profile}`,
			`--screenshot=${pngPath}`,
			pathToFileURL(htmlPath).href,
		],
		{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	);
	fs.rmSync(profile, { recursive: true, force: true });

	if (!fs.existsSync(pngPath)) {
		const tail = (run.stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
		fail("结构", "头图没有生成", tail || "检查 Chrome 是否可执行");
	}
	// 自动裁剪 1:1 正方形头图（聚焦右侧规格数据卡片与水印，尺寸 500x500）
	const squarePngPath = path.join(built.dir, "head-square-500x500.png");
	const squareStdPath = path.join(built.dir, "head-square.png");
	try {
		spawnSync("python3", [
			"-c",
			`from PIL import Image; im = Image.open('${pngPath}'); crop = im.crop((1280, 50, 1780, 550)); crop.save('${squarePngPath}'); crop.save('${squareStdPath}')`
		]);
	} catch (e) {
		console.error("生成正方形头图失败:", e);
	}

	return pngPath;
}

// ---------- 凭证 ----------

function loadCredentials() {
	let appId = process.env.WECHAT_APP_ID || "";
	let secret = process.env.WECHAT_APP_SECRET || "";
	if (appId && secret) return { appId, secret };

	const files = [
		process.env.WECHAT_CREDENTIALS,
		path.join(SKILL_DIR, ".env"),
		path.join(SKILL_DIR, "credentials"),
		path.join(os.homedir(), ".config", "wechat", "credentials"),
	].filter(Boolean);
	for (const file of files) {
		if (!fs.existsSync(file)) continue;
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
			if (!m) continue;
			const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
			if (m[1] === "WECHAT_APP_ID") appId ||= value;
			if (m[1] === "WECHAT_APP_SECRET") secret ||= value;
		}
		if (appId && secret) break;
	}
	if (!appId || !secret) {
		fail(
			"凭证",
			"没有读到 AppID / AppSecret",
			`把凭证写入 ${path.join(SKILL_DIR, "credentials")} 后重跑`,
		);
	}
	return { appId, secret };
}

function wechatError(data, stage) {
	const code = data.errcode;
	const msg = data.errmsg || "";

	if (code === 40164 || /whitelist|invalid ip/i.test(msg)) {
		return new PublishError(
			"白名单",
			`${code} ${msg}`,
			"把当前出口 IP 加入公众号后台「设置与开发 → 基本配置 → IP 白名单」",
		);
	}
	if ([40001, 40013, 40125, 41002, 41004, 42001, 48001].includes(code)) {
		return new PublishError(
			"凭证",
			`${code} ${msg}`,
			"核对 AppID / AppSecret；48001 表示账号未认证或没有草稿箱 / 素材库权限",
		);
	}
	if ([40004, 40005, 40006, 40007, 40009, 40113, 41005, 45001, 45110].includes(code)) {
		return new PublishError(
			"图片",
			`${code} ${msg}`,
			"图片需 JPG / PNG、≤10MB，且 media_id 仍有效",
		);
	}
	if ([44002, 44003, 45002, 45003, 45004, 45166].includes(code)) {
		return new PublishError(
			"结构",
			`${code} ${msg}`,
			"检查标题长度、正文是否为空或超长、media_id 是否失效",
		);
	}
	if ([45009, 45011].includes(code)) {
		return new PublishError("网络", `${code} ${msg}`, "接口频率超限，等几分钟再重试");
	}
	const kind = stage === "token" ? "凭证" : stage === "image" ? "图片" : "结构";
	return new PublishError(kind, `${code} ${msg}`, "按 errcode 查微信官方文档");
}

async function wechatRequest(url, init, stage) {
	let res;
	try {
		res = await fetch(url, init);
	} catch (error) {
		fail("网络", `请求微信接口失败：${error.message}`, "确认本机可访问 api.weixin.qq.com");
	}

	const text = await res.text();
	if (!res.ok) {
		const kind = stage === "token" ? "凭证" : stage === "image" ? "图片" : "结构";
		fail(kind, `HTTP ${res.status} ${res.statusText}：${text.slice(0, 200)}`, "重试一次；持续失败再排查");
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch {
		fail("结构", `微信接口返回的不是 JSON：${text.slice(0, 200)}`, "通常是网关 / 代理拦截，检查出口网络");
	}
	return data;
}

async function getToken(appId, secret) {
	const data = await wechatRequest(
		`${API}/stable_token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "client_credential",
				appid: appId,
				secret,
				force_refresh: false,
			}),
		},
		"token",
	);
	if (data.errcode) throw wechatError(data, "token");
	if (!data.access_token) {
		fail("凭证", "token 接口没有返回 access_token", "确认账号已认证、接口权限已开通");
	}
	return data.access_token;
}

// ---------- 图片 ----------

function sniffMime(buffer) {
	const head = buffer.subarray(0, 12);
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.subarray(0, 3).toString() === "GIF") return "image/gif";
	if (head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") {
		return "image/webp";
	}
	return "";
}

const EXT_BY_MIME = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif" };

function mimeOf(name, buffer) {
	const sniff = sniffMime(buffer);
	if (sniff === "image/webp") {
		fail("图片", `${name} 是 WebP`, "微信不收 WebP，先导出 JPG / PNG");
	}
	if (sniff) return sniff;

	const ext = path.extname(name).toLowerCase();
	if (ext === ".webp") {
		fail("图片", `${name} 是 WebP`, "微信不收 WebP，先导出 JPG / PNG");
	}
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".gif") return "image/gif";
	return "";
}

async function uploadImage(buffer, name, token, cache, stats) {
	const hash = crypto.createHash("md5").update(buffer).digest("hex");
	if (cache[hash]) {
		stats.cached++;
		return cache[hash];
	}

	const base = path.basename(name);
	const type = mimeOf(base, buffer);
	if (!type) fail("图片", `不支持的图片类型：${base}`, "只支持 JPG / PNG / GIF");
	if (buffer.length === 0) fail("图片", `图片是空文件：${base}`, "重新导出这张图");
	if (buffer.length > 10 * 1024 * 1024) {
		fail("图片", `${base} ${(buffer.length / 1048576).toFixed(1)}MB，超过 10MB`, "压到 10MB 以内再发");
	}

	// 文件名后缀跟真实类型对齐，避免微信按后缀判类型时误杀
	const filename = `${path.parse(base).name || "image"}${EXT_BY_MIME[type] || path.extname(base)}`;
	const form = new FormData();
	form.append("media", new Blob([buffer], { type }), filename);
	const data = await wechatRequest(
		`${API}/material/add_material?access_token=${token}&type=image`,
		{ method: "POST", body: form },
		"image",
	);
	if (data.errcode) throw wechatError(data, "image");
	if (!data.media_id || !data.url) {
		fail("图片", `上传 ${base} 没有拿到 media_id / url`, "重试一次；仍失败检查素材库权限");
	}

	const entry = {
		media_id: data.media_id,
		url: data.url.replace(/^http:\/\//i, "https://"),
		size: buffer.length,
	};
	cache[hash] = entry;
	stats.uploaded++;
	return entry;
}

async function readImage(src, sourcePath) {
	if (/^data:/i.test(src)) {
		fail("图片", "正文里有 data: 内联图片", "先存成文件，再用相对 / 绝对路径引用");
	}

	if (/^https?:\/\//i.test(src)) {
		let res;
		try {
			res = await fetch(src);
		} catch (error) {
			fail("图片", `外链图片下载失败：${src}`, error.message);
		}
		if (!res.ok) {
			fail("图片", `外链图片下载失败 HTTP ${res.status}：${src}`, "确认外链可公开访问，或先下载到本地");
		}
		let name = "image.jpg";
		try {
			name = path.basename(decodeURIComponent(new URL(src).pathname)) || name;
		} catch {
			// 极少数 URL 解析不了，用默认名，类型由内容嗅探决定
		}
		if (!path.extname(name)) name = `${name}.jpg`;
		return { buffer: Buffer.from(await res.arrayBuffer()), name };
	}

	let decoded = src;
	try {
		decoded = decodeURIComponent(src);
	} catch {
		// 保持原样，下面按原字符串找文件
	}
	const local = path.isAbsolute(decoded)
		? decoded
		: path.resolve(path.dirname(sourcePath), decoded);
	if (!fs.existsSync(local)) {
		fail("图片", `找不到图片：${src}`, `期望路径 ${local}`);
	}
	return { buffer: fs.readFileSync(local), name: path.basename(local) };
}

async function inlineImages(html, sourcePath, token, cache, stats) {
	const attr = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi;
	const sources = new Set();
	for (const m of html.matchAll(attr)) sources.add(m[3]);
	if (sources.size === 0) return { html, firstMediaId: "" };

	const mapping = new Map();
	let firstMediaId = "";
	for (const src of sources) {
		if (/^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(src)) continue;
		const { buffer, name } = await readImage(src, sourcePath);
		const uploaded = await uploadImage(buffer, name, token, cache, stats);
		mapping.set(src, uploaded.url);
		if (!firstMediaId) firstMediaId = uploaded.media_id;
	}

	let output = html;
	for (const [from, to] of mapping) output = output.split(from).join(to);
	return { html: output, firstMediaId };
}

// ---------- 草稿 ----------

async function push(built, html, credentials) {
	const { appId, secret } = credentials;
	const token = await getToken(appId, secret);
	mark("token");

	const uploads = readJson(UPLOADS, {});
	const stats = { uploaded: 0, cached: 0 };
	const { html: content } = await inlineImages(html, built.abs, token, uploads, stats);
	mark("body-images");

	// 封面固定是合成出来的头图：底图 + 页面排上去的文字
	const head = await buildHeadImage(built);
	mark("head-image");
	const { buffer, name } = await readImage(head, built.abs);
	const thumbImage = await uploadImage(buffer, name, token, uploads, stats);
	const thumb = thumbImage.media_id;
	writeJson(UPLOADS, uploads);
	mark("cover");

	const article = {
		title: built.title,
		author: AUTHOR,
		content,
		content_source_url: built.sourceUrl || "",
		thumb_media_id: thumb,
		need_open_comment: 0,
		only_fans_can_comment: 0,
		pic_crop_1_1: "0.711111_0.065274_0.988889_0.718016",
		pic_crop_235_1: "0_0_1_1",
	};

	const drafts = readJson(DRAFTS, {});
	const previous = drafts[built.slug]?.media_id;
	let mode = "新建";

	if (previous) {
		const res = await wechatRequest(
			`${API}/draft/update?access_token=${token}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ media_id: previous, index: 0, articles: article }),
			},
			"draft",
		);
		if (!res.errcode) {
			mode = "更新";
			drafts[built.slug] = {
				media_id: previous,
				title: built.title,
				updated_at: new Date().toISOString(),
			};
			writeJson(DRAFTS, drafts);
		} else if (res.errcode !== 40007) {
			throw wechatError(res, "draft");
		} else {
			console.error("旧 media_id 已失效（草稿被删？），改为新建。");
		}
	}

	if (mode === "新建") {
		const res = await wechatRequest(
			`${API}/draft/add?access_token=${token}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ articles: [article] }),
			},
			"draft",
		);
		if (res.errcode) throw wechatError(res, "draft");
		drafts[built.slug] = {
			media_id: res.media_id,
			title: built.title,
			updated_at: new Date().toISOString(),
		};
		writeJson(DRAFTS, drafts);
	}
	mark("draft");

	const mediaId = drafts[built.slug]?.media_id || previous;
	console.log(`已${mode}草稿（未群发）`);
	console.log(`  标题：${built.title}`);
	console.log(`  原文：${built.sourceUrl || '(未设置)'}`);
	console.log(`  media_id：${mediaId}`);
	console.log(`  图片：新上传 ${stats.uploaded} / 复用 ${stats.cached}（已换成微信地址）`);
	console.log(`  草稿箱：https://mp.weixin.qq.com/`);
}

// ---------- 入口 ----------

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];
	const rest = args.slice(1);
	const sourceUrl = rest.includes("--source-url")
		? rest[rest.indexOf("--source-url") + 1] || ""
		: "";
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--source-url") {
			i++;
			continue;
		}
		if (!rest[i].startsWith("--")) positional.push(rest[i]);
	}
	const source = positional[0] || "";

	if (!command || !["gen", "push"].includes(command) || !source) {
		console.error(
			"usage: wechat.mjs <gen|push> <文章.md> [--source-url URL] [--timing]\n" +
				"  gen   按固定形态生成内联 HTML 和 layout.json，不联网\n" +
				"  push  生成 + 换图片地址 + 新建/更新草稿\n" +
				"  --timing  把每个阶段耗时打到 stderr",
		);
		process.exit(64);
	}

	const built = buildArticle(source, sourceUrl);
	mark("build");
	// 凭证在渲染前读，配错时不用等一次渲染
	const credentials = command === "push" ? loadCredentials() : null;
	mark("credentials");
	const html = renderArticle(built);

	if (command === "gen") {
		console.log("已生成（未联网、未上传）");
		console.log(`  标题：${built.title}`);
		console.log(`  body.html：${path.join(built.dir, "body.html")}`);
		console.log(`  layout.json：${path.join(built.dir, "layout.json")}`);
		console.log(
			`  封面：${built.cover || "无"} · 正文图片 ${built.images} · SVG ${built.inlineSvg} · Mermaid ${built.mermaid}`,
		);
		printTiming("gen");
		return;
	}

	await push(built, html, credentials);
	printTiming("push");
}

main().catch((error) => {
	if (error instanceof PublishError) {
		console.error(`\n失败（${error.kind}）：${error.message}`);
		if (error.hint) console.error(`  处理：${error.hint}`);
		process.exit(EXIT_CODES[error.kind] || 1);
	}
	console.error(`\n失败（其他）：${error.stack || error.message}`);
	process.exit(1);
});

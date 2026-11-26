/**
 * 样式库 · 双层 SVG 半透明渐隐预览折叠块（用于 ::: details [标题] ... :::）
 * 外层无 viewBox 动画 + 内层固定比例 + focusin/focusout 双热区，不弹窗不缩放。
 * 支持可选折叠标题行 + 表格自动降级清洗，杜绝 Markdown 管道符乱码。
 */
import { xml } from "./cards.mjs";

const SVG_STYLE = {
	viewBoxWidth: 686,
	charsPerLine: 24,
	titleFontSize: 27,
	bodyFontSize: 25,
	lineHeight: 42,
	previewVisibleLines: 3,
	blockRadius: "6px",
	colors: {
		paper: "#f5f7f7",
		ink: "#111819",
		accent: "#007275",
		muted: "#5d6667",
		rule: "#c7d1d1",
	},
	sans: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
};

const NO_LINE_START = "，。、；：？！）」』】》”’%";
const charWidth = (ch) => (/[\x00-\xff]/.test(ch) ? 0.52 : 1);

function wrapLines(text, maxChars) {
	const lines = [];
	let line = "";
	let width = 0;
	for (const ch of [...text]) {
		if (width + charWidth(ch) > maxChars && line && !NO_LINE_START.includes(ch)) {
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

/** 折叠块内正文清洗：自动降级 Markdown 表格、去掉代码围栏反引号、保留缩进、链接降级 */
function cleanBodyLines(body, maxChars) {
	const rawLines = body.split(/\r?\n/);
	const processed = [];
	let inFence = false;
	let tableHeaders = null;

	for (const raw of rawLines) {
		const trimmed = raw.trim();
		const fence = trimmed.match(/^```([A-Za-z0-9_-]*)/);
		if (fence) {
			inFence = !inFence;
			if (inFence && fence[1]) {
				processed.push(`[${fence[1].toUpperCase()} 代码]`);
			}
			continue;
		}
		if (/^---+$/.test(trimmed)) continue;

		// Markdown 表格自动降级：把 | col1 | col2 | 转成可读条目，彻底消除管道符乱码
		if (!inFence && /^\|.*\|$/.test(trimmed)) {
			const cells = trimmed
				.slice(1, -1)
				.split("|")
				.map((c) =>
					c
						.replace(/<br\s*\/?>/gi, " ")
						.replace(/\*\*(.+?)\*\*/g, "$1")
						.replace(/\*(.+?)\*/g, "$1")
						.replace(/`([^`]*)`/g, "$1")
						.replace(/\s+/g, " ")
						.trim(),
				);
			if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
			if (!tableHeaders) {
				tableHeaders = cells;
				continue;
			}
			const lead = cells[0] || "";
			const rest = cells
				.slice(1)
				.map((val, idx) => (val ? `${tableHeaders[idx + 1] ? `${tableHeaders[idx + 1]}：` : ""}${val}` : ""))
				.filter(Boolean)
				.join("；");
			if (lead || rest) processed.push(`▪ ${lead}${rest ? ` — ${rest}` : ""}`);
			continue;
		} else {
			tableHeaders = null;
		}

		const cleaned = (inFence ? raw : trimmed)
			.replace(/^#{1,6}\s+/, "")
			.replace(/^>\s?/, "")
			.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
				text.trim() === url.trim() ? url.trim() : `${text.trim()}（${url.trim()}）`,
			)
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/`([^`]*)`/g, "$1");
		if (cleaned.trim()) processed.push(cleaned);
	}
	return processed.flatMap((line) => wrapLines(line, maxChars));
}

export function renderSvgFold(body, fail, title = "") {
	const cfg = SVG_STYLE;
	const c = cfg.colors;
	const W = cfg.viewBoxWidth;
	const lh = cfg.lineHeight;
	const lines = cleanBodyLines(body, cfg.charsPerLine);
	if (!lines.length) fail("结构", "details 折叠块没有正文", "在 ::: details 下补充内容");

	const cleanTitle = String(title || "").replace(/[：:]\s*$/, "").trim();
	const hasTitle = Boolean(cleanTitle);
	const firstY = hasTitle ? 104 : 48;
	const visibleCount = Math.min(lines.length, cfg.previewVisibleLines);
	const collapsedH = hasTitle
		? 82 + visibleCount * lh + 18
		: 26 + visibleCount * lh + 20;
	const maskTop = Math.max(hasTitle ? 120 : 40, collapsedH - 72);
	const viewBoxH = firstY + (lines.length - 1) * lh + 32;
	const expandedVw = ((viewBoxH / W) * 100 * 0.92).toFixed(1);
	const collapsedVw = ((Math.min(collapsedH, viewBoxH) / W) * 100 * 0.92).toFixed(1);

	const titleBlock = hasTitle
		? `<rect x="0" y="0" width="${W}" height="64" fill="#eef4f4"></rect>
    <line x1="0" y1="64" x2="${W}" y2="64" stroke="${c.rule}" stroke-width="1"></line>
    <text x="24" y="42" font-size="${cfg.titleFontSize}" font-weight="700" fill="${c.ink}" font-family="${cfg.sans}">${xml(cleanTitle.slice(0, 20))}</text>
    <text x="${W - 24}" y="40" font-size="20" font-weight="600" fill="${c.accent}" text-anchor="end" font-family="${cfg.sans}">点击展开 ↓</text>`
		: "";

	const previewOverlay = `
    <g opacity="1">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.2s" fill="freeze" restart="whenNotActive"></animate>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.2s" fill="freeze" restart="whenNotActive"></animate>
      <rect x="0" y="${maskTop}" width="${W}" height="34" fill="${c.paper}" fill-opacity="0.48"></rect>
      <rect x="0" y="${maskTop + 34}" width="${W}" height="52" fill="${c.paper}" fill-opacity="0.90"></rect>
    </g>`;

	const bodyLines = lines
		.map(
			(line, idx) =>
				`<text x="24" y="${firstY + idx * lh}" font-size="${cfg.bodyFontSize}" fill="${c.ink}" font-family="${cfg.sans}">${xml(line)}</text>`,
		)
		.join("\n");

	const html = `<section style="margin:16px 0;border:1px solid ${c.rule};border-radius:${cfg.blockRadius};overflow:hidden;background:${c.paper};">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${collapsedVw}vw">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${collapsedVw}vw;${expandedVw}vw" dur="0.26s" fill="freeze" restart="whenNotActive"></animate>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${expandedVw}vw;${collapsedVw}vw" dur="0.22s" fill="freeze" restart="whenNotActive"></animate>
  <svg class="wx-fold-inner" x="0" y="0" width="100%" height="${expandedVw}vw" viewBox="0 0 ${W} ${viewBoxH}" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${viewBoxH}" fill="${c.paper}"></rect>
    ${titleBlock}
    ${bodyLines}
    ${previewOverlay}
  </svg>
</svg>
<p class="wx-fold-hint"><span class="wx-fold-btn" tabindex="0"><span leaf="">点击收起 ↑</span></span></p>
</section>`;

	return html
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.join("\n");
}

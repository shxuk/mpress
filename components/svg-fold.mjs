/**
 * 样式库 · 双层 SVG 半透明渐隐预览折叠块（用于 ::: details ... :::）
 * 外层无 viewBox 动画 + 内层固定比例 + focusin/focusout 双热区，不弹窗不缩放。
 * 无第 1 行重复顶栏，整块 SVG 为展开热区，右下角小按钮独占收起热区。
 */
import { xml } from "./cards.mjs";

const SVG_STYLE = {
	viewBoxWidth: 686,
	charsPerLine: 23,
	bodyFontSize: 26,
	lineHeight: 42,
	previewVisibleLines: 4,
	blockRadius: "6px",
	colors: {
		paper: "#f5f7f7",
		ink: "#111819",
		rule: "#c7d1d1",
	},
	sans: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
};

const NO_LINE_START = "，。、；：？！）」』】》”’%";
const charWidth = (ch) => (/[\x00-\xff]/.test(ch) ? 0.5 : 1);

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

/** 折叠块内正文清洗：去掉代码围栏反引号行、保留缩进、链接降级为「文字（地址）」 */
function cleanBodyLines(body, maxChars) {
	const rawLines = body.split(/\r?\n/);
	const processed = [];
	let inFence = false;
	for (const raw of rawLines) {
		const fence = raw.trim().match(/^```([A-Za-z0-9_-]*)/);
		if (fence) {
			inFence = !inFence;
			if (inFence && fence[1]) {
				processed.push(`[${fence[1].toUpperCase()} 代码]`);
			}
			continue;
		}
		if (/^---+$/.test(raw.trim())) continue;
		const cleaned = (inFence ? raw : raw.trim())
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

export function renderSvgFold(body, fail) {
	const cfg = SVG_STYLE;
	const c = cfg.colors;
	const W = cfg.viewBoxWidth;
	const lh = cfg.lineHeight;
	const lines = cleanBodyLines(body, cfg.charsPerLine);
	if (!lines.length) fail("结构", "details 折叠块没有正文", "在 ::: details 下补充内容");

	const firstY = 48;
	const visibleCount = Math.min(lines.length, cfg.previewVisibleLines);
	const collapsedH = 26 + visibleCount * lh + 20;
	const maskTop = Math.max(40, collapsedH - 84);
	const viewBoxH = firstY + (lines.length - 1) * lh + 30;
	const expandedVw = ((viewBoxH / W) * 100 * 0.92).toFixed(1);
	const collapsedVw = ((Math.min(collapsedH, viewBoxH) / W) * 100 * 0.92).toFixed(1);

	const previewOverlay = `
    <g opacity="1">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.2s" fill="freeze" restart="whenNotActive"></animate>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.2s" fill="freeze" restart="whenNotActive"></animate>
      <rect x="0" y="${maskTop}" width="${W}" height="34" fill="${c.paper}" fill-opacity="0.45"></rect>
      <rect x="0" y="${maskTop + 34}" width="${W}" height="52" fill="${c.paper}" fill-opacity="0.88"></rect>
    </g>`;

	const bodyLines = lines
		.map(
			(line, idx) =>
				`<text x="24" y="${firstY + idx * lh}" font-size="${cfg.bodyFontSize}" fill="${c.ink}" font-family="${cfg.sans}">${xml(line)}</text>`,
		)
		.join("\n");

	const html = `<section style="margin:24px 0;border:1px solid ${c.rule};border-radius:${cfg.blockRadius};overflow:hidden;background:${c.paper};">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${collapsedVw}vw">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${collapsedVw}vw;${expandedVw}vw" dur="0.26s" fill="freeze" restart="whenNotActive"></animate>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${expandedVw}vw;${collapsedVw}vw" dur="0.22s" fill="freeze" restart="whenNotActive"></animate>
  <svg class="wx-fold-inner" x="0" y="0" width="100%" height="${expandedVw}vw" viewBox="0 0 ${W} ${viewBoxH}" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${viewBoxH}" fill="${c.paper}"></rect>
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

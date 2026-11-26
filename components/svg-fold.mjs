/**
 * 样式库 · 极致紧凑型 SVG + foreignObject 图文渐隐折叠组件（对齐博客 div.custom-details-content）
 * 特点：
 * 1. 去掉冗余顶栏与底部文字按钮，纯透明渐隐截断预览；
 * 2. 紧凑内边距（12px），图片几乎占满容器左右全宽；
 * 3. 如有可选标题，直接作为首行加粗放入内容区；
 * 4. 整个组件上下热区全透明：点击展开，点击下半部分透明热区或外部即收起。
 */
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { cjkStrong, xml } from "./cards.mjs";

const foldMd = new MarkdownIt({ html: true, breaks: true, linkify: false });

let foldCounter = 0;

/** 从本地 PNG / JPEG / GIF 文件头部读取真实像素宽高（零依赖） */
function getImageDimensions(src, baseDir = process.cwd()) {
	try {
		if (/^https?:/i.test(src)) return null;
		const fullPath = path.isAbsolute(src) ? src : path.resolve(baseDir, src);
		if (!fs.existsSync(fullPath)) return null;
		const buf = fs.readFileSync(fullPath);
		if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
			return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		}
		if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
			return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
		}
		if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
			let offset = 2;
			while (offset < buf.length - 8) {
				if (buf[offset] !== 0xff) break;
				const marker = buf[offset + 1];
				if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
					return {
						height: buf.readUInt16BE(offset + 5),
						width: buf.readUInt16BE(offset + 7),
					};
				}
				const len = buf.readUInt16BE(offset + 2);
				offset += 2 + len;
			}
		}
	} catch {}
	return null;
}

/** 估算内部 HTML 在 390px 手机视口（净宽约 364px）下的渲染总高度（px） */
function estimateContentHeightPx(body, title, baseDir) {
	let px = 24; // 上下 padding: 12px * 2
	if (title) px += 30;

	const lines = body.split(/\r?\n/);
	let inCode = false;
	for (const raw of lines) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			px += 12;
			continue;
		}
		if (!trimmed) {
			px += 6;
			continue;
		}
		const imgMatch = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)/);
		if (!inCode && imgMatch) {
			const dim = getImageDimensions(imgMatch[1], baseDir);
			if (dim && dim.width > 0) {
				// 净宽约 364px，尽量占满左右宽度
				const renderedH = Math.round((364 / dim.width) * dim.height);
				px += renderedH + 10;
			} else {
				px += 260;
			}
			continue;
		}
		// 364px 净宽 / 14.5px 字号 ≈ 24 汉字/行
		const charUnits = [...trimmed].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.55 : 1), 0);
		const wrapCount = Math.max(1, Math.ceil(charUnits / (inCode ? 40 : 24)));
		px += wrapCount * (inCode ? 20 : 24) + 6;
	}
	return Math.max(px + 8, 100);
}

/** 将内部 Markdown 渲染为紧凑内联 div.custom-details-content HTML */
function renderInnerHtml(body, title) {
	const preprocessed = body
		.split(/\r?\n/)
		.map((l) => cjkStrong(l))
		.join("\n");

	let html = foldMd.render(preprocessed);

	html = html
		.replace(/<p>/g, '<p style="margin: 0 0 6px; font-size: 14.5px; line-height: 1.65; color: #111819;">')
		.replace(/<pre><code([^>]*)>/g, '<pre style="margin: 6px 0; padding: 10px 12px; border-radius: 6px; background: #eef2f3; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; color: #111819;"><code$1 style="font-family: inherit; background: transparent; padding: 0;">')
		.replace(/<code>/g, '<code style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; padding: 1px 4px; border-radius: 3px; background: #e8eeee; color: #111819;">')
		.replace(/<img([^>]+)>/g, '<img$1 style="display: block; width: 100%; height: auto; border-radius: 4px; margin: 2px 0;" />')
		.replace(/<ul>/g, '<ul style="margin: 4px 0 8px; padding-left: 1.3em; font-size: 14.5px; line-height: 1.65; color: #111819;">')
		.replace(/<ol>/g, '<ol style="margin: 4px 0 8px; padding-left: 1.3em; font-size: 14.5px; line-height: 1.65; color: #111819;">')
		.replace(/<li>/g, '<li style="margin: 2px 0;">')
		.replace(/<strong>/g, '<strong style="font-weight: 700; color: #111819;">')
		.replace(/<table>/g, '<table style="width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 13px;">')
		.replace(/<th>/g, '<th style="padding: 5px 6px; border: 1px solid #d2dbdb; background: #eef4f4; font-weight: 700; text-align: left;">')
		.replace(/<td>/g, '<td style="padding: 5px 6px; border: 1px solid #d2dbdb;">');

	// 若有标题，不单独占横栏，直接作为容器首行加粗文字
	const titleHtml = title
		? `<p style="margin: 0 0 8px; font-size: 14.5px; line-height: 1.6; font-weight: 700; color: #111819;"><strong>${xml(title)}</strong></p>`
		: "";

	return `<div class="custom-details-content" style="padding: 12px; font-size: 14.5px; line-height: 1.65; color: #111819; background: #fafbfc; box-sizing: border-box;">${titleHtml}${html}</div>`;
}

export function renderSvgFold(body, fail, title = "", baseDir = process.cwd()) {
	const totalPx = estimateContentHeightPx(body, title, baseDir);
	const collapsePx = 175;
	const needsFold = totalPx > collapsePx + 30;

	const collapsedVw = needsFold ? ((collapsePx / 390) * 100).toFixed(1) : ((totalPx / 390) * 100).toFixed(1);
	const expandedVw = ((totalPx / 390) * 100).toFixed(1);

	const innerHtml = renderInnerHtml(body, title);
	const gradId = `wxFoldGrad_${++foldCounter}`;

	// 半透明渐隐矩形覆盖在下半部分，点击后淡出
	const gradientOverlay = needsFold
		? `<g opacity="1" style="pointer-events: none;">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fafbfc" stop-opacity="0"/>
          <stop offset="50%" stop-color="#fafbfc" stop-opacity="0.72"/>
          <stop offset="100%" stop-color="#fafbfc" stop-opacity="0.96"/>
        </linearGradient>
      </defs>
      <rect x="0" y="45%" width="100%" height="55%" fill="url(#${gradId})"/>
    </g>`
		: "";

	// 全透明底部收起热区（无任何文字与边框，点击下半部分即可抢走焦点触发收起）
	const transparentCollapseHotspot = needsFold
		? `<p style="margin: -36px 0 0; padding: 0; height: 36px; background: transparent; position: relative; z-index: 2;"><span class="wx-fold-hotspot" tabindex="0" style="display: block; width: 100%; height: 36px; background: transparent; outline: none; -webkit-tap-highlight-color: transparent;"></span></p>`
		: "";

	return `<section class="custom-details-preview-box" style="margin: 14px 0; border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 8px; background: #fafbfc; overflow: hidden;">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${collapsedVw}vw" style="display: block; width: 100%; max-width: 100%; overflow: hidden; background: #fafbfc; outline: none; -webkit-tap-highlight-color: transparent;">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${collapsedVw}vw;${expandedVw}vw" dur="0.28s" fill="freeze" restart="whenNotActive"/>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${expandedVw}vw;${collapsedVw}vw" dur="0.22s" fill="freeze" restart="whenNotActive"/>
  <foreignObject width="100%" height="100%" x="0" y="0">
    ${innerHtml}
  </foreignObject>
  ${gradientOverlay}
</svg>${transparentCollapseHotspot}
</section>`;
}

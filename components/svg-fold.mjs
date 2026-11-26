/**
 * 样式库 · 双层原生 SVG + foreignObject 图文渐隐折叠组件（统一对齐博客 div.custom-details-content 样式）
 * 外层 SVG 控制 focusin/focusout 高度展开收起动画；
 * 内部通过 <foreignObject> 嵌入原生 HTML <div class="custom-details-content">，完整支持文字、代码、表格与微信图片！
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
		// PNG
		if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
			return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		}
		// GIF
		if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
			return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
		}
		// JPEG
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

/** 估算内部 HTML 在 390px 手机视口（内容净宽约 310px）下的渲染总高度（px） */
function estimateContentHeightPx(body, title, baseDir) {
	let px = 40; // 上下 padding: 20px * 2
	if (title) px += 38; // .custom-details-title-inner + margin-bottom

	const lines = body.split(/\r?\n/);
	let inCode = false;
	for (const raw of lines) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			px += 16;
			continue;
		}
		if (!trimmed) {
			px += 10;
			continue;
		}
		// 匹配图片 ![alt](src)
		const imgMatch = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)/);
		if (!inCode && imgMatch) {
			const dim = getImageDimensions(imgMatch[1], baseDir);
			if (dim && dim.width > 0) {
				// 310px 为 390px 屏幕减去容器内外边距后的净宽
				const renderedH = Math.round((310 / dim.width) * dim.height);
				px += renderedH + 24;
			} else {
				px += 240; // 未知尺寸图片默认高度估算
			}
			continue;
		}
		// 估算文字折行：310px 宽度 / 15px 字号 ≈ 20 汉字/行，line-height: 1.8 (27px)
		const charUnits = [...trimmed].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.55 : 1), 0);
		const wrapCount = Math.max(1, Math.ceil(charUnits / (inCode ? 34 : 20)));
		px += wrapCount * (inCode ? 22 : 27) + 8;
	}
	return Math.max(px + 16, 120);
}

/** 将内部 Markdown 渲染为微信安全的纯内联 div.custom-details-content HTML */
function renderInnerHtml(body, title) {
	const preprocessed = body
		.split(/\r?\n/)
		.map((l) => cjkStrong(l))
		.join("\n");

	let html = foldMd.render(preprocessed);

	// 统一内联基础排版样式（对齐博客 .custom-details-content）
	html = html
		.replace(/<p>/g, '<p style="margin: 0 0 10px; font-size: 15px; line-height: 1.8; color: #111819;">')
		.replace(/<pre><code([^>]*)>/g, '<pre style="margin: 10px 0; padding: 12px 14px; border-radius: 6px; background: #eef2f3; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.6; color: #111819;"><code$1 style="font-family: inherit; background: transparent; padding: 0;">')
		.replace(/<code>/g, '<code style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; padding: 2px 5px; border-radius: 3px; background: #e8eeee; color: #111819;">')
		.replace(/<img([^>]+)>/g, '<img$1 style="display: block; width: 100%; height: auto; border-radius: 6px; margin: 10px 0; border: 1px solid rgba(0,0,0,0.06);" />')
		.replace(/<ul>/g, '<ul style="margin: 6px 0 10px; padding-left: 1.4em; font-size: 15px; line-height: 1.8; color: #111819;">')
		.replace(/<ol>/g, '<ol style="margin: 6px 0 10px; padding-left: 1.4em; font-size: 15px; line-height: 1.8; color: #111819;">')
		.replace(/<li>/g, '<li style="margin: 4px 0;">')
		.replace(/<strong>/g, '<strong style="font-weight: 700; color: #111819;">')
		.replace(/<table>/g, '<table style="width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13.5px;">')
		.replace(/<th>/g, '<th style="padding: 6px 8px; border: 1px solid #d2dbdb; background: #eef4f4; font-weight: 700; text-align: left;">')
		.replace(/<td>/g, '<td style="padding: 6px 8px; border: 1px solid #d2dbdb;">');

	const titleHtml = title
		? `<div class="custom-details-title-inner" style="font-size: 15px; font-weight: 700; color: #111819; margin: 0 0 14px; line-height: 1.5;"><strong>${xml(title)}</strong></div>`
		: "";

	return `<div class="custom-details-content" style="padding: 20px 24px; font-size: 15px; line-height: 1.8; color: #111819; background: #fafbfc; box-sizing: border-box;">${titleHtml}${html}</div>`;
}

export function renderSvgFold(body, fail, title = "", baseDir = process.cwd()) {
	const totalPx = estimateContentHeightPx(body, title, baseDir);
	const collapsePx = 195;
	const needsFold = totalPx > collapsePx + 30;

	// 以 390px 标准手机屏换算 vw 高度
	const collapsedVw = needsFold ? ((collapsePx / 390) * 100).toFixed(1) : ((totalPx / 390) * 100).toFixed(1);
	const expandedVw = ((totalPx / 390) * 100).toFixed(1);

	const innerHtml = renderInnerHtml(body, title);
	const gradId = `wxFoldGrad_${++foldCounter}`;

	const gradientOverlay = needsFold
		? `<g opacity="1" style="pointer-events: none;">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fafbfc" stop-opacity="0"/>
          <stop offset="55%" stop-color="#fafbfc" stop-opacity="0.78"/>
          <stop offset="100%" stop-color="#fafbfc" stop-opacity="1"/>
        </linearGradient>
      </defs>
      <rect x="0" y="42%" width="100%" height="58%" fill="url(#${gradId})"/>
    </g>`
		: "";

	const footerHtml = needsFold
		? `<div class="custom-details-footer" style="position: relative; z-index: 2; display: block; text-align: center; padding: 10px 18px 14px; background: #fafbfc; border-top: 1px dashed rgba(0, 0, 0, 0.08);"><span class="custom-details-toggle-btn" tabindex="0" style="display: inline-block; padding: 6px 18px; border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 20px; background: #ffffff; color: #007275; font-size: 13px; font-weight: 600; line-height: 1.4; outline: none; -webkit-tap-highlight-color: transparent;"><span leaf="">点击内容展开 / 点此收起 ▾</span></span></div>`
		: "";

	return `<section class="custom-details-preview-box" style="margin: 20px 0; border: 1px solid rgba(0, 0, 0, 0.12); border-radius: 8px; background: #fafbfc; overflow: hidden;">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${collapsedVw}vw" style="display: block; width: 100%; max-width: 100%; overflow: hidden; background: #fafbfc; outline: none; -webkit-tap-highlight-color: transparent;">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${collapsedVw}vw;${expandedVw}vw" dur="0.28s" fill="freeze" restart="whenNotActive"/>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${expandedVw}vw;${collapsedVw}vw" dur="0.22s" fill="freeze" restart="whenNotActive"/>
  <foreignObject width="100%" height="100%" x="0" y="0">
    ${innerHtml}
  </foreignObject>
  ${gradientOverlay}
</svg>${footerHtml}
</section>`;
}

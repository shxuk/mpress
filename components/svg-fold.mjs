/**
 * 样式库 · 双层原生 SVG + foreignObject 图文渐隐折叠组件
 * 1. 渐隐遮罩：采用三层无 id 半透明 <rect> 叠加，100% 免疫微信过滤 <linearGradient id>；
 * 2. 免疫微信 list 清洗：将 <ul>/<ol> 转为带圆点/编号的 <p>，外层用 <section> 锁定 padding，避免高度膨胀与截断；
 * 3. 按钮：底部仅保留唯一「点击展开」按钮。
 */
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { cjkStrong, xml } from "./cards.mjs";

const foldMd = new MarkdownIt({ html: true, breaks: true, linkify: false });

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

/** 估算内部 HTML 在 390px 手机视口（容器宽 358px，净宽约 330px）下的精确渲染高度（px） */
function estimateContentHeightPx(body, title, baseDir) {
	let px = 28; // 上下 padding: 14px * 2
	if (title) {
		const titleUnits = [...title].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0);
		const titleLines = Math.max(1, Math.ceil(titleUnits / 22.5));
		px += titleLines * 23 + 8; // line-height: 1.6 (~23px) + margin-bottom: 8px
	}

	const lines = body.split(/\r?\n/);
	let inCode = false;
	let prevWasBlank = true;
	let inParagraph = false;

	for (let idx = 0; idx < lines.length; idx++) {
		const raw = lines[idx];
		const trimmed = raw.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			px += inCode ? 10 : 18;
			prevWasBlank = false;
			continue;
		}
		if (!trimmed) {
			if (inParagraph) {
				px += 8; // 段落 margin-bottom: 8px
				inParagraph = false;
			}
			prevWasBlank = true;
			continue;
		}
		const imgMatch = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)\)/);
		if (!inCode && imgMatch) {
			if (inParagraph) {
				px += 8;
				inParagraph = false;
			}
			const dim = getImageDimensions(imgMatch[1], baseDir);
			if (dim && dim.width > 0) {
				const renderedH = Math.round((330 / dim.width) * dim.height);
				px += renderedH + 12;
			} else {
				px += 240;
			}
			prevWasBlank = false;
			continue;
		}

		// 330px 净宽 / 14.5px 字号 ≈ 22.5 汉字/行，line-height: 1.65 (24px)
		const charUnits = [...trimmed].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0);
		const wrapCount = Math.max(1, Math.ceil(charUnits / (inCode ? 36 : 22.5)));
		px += wrapCount * (inCode ? 19 : 24);
		inParagraph = !inCode;
		prevWasBlank = false;
	}

	// 最后一行若在段落中，包含最后一个 <p> 的 margin-bottom: 8px，但仅需 +4px 呼吸余量即可
	return Math.max(px + 12, 96);
}

/** 将内部 Markdown 渲染为微信安全的内联 <section class="custom-details-content"> HTML */
function renderInnerHtml(body, title) {
	// 预先将 Markdown 列表转为带符号普通段落，防止微信自动插入空 <li><section> 撑爆高度
	const normalizedLines = body.split(/\r?\n/).map((line) => {
		const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
		if (ulMatch) return `• ${ulMatch[1]}`;
		return line;
	});

	const preprocessed = normalizedLines.map((l) => cjkStrong(l)).join("\n");
	let html = foldMd.render(preprocessed);

	// 兜底把残余的 <ul>/<ol>/<li> 扁平化为 <p>
	html = html
		.replace(/<\/?(?:ul|ol)[^>]*>/gi, "")
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '<p style="margin: 0 0 6px; padding-left: 8px; font-size: 14.5px; line-height: 1.65; color: #111819;">$1</p>')
		.replace(/<p>/g, '<p style="margin: 0 0 8px; font-size: 14.5px; line-height: 1.65; color: #111819;">')
		.replace(/<pre><code([^>]*)>/g, '<pre style="margin: 8px 0; padding: 10px 12px; border-radius: 6px; background: #eef2f3; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; color: #111819;"><code$1 style="font-family: inherit; background: transparent; padding: 0;">')
		.replace(/<code>/g, '<code style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; padding: 1px 4px; border-radius: 3px; background: #e8eeee; color: #111819;">')
		.replace(/<img([^>]+)>/g, '<img$1 style="display: block; width: 100%; height: auto; border-radius: 4px; margin: 4px 0;" />')
		.replace(/<strong>/g, '<strong style="font-weight: 700; color: #111819;">')
		.replace(/<table>/g, '<table style="width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;">')
		.replace(/<th>/g, '<th style="padding: 5px 6px; border: 1px solid #d2dbdb; background: #eef4f4; font-weight: 700; text-align: left;">')
		.replace(/<td>/g, '<td style="padding: 5px 6px; border: 1px solid #d2dbdb;">');

	const titleHtml = title
		? `<p style="margin: 0 0 8px; font-size: 14.5px; line-height: 1.6; font-weight: 700; color: #111819;"><strong>${xml(title)}</strong></p>`
		: "";

	// 使用 <section> 而不是 <div>，微信后台不会剥离外层 <section> 的 padding
	return `<section class="custom-details-content" style="padding: 14px 14px; font-size: 14.5px; line-height: 1.65; color: #111819; background: #fafbfc; box-sizing: border-box;">${titleHtml}${html}</section>`;
}

export function renderSvgFold(body, fail, title = "", baseDir = process.cwd()) {
	const totalPx = estimateContentHeightPx(body, title, baseDir);
	const collapsePx = 175;
	const needsFold = totalPx > collapsePx + 30;

	const collapsedVw = needsFold ? ((collapsePx / 390) * 100).toFixed(1) : ((totalPx / 390) * 100).toFixed(1);
	const expandedVw = ((totalPx / 390) * 100).toFixed(1);

	const innerHtml = renderInnerHtml(body, title);

	// 无 id 三层半透明矩形叠加渐隐（100% 免疫微信清洗 linearGradient id）
	const gradientOverlay = needsFold
		? `<g opacity="1" style="pointer-events: none;">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.22s" fill="freeze" restart="whenNotActive"/>
      <rect x="0" y="55%" width="100%" height="15%" fill="#fafbfc" fill-opacity="0.38"/>
      <rect x="0" y="70%" width="100%" height="15%" fill="#fafbfc" fill-opacity="0.70"/>
      <rect x="0" y="85%" width="100%" height="15%" fill="#fafbfc" fill-opacity="0.94"/>
    </g>`
		: "";

	// 底部仅保留唯一「点击展开」按钮
	const foldBtnHtml = needsFold
		? `<p class="wx-fold-hint" style="margin: 0; padding: 6px 12px 10px; text-align: center; background: #fafbfc; border-top: 1px dashed #e2e8e8;"><span class="wx-fold-btn" tabindex="0" style="display: inline-block; padding: 3px 16px; border: 1px solid #c7d1d1; border-radius: 16px; background: #ffffff; font-size: 12px; font-weight: 600; line-height: 1.5; color: #007275; outline: none; -webkit-tap-highlight-color: transparent;"><span leaf="">点击展开</span></span></p>`
		: "";

	return `<section class="custom-details-preview-box" style="margin: 14px 0; border: 1px solid #d8dfdf; border-radius: 8px; background: #fafbfc; overflow: hidden;">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${collapsedVw}vw" style="display: block; width: 100%; max-width: 100%; overflow: hidden; background: #fafbfc; outline: none; -webkit-tap-highlight-color: transparent;">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${collapsedVw}vw;${expandedVw}vw" dur="0.28s" fill="freeze" restart="whenNotActive"/>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${expandedVw}vw;${collapsedVw}vw" dur="0.22s" fill="freeze" restart="whenNotActive"/>
  <foreignObject width="100%" height="100%" x="0" y="0">
    ${innerHtml}
  </foreignObject>
  ${gradientOverlay}
</svg>${foldBtnHtml}
</section>`;
}

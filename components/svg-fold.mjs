/**
 * 样式库 · 双层原生 SVG + foreignObject 图文渐隐折叠组件
 * 1. 使用 px 绝对高度动画（脱离 vw 在大屏手机/PC端的比例膨胀），展开后零多余空白；
 * 2. 渐隐遮罩（三层无 id 半透明 <rect>）与「点击展开」提示均置于 <svg> 内部：
 *    点击即可 100% 触发 <svg> focusin，展开高度的同时将遮罩+按钮彻底隐藏（opacity:0 + visibility:hidden），正文 100% 清晰；
 * 3. 底部留有极简透明收起热区（tabindex="0"），点击即可触发 focusout 平滑收起。
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

/** 估算内部 HTML 在标准移动端容器（内容净宽约 330px）下的精确渲染高度（px） */
function estimateContentHeightPx(body, title, baseDir) {
	let px = 28; // 上下 padding: 14px * 2
	if (title) {
		const titleUnits = [...title].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0);
		const titleLines = Math.max(1, Math.ceil(titleUnits / 22.5));
		px += titleLines * 23 + 8;
	}

	const lines = body.split(/\r?\n/);
	let inCode = false;
	let inParagraph = false;

	for (const raw of lines) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("```")) {
			inCode = !inCode;
			px += inCode ? 10 : 16;
			continue;
		}
		if (!trimmed) {
			if (inParagraph) {
				px += 8;
				inParagraph = false;
			}
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
				px += renderedH + 10;
			} else {
				px += 240;
			}
			continue;
		}

		// 按 330px 净宽、14.5px 字号估算（约 22.5 汉字/行），行高 24px
		const charUnits = [...trimmed].reduce((acc, ch) => acc + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0);
		const wrapCount = Math.max(1, Math.ceil(charUnits / (inCode ? 36 : 22.5)));
		px += wrapCount * (inCode ? 19 : 24);
		inParagraph = !inCode;
	}

	return Math.max(px + 6, 90);
}

/** 将内部 Markdown 渲染为微信安全的内联 <section class="custom-details-content"> HTML */
function renderInnerHtml(body, title) {
	const normalizedLines = body.split(/\r?\n/).map((line) => {
		const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
		if (ulMatch) return `• ${ulMatch[1]}`;
		return line;
	});

	const preprocessed = normalizedLines.map((l) => cjkStrong(l)).join("\n");
	let html = foldMd.render(preprocessed);

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

	return `<section class="custom-details-content" style="padding: 14px 14px; font-size: 14.5px; line-height: 1.65; color: #111819; background: #fafbfc; box-sizing: border-box;">${titleHtml}${html}</section>`;
}

export function renderSvgFold(body, fail, title = "", baseDir = process.cwd()) {
	const totalPx = estimateContentHeightPx(body, title, baseDir);
	const collapsePx = 165;
	const needsFold = totalPx > collapsePx + 30;

	const startH = needsFold ? collapsePx : totalPx;
	const endH = totalPx;

	const innerHtml = renderInnerHtml(body, title);

	// 热区 A（展开前覆盖下半部分）：三层半透明渐隐 + 居中「点击展开」药丸提示，全部置于 <svg> 内部！
	// 点击它即触发 <svg> 的 focusin：展开高度的同时，自身 opacity 归 0 且 visibility 设为 hidden 彻底消失！
	const foldOverlayInSvg = needsFold
		? `<g opacity="1" visibility="visible">
      <animate attributeName="opacity" begin="focusin" values="1;0" dur="0.18s" fill="freeze" restart="whenNotActive"/>
      <set attributeName="visibility" to="hidden" begin="focusin" fill="freeze"/>
      <animate attributeName="opacity" begin="focusout" values="0;1" dur="0.2s" fill="freeze" restart="whenNotActive"/>
      <set attributeName="visibility" to="visible" begin="focusout" fill="freeze"/>
      <rect x="0" y="45%" width="100%" height="18%" fill="#fafbfc" fill-opacity="0.40"/>
      <rect x="0" y="63%" width="100%" height="18%" fill="#fafbfc" fill-opacity="0.75"/>
      <rect x="0" y="81%" width="100%" height="19%" fill="#fafbfc" fill-opacity="0.96"/>
      <foreignObject x="0" y="56%" width="100%" height="28%">
        <section style="text-align: center; padding-top: 6px; background: transparent;">
          <span style="display: inline-block; padding: 3px 16px; border: 1px solid #c7d1d1; border-radius: 16px; background: #ffffff; font-size: 12px; font-weight: 600; line-height: 1.4; color: #007275;">点击展开</span>
        </section>
      </foreignObject>
    </g>`
		: "";

	// 热区 B（展开后起作用）：置于 <svg> 外部底端的纯透明小热区，点一下即可把焦点移出 <svg> 触发 focusout 收起（无任何文字、边框与透明遮罩）
	const transparentCollapseHotspot = needsFold
		? `<p style="margin: -16px 0 0; padding: 0; height: 16px; background: transparent; position: relative; z-index: 2;"><span class="wx-fold-hotspot" tabindex="0" style="display: block; width: 100%; height: 16px; border: none; background: transparent; outline: none; -webkit-tap-highlight-color: transparent;"></span></p>`
		: "";

	return `<section class="custom-details-preview-box" style="margin: 14px 0; border: 1px solid #d8dfdf; border-radius: 8px; background: #fafbfc; overflow: hidden;">
<svg class="wx-fold-outer" tabindex="0" xmlns="http://www.w3.org/2000/svg" width="100%" height="${startH}px" style="display: block; width: 100%; max-width: 100%; overflow: hidden; background: #fafbfc; outline: none; -webkit-tap-highlight-color: transparent;">
  <animate attributeName="height" attributeType="XML" begin="focusin" values="${startH}px;${endH}px" dur="0.26s" fill="freeze" restart="whenNotActive"/>
  <animate attributeName="height" attributeType="XML" begin="focusout" values="${endH}px;${startH}px" dur="0.22s" fill="freeze" restart="whenNotActive"/>
  <foreignObject width="100%" height="100%" x="0" y="0">
    ${innerHtml}
  </foreignObject>
  ${foldOverlayInSvg}
</svg>${transparentCollapseHotspot}
</section>`;
}

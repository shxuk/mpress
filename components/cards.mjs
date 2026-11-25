/**
 * 样式库 · 纯 HTML 结构组件（卡片、提示块、引文、代码、图注、章节）
 */
export const BOX_KINDS = {
	TIP: "tip",
	NOTE: "note",
	WARNING: "warning",
	IMPORTANT: "important",
};

export const xml = (s) =>
	String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// 作者会用 &lt;details&gt; 这种实体避开 HTML 解析，展开成组件时要先还原再转义
export const decode = (s) =>
	String(s)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");

/** 将 Markdown `**加粗**` 补全为 `<strong>`（修复 CommonMark 中文/标点边界及组件内未经过 markdown-it 的加粗） */
export function cjkStrong(text) {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2
				? part
				: part.replace(
						/(?<!\*)\*\*(?!\s|\*)((?:[^*\n]|(?<!\*)\*(?!\*))*?[^\s*])\*\*(?!\*)/g,
						"<strong>$1</strong>",
					),
		)
		.join("");
}

/** 组件内的文本：先还原本体，再转义，再补 <strong> */
export const compText = (s) => cjkStrong(xml(decode(s)));

export function normalizeRepo(raw) {
	if (!raw) return "";
	return String(raw)
		.trim()
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/$/, "");
}

export function compactHtml(html) {
	return html
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.join("\n");
}

export function boxHtml(kind, bodyLines, title = "") {
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

export function quoteHtml(paragraphs, source) {
	const body = paragraphs
		.join("\n")
		.split(/\n{2,}/)
		.map((p) => p.replace(/\s*\n\s*/g, "").trim())
		.filter(Boolean)
		.map((p) => `<p class="wx-quote-text">${compText(p)}</p>`)
		.join("\n");
	return `<section class="wx-quote">\n${body}\n<p class="wx-quote-source">${xml(source)}</p>\n</section>`;
}

export function codeHtml(lang, lines) {
	const label = lang ? `<p class="wx-pre-lang">${xml(lang.toUpperCase())}</p>\n` : "";
	const body = lines.map((line) => `<p class="wx-pre-line">${xml(line)}</p>`).join("\n");
	return `<section class="wx-pre">\n${label}<section class="wx-pre-body">\n${body}\n</section>\n</section>`;
}

export function figureHtml(alt, src, caption) {
	const figure = `<section class="wx-figure"><img src="${xml(src)}" alt="${xml(alt)}"></section>`;
	return caption ? `${figure}\n<p class="wx-caption">${compText(caption)}</p>` : figure;
}

export function chapterHtml(no, text, isFirst = false) {
	const style = isFirst ? ' style="margin-top: 8px;"' : "";
	return `<section class="wx-h2"${style}><span class="wx-h2-no">${xml(no)}</span><span class="wx-h2-text">${compText(text)}</span></section>`;
}

export function blockHtml(cls, textCls, lines) {
	const text = lines.join(" ").replace(/\s+/g, " ").trim();
	const p = textCls ? `<p class="${textCls}">` : "<p>";
	return `<section class="${cls}">${p}${compText(text)}</p></section>`;
}

/** GitHub 仓库引导卡片：严格沿用 wx-box-tip 视觉家族 */
export function githubCardHtml(repo) {
	const cleanRepo = normalizeRepo(repo) || "GitHub 仓库";
	const repoUrl = cleanRepo.includes("/") ? `https://github.com/${cleanRepo}` : "https://github.com";
	return compactHtml(
		`<section class="wx-github-card"><p class="wx-github-card-label">GITHUB</p><p class="wx-github-card-repo">${xml(cleanRepo)}</p><p class="wx-github-card-url">${xml(repoUrl)}</p></section>`,
	);
}

/** 静态 HTML 盒子兜底（仅当模板把某个折叠组件显式设为 html-static 时启用） */
export function staticBoxHtml(badge, title, bodyLines, md) {
	const inner = compactHtml(md.render(bodyLines.map((l) => cjkStrong(l)).join("\n")));
	return compactHtml(
		`<section class="wx-static-box"><section class="wx-static-bar"><span class="wx-static-badge">${xml(badge)}</span><span class="wx-static-title">${compText(title)}</span></section><section class="wx-static-content">\n${inner}\n</section></section>`,
	);
}

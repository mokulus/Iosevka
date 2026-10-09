import fs from "node:fs";

import { buildGlyphs } from "@iosevka/font-glyphs";
import { copyFontMetrics } from "@iosevka/font-glyphs/aesthetics";
import { buildOtl } from "@iosevka/font-otl";
import { RecursiveBuildFilter } from "@iosevka/glyph/block";
import { createGrDisplaySheet } from "@iosevka/glyph/relation";
import { createSubsetFilter } from "@iosevka/param";
import { TaskYield } from "@iosevka/util";

import { cleanupGlyphStore } from "../cleanup/index.mjs";
import { CreateEmptyFont } from "../font-io/index.mjs";
import { buildCompatLigatures } from "../hb-compat-ligature/index.mjs";
import { assignFontNames } from "../naming/index.mjs";
import { convertOtd } from "../otd-conv/index.mjs";
import { postProcessFont } from "../post-processing/index.mjs";
import { generateTtfaControls } from "../ttfa-controls/index.mjs";
import { validateFontConfigMono } from "../validate/metrics.mjs";

export async function buildFont(para, cache, scope) {
	const baseFont = CreateEmptyFont(para);
	assignFontNames(baseFont, para.naming, para.isQuasiProportional);
	await TaskYield();

	// Build glyphs
	let { glyphStore, fontMetrics } = scope ? buildScopedGlyphs(para, scope) : buildGlyphs(para);
	copyFontMetrics(fontMetrics, baseFont);
	await TaskYield();


	// Build OTL. Scoped builds only serve outline comparison and carry no OpenType features.
	const otl = scope ? emptyOtl() : buildOtl(para, glyphStore);
	await TaskYield();

	// Regulate (like geometry conversion)
	const sf = await createSubsetFilter(para.subset, para.excludedCharRanges);
	glyphStore = cleanupGlyphStore(cache, para, glyphStore, sf, otl);
	await TaskYield();

	// Convert to TTF
	const font = convertOtd(baseFont, otl, glyphStore);
	await TaskYield();
	// Build compatibility ligatures
	if (para.compatibilityLigatures) await buildCompatLigatures(para, font);
	await TaskYield();
	// Apply post processing
	postProcessFont(para, font);
	await TaskYield();
	// Generate ttfaControls
	const ttfaControls = generateTtfaControls(glyphStore, font.glyphs);
	await TaskYield();
	// Generate charmap
	const charMap = getCharMap(glyphStore);
	await TaskYield();

	// Validation : Metrics
	if (para.forceMonospace) validateFontConfigMono(font);
	await TaskYield();

	return { font, charMap, cacheUpdated: cache?.isUpdated(), ttfaControls };
}

function getCharMap(glyphStore) {
	const charMap = [];
	for (const [gn] of glyphStore.namedEntries()) {
		charMap.push([
			gn,
			Array.from(glyphStore.queryUnicodeOfName(gn) || []),
			...createGrDisplaySheet(glyphStore, gn),
		]);
	}
	return charMap;
}

// Scoped build: run only the glyph blocks the target code points depend on.
// The dependency closure comes from a previous full run and is stored at scope.path,
// tagged with scope.key (a hash of the glyph code and variant selection), together with
// the code points that run produced. A stale or missing closure, or a scoped run that
// misses any of those code points, falls back to a full run, which records a fresh closure.
function buildScopedGlyphs(para, scope) {
	const saved = readScope(scope);
	if (saved) {
		const filter = new RecursiveBuildFilter(new Set(saved.glyphs), new Set(saved.blocks));
		try {
			const result = buildGlyphs(para, filter);
			const missing = saved.codepoints.filter(u => !result.glyphStore.queryByUnicode(u));
			if (!missing.length) return result;
			console.error(`Scoped build missed ${missing.length} code points; rebuilding the dependency closure.`);
		} catch (e) {
			console.error(`Scoped build failed (${e.message}); rebuilding the dependency closure.`);
		}
	}

	const result = buildGlyphs(para);
	const codepoints = scope.codepoints.filter(u => result.glyphStore.queryByUnicode(u));
	const targets = codepoints.map(u => result.glyphStore.queryByUnicode(u));
	const filter = targets[0]._m_dependencyManager.traverseDependencies(targets);
	fs.writeFileSync(
		scope.path,
		JSON.stringify({
			key: scope.key,
			codepoints,
			glyphs: [...filter.glyphIdFilter],
			blocks: [...filter.blockIdFilter],
		}),
	);
	return result;
}

function readScope(scope) {
	if (!fs.existsSync(scope.path)) return null;
	const saved = JSON.parse(fs.readFileSync(scope.path, "utf-8"));
	return saved.key === scope.key ? saved : null;
}

function emptyOtl() {
	const table = () => ({ languages: {}, features: {}, lookups: {}, lookupDep: [], lookupOrder: [] });
	return {
		GSUB: table(),
		GPOS: table(),
		GDEF: { glyphClassDef: {}, markAttachClassDef: {}, markGlyphSets: [] },
	};
}

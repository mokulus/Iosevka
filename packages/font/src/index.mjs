import fs from "node:fs";
import zlib from "node:zlib";

import * as Caching from "@iosevka/geometry-cache";
import { encode } from "@msgpack/msgpack";

import { buildFont } from "./build-font/index.mjs";
import { saveTTF } from "./font-io/index.mjs";
import { getParametersT } from "./param/index.mjs";

export default main;
async function main(argv) {
	// Fast iteration builds skip derived glyphs; each font builds in its own process.
	if (argv.fast) process.env.IOSKELEY_FAST = "1";
	// Set up parameters
	const paraT = await getParametersT(argv);
	const para = paraT(argv);

	// Set up cache
	const cache = argv.cache
		? await Caching.load(argv.cache.input, argv.menu.version, argv.cache.freshAgeKey)
		: null;
	// Build font
	const { font, charMap, cacheUpdated, ttfaControls } = await buildFont(para, cache, argv.scope);

	// Save charmap
	if (argv.oCharMap) await fs.promises.writeFile(argv.oCharMap, zlib.gzipSync(encode(charMap)));
	// Save ttfaControls
	if (argv.oTtfaControls) await fs.promises.writeFile(argv.oTtfaControls, ttfaControls);
	// Save TTF
	if (argv.o) await saveTTF(argv.o, font);
	// Save cache
	if (argv.cache && cache?.isUpdated()) {
		await Caching.save(argv.cache.output, argv.menu.version, cache, true);
	}

	return { cacheUpdated };
}

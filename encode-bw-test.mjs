#!/usr/bin/env node
/** Encode a BW 2.6" (0x4E) kiosk test image — matches kiosk-encode.js header/pack logic. */
import { existsSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pakoCandidates = [
	process.env.AP_DIR && join(process.env.AP_DIR, 'wwwroot/vendor/pako.min.js'),
	join(__dirname, 'ESP32_AP-Flasher/wwwroot/vendor/pako.min.js'),
].filter(Boolean);
const pakoPath = pakoCandidates.find((p) => existsSync(p));
if (!pakoPath) {
	console.error('pako.min.js not found. Set AP_DIR or keep ESP32_AP-Flasher/ in this tree.');
	process.exit(1);
}
const pako = require(pakoPath);

const TAG = {
	width: 360,
	height: 184,
	rotatebuffer: 3,
	bpp: 1,
	colortable: [[255, 255, 255], [0, 0, 0]],
};

function packParams(tagType, imageRotate = 0) {
	const sprW = tagType.width;
	const sprH = tagType.height;
	const rotatebuffer = tagType.rotatebuffer || 0;
	let rotate = imageRotate;
	let bufw = sprW;
	let bufh = sprH;
	if (rotatebuffer % 2 === 1) {
		rotate = (rotate + 3) % 4;
		rotate = (rotate + (rotatebuffer - 1)) % 4;
		bufw = sprH;
		bufh = sprW;
	} else {
		rotate = (rotate + rotatebuffer) % 4;
	}
	return { sprW, sprH, bufw, bufh, rotate };
}

function sourcePixel(imgData, sprW, rotate, x, y, bufw, bufh) {
	let sx, sy;
	switch (rotate) {
		case 0: sx = x; sy = y; break;
		case 1: sx = y; sy = bufw - 1 - x; break;
		case 2: sx = bufw - 1 - x; sy = bufh - 1 - y; break;
		case 3: sx = bufh - 1 - y; sy = x; break;
		default: sx = x; sy = y;
	}
	const i = (sy * sprW + sx) * 4;
	return [imgData[i], imgData[i + 1], imgData[i + 2]];
}

function closestIdx(r, g, b, palette) {
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < palette.length; i++) {
		const c = palette[i];
		const dr = r - c[0];
		const dg = g - c[1];
		const db = b - c[2];
		const dist = dr * dr + dg * dg + db * db;
		if (dist < bestDist) { bestDist = dist; best = i; }
	}
	return best;
}

function prepareHeader(sprW, sprH, tagType, bufferSize) {
	const header = new Uint8Array(6);
	header[0] = 6;
	const rotatebuffer = tagType.rotatebuffer || 0;
	if (rotatebuffer % 2 === 1) {
		header[3] = sprW & 0xff;
		header[4] = (sprW >> 8) & 0xff;
		header[1] = sprH & 0xff;
		header[2] = (sprH >> 8) & 0xff;
	} else {
		header[1] = sprW & 0xff;
		header[2] = (sprW >> 8) & 0xff;
		header[3] = sprH & 0xff;
		header[4] = (sprH >> 8) & 0xff;
	}
	header[5] = 1;
	return { header, totalbytes: bufferSize + 6 };
}

function makeTestImage(sprW, sprH) {
	const data = new Uint8ClampedArray(sprW * sprH * 4);
	for (let y = 0; y < sprH; y++) {
		for (let x = 0; x < sprW; x++) {
			const border = x < 8 || y < 8 || x >= sprW - 8 || y >= sprH - 8;
			const checker = ((Math.floor(x / 24) + Math.floor(y / 24)) % 2) === 0;
			const bar = y >= sprH / 2 - 12 && y < sprH / 2 + 12 && x >= 40 && x < sprW - 40;
			const black = border || bar || checker;
			const i = (y * sprW + x) * 4;
			const v = black ? 0 : 255;
			data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
		}
	}
	return data;
}

function pack(imgData, tagType) {
	const { sprW, sprH, bufw, bufh, rotate } = packParams(tagType, 0);
	const palette = tagType.colortable;
	const planeSize = Math.ceil((bufw * bufh) / 8);
	const plane = new Uint8Array(planeSize);

	for (let y = 0; y < bufh; y++) {
		for (let x = 0; x < bufw; x++) {
			const [r, g, b] = sourcePixel(imgData, sprW, rotate, x, y, bufw, bufh);
			const colorIdx = closestIdx(r, g, b, palette);
			if (colorIdx === 1) {
				const bitIndex = 7 - (x % 8);
				const byteIndex = Math.floor((y * bufw + x) / 8);
				plane[byteIndex] |= 1 << bitIndex;
			}
		}
	}

	const { header, totalbytes } = prepareHeader(sprW, sprH, tagType, planeSize);
	const payload = new Uint8Array(header.length + plane.length);
	payload.set(header, 0);
	payload.set(plane, header.length);
	const compressed = pako.deflate(payload, { level: 9, windowBits: 11 });
	const out = new Uint8Array(4 + compressed.length);
	new DataView(out.buffer).setUint32(0, totalbytes, true);
	out.set(compressed, 4);
	return { out, bufw, bufh, totalbytes, planeSize };
}

const img = makeTestImage(TAG.width, TAG.height);
const { out, bufw, bufh, totalbytes } = pack(img, TAG);
const outPath = process.argv[2] || join(__dirname, 'dumps/bw-test-4e.raw');
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${out.length} bytes, uncompressed=${totalbytes}, buf=${bufw}x${bufh})`);

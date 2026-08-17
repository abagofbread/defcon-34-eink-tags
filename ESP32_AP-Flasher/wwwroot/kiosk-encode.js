function kioskColorDistance(r, g, b, paletteColor) {
	const dr = r - paletteColor[0];
	const dg = g - paletteColor[1];
	const db = b - paletteColor[2];
	return dr * dr + dg * dg + db * db;
}

function kioskClosestColorIndex(r, g, b, palette) {
	let best = 0;
	let bestDist = kioskColorDistance(r, g, b, palette[0]);
	for (let i = 1; i < palette.length; i++) {
		const dist = kioskColorDistance(r, g, b, palette[i]);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

/** Weighted distance with error diffusion (matches makeimage.cpp colorDistance). */
function kioskColorDistanceDither(r, g, b, paletteColor, err) {
	const rDiff = r + err.r - paletteColor[0];
	const gDiff = g + err.g - paletteColor[1];
	const bDiff = b + err.b - paletteColor[2];
	if (Math.abs(r - g) < 20 && Math.abs(b - g) < 20) {
		if (Math.abs(paletteColor[0] - paletteColor[1]) > 20 || Math.abs(paletteColor[2] - paletteColor[1]) > 20) {
			return 0xffffffff;
		}
	}
	return 3 * rDiff * rDiff + 5.47 * gDiff * gDiff + 1.53 * bDiff * bDiff;
}

function kioskClampByte(v) {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Lift shadows / adjust contrast before quantizing (helps dark photos on BWRY). */
function kioskApplyToneAdjustments(imageData, tone = {}) {
	const shadows = Math.max(0, Math.min(100, Number(tone.shadows) || 0));
	const contrast = Math.max(75, Math.min(125, Number(tone.contrast) || 100));
	const cFactor = contrast / 100;
	const data = imageData.data;

	for (let i = 0; i < data.length; i += 4) {
		let r = data[i];
		let g = data[i + 1];
		let b = data[i + 2];
		const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

		if (shadows > 0) {
			const lift = (shadows / 100) * Math.pow(1 - lum, 1.4) * 90;
			r += lift;
			g += lift;
			b += lift;
		}

		r = (r - 128) * cFactor + 128;
		g = (g - 128) * cFactor + 128;
		b = (b - 128) * cFactor + 128;

		data[i] = kioskClampByte(r);
		data[i + 1] = kioskClampByte(g);
		data[i + 2] = kioskClampByte(b);
	}
	return imageData;
}

function kioskDistributeBurkeError(err, errOld, errNew, x, bufw) {
	const maxAbs = Math.max(Math.abs(err.r), Math.abs(err.g), Math.abs(err.b));
	if (maxAbs > 255) {
		const sf = 255 / maxAbs;
		err = { r: err.r * sf, g: err.g * sf, b: err.b * sf };
	}

	errNew[x].r += err.r / 4;
	errNew[x].g += err.g / 4;
	errNew[x].b += err.b / 4;

	if (x > 0) {
		errNew[x - 1].r += err.r / 8;
		errNew[x - 1].g += err.g / 8;
		errNew[x - 1].b += err.b / 8;
	}
	if (x > 1) {
		errNew[x - 2].r += err.r / 16;
		errNew[x - 2].g += err.g / 16;
		errNew[x - 2].b += err.b / 16;
	}

	errNew[x + 1].r += err.r / 8;
	errNew[x + 1].g += err.g / 8;
	errNew[x + 1].b += err.b / 8;

	errOld[x + 1].r += err.r / 4;
	errOld[x + 1].g += err.g / 4;
	errOld[x + 1].b += err.b / 4;

	errNew[x + 2].r += err.r / 16;
	errNew[x + 2].g += err.g / 16;
	errNew[x + 2].b += err.b / 16;

	errOld[x + 2].r += err.r / 8;
	errOld[x + 2].g += err.g / 8;
	errOld[x + 2].b += err.b / 8;
}

function kioskPickPaletteIndex(r, g, b, palette, errOld, x, dither) {
	if (!dither) {
		return kioskClosestColorIndex(r, g, b, palette);
	}
	let best = 0;
	let bestDist = kioskColorDistanceDither(r, g, b, palette[0], errOld[x]);
	for (let i = 1; i < palette.length; i++) {
		if (bestDist === 0) {
			break;
		}
		const dist = kioskColorDistanceDither(r, g, b, palette[i], errOld[x]);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

function kioskPackPlane(imgData, sprW, sprH, bufw, bufh, rotate, palette, isRed, dither) {
	const planeSize = Math.ceil((bufw * bufh) / 8);
	const plane = new Uint8Array(planeSize);
	let hasBits = false;
	const errOld = Array.from({ length: bufw + 4 }, () => ({ r: 0, g: 0, b: 0 }));
	const errNew = Array.from({ length: bufw + 4 }, () => ({ r: 0, g: 0, b: 0 }));

	for (let y = 0; y < bufh; y++) {
		for (let i = 0; i < bufw + 4; i++) {
			errNew[i].r = 0;
			errNew[i].g = 0;
			errNew[i].b = 0;
		}

		for (let x = 0; x < bufw; x++) {
			const [r, g, b] = kioskSourcePixel(imgData, sprW, sprH, rotate, x, y, bufw, bufh);
			const colorIdx = kioskPickPaletteIndex(r, g, b, palette, errOld, x, dither);
			const bitIndex = 7 - (x % 8);
			const byteIndex = Math.floor((y * bufw + x) / 8);

			switch (colorIdx) {
				case 1:
					if (!isRed) {
						plane[byteIndex] |= 1 << bitIndex;
						hasBits = true;
					}
					break;
				case 2:
					if (isRed) {
						plane[byteIndex] |= 1 << bitIndex;
						hasBits = true;
					}
					break;
				case 3:
					plane[byteIndex] |= 1 << bitIndex;
					hasBits = true;
					break;
				default:
					break;
			}

			if (dither) {
				const chosen = palette[colorIdx];
				const err = {
					r: r + errOld[x].r - chosen[0],
					g: g + errOld[x].g - chosen[1],
					b: b + errOld[x].b - chosen[2],
				};
				kioskDistributeBurkeError(err, errOld, errNew, x, bufw);
			}
		}

		for (let i = 0; i < bufw + 4; i++) {
			errOld[i].r = errNew[i].r;
			errOld[i].g = errNew[i].g;
			errOld[i].b = errNew[i].b;
		}
	}

	return { plane, hasBits };
}

/** Panel dimensions used when drawing the source image (matches AP makeimage sprite). */
function kioskSpriteDimensions(tagType) {
	return { width: tagType.width, height: tagType.height };
}

/**
 * Buffer layout + rotation for packing (matches makeimage.cpp spr2color).
 * rotatebuffer odd: swap bufw/bufh and rotate pixel reads.
 */
function kioskPackParams(tagType, imageRotate = 0) {
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

	return { sprW, sprH, bufw, bufh, rotate, rotatebuffer };
}

function kioskSourcePixel(imgData, sprW, sprH, rotate, x, y, bufw, bufh) {
	let sx;
	let sy;
	switch (rotate) {
		case 0:
			sx = x;
			sy = y;
			break;
		case 1:
			sx = y;
			sy = bufw - 1 - x;
			break;
		case 2:
			sx = bufw - 1 - x;
			sy = bufh - 1 - y;
			break;
		case 3:
			sx = bufh - 1 - y;
			sy = x;
			break;
		default:
			sx = x;
			sy = y;
	}
	const i = (sy * sprW + sx) * 4;
	return [imgData.data[i], imgData.data[i + 1], imgData.data[i + 2]];
}

function kioskPrepareHeader(sprW, sprH, tagType, bufferSize, hasRed) {
	const header = new Uint8Array(6);
	const headersize = 6;
	header[0] = headersize;
	const rotatebuffer = tagType.rotatebuffer || 0;
	// Match makeimage.cpp prepareHeader: pass sprite (panel) dimensions, not swapped bufw/bufh.
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

	let totalbytes;
	if (tagType.bpp >= 3) {
		header[5] = tagType.bpp;
		totalbytes = bufferSize * tagType.bpp + headersize;
	} else if (hasRed && tagType.bpp > 1) {
		header[5] = 2;
		totalbytes = bufferSize * 2 + headersize;
	} else {
		header[5] = 1;
		totalbytes = bufferSize + headersize;
	}
	return { header, totalbytes };
}

function kioskConcatChunks(chunks) {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function kioskPackCanvas(canvas, tagType, options = {}) {
	const imageRotate = options.rotate ?? 0;
	const dither = options.dither !== false;
	const { sprW, sprH, bufw, bufh, rotate } = kioskPackParams(tagType, imageRotate);
	const ctx = canvas.getContext('2d');
	const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const palette = tagType.colortable.map((c) => (Array.isArray(c) ? c : [c.r, c.g, c.b]));

	const black = kioskPackPlane(imgData, sprW, sprH, bufw, bufh, rotate, palette, false, dither);
	const red = kioskPackPlane(imgData, sprW, sprH, bufw, bufh, rotate, palette, true, dither);
	const hasRed = red.hasBits;
	const planeSize = black.plane.length;

	const { header, totalbytes } = kioskPrepareHeader(sprW, sprH, tagType, planeSize, hasRed);
	const payloadChunks = hasRed ? [header, black.plane, red.plane] : [header, black.plane];
	const payload = kioskConcatChunks(payloadChunks);
	// EFR32 uzlib allows max 8 KiB inflate window (MAX_WINDOW_SIZE). pako default is 32 KiB.
	const compressed = pako.deflate(payload, { level: 9, windowBits: 11 });
	const out = new Uint8Array(4 + compressed.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, totalbytes, true);
	out.set(compressed, 4);
	return out;
}

const KIOSK_FIT_COVER = 'cover';
const KIOSK_FIT_CONTAIN = 'contain';
const KIOSK_FIT_STRETCH = 'stretch';

function kioskNormalizeFitMode(mode) {
	if (mode === KIOSK_FIT_CONTAIN || mode === KIOSK_FIT_STRETCH) {
		return mode;
	}
	return KIOSK_FIT_COVER;
}

function kioskDrawImageElement(ctx, source, width, height, fitMode, scale = 1, userRotate = 0, panX = 0, panY = 0) {
	const fit = kioskNormalizeFitMode(fitMode);
	const sw = source.width;
	const sh = source.height;
	const zoom = Math.max(0.1, Math.min(3, Number(scale) || 1));
	const rot = ((Number(userRotate) || 0) % 4 + 4) % 4;
	const offsetX = (Number(panX) || 0) * width;
	const offsetY = (Number(panY) || 0) * height;

	if (fit === KIOSK_FIT_STRETCH && rot === 0 && zoom === 1 && offsetX === 0 && offsetY === 0) {
		ctx.drawImage(source, 0, 0, width, height);
		return;
	}

	let drawW;
	let drawH;
	if (fit === KIOSK_FIT_STRETCH) {
		drawW = width * zoom;
		drawH = height * zoom;
	} else {
		const baseScale = fit === KIOSK_FIT_CONTAIN
			? Math.min(width / sw, height / sh)
			: Math.max(width / sw, height / sh);
		const s = baseScale * zoom;
		drawW = sw * s;
		drawH = sh * s;
	}

	if (rot === 0) {
		const dx = (width - drawW) / 2 + offsetX;
		const dy = (height - drawH) / 2 + offsetY;
		ctx.drawImage(source, dx, dy, drawW, drawH);
		return;
	}

	const cx = width / 2 + offsetX;
	const cy = height / 2 + offsetY;
	ctx.save();
	ctx.translate(cx, cy);
	ctx.rotate(rot * Math.PI / 2);
	ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
	ctx.restore();
}

function kioskDrawSourceToCanvas(ctx, source, width, height, options = {}) {
	const fitMode = kioskNormalizeFitMode(options.fit);
	const scale = options.scale ?? 1;
	const userRotate = options.rotate ?? 0;
	const panX = options.panX ?? 0;
	const panY = options.panY ?? 0;
	ctx.fillStyle = 'white';
	ctx.fillRect(0, 0, width, height);
	ctx.imageSmoothingEnabled = false;

	const hasPan = panX !== 0 || panY !== 0;
	if (source instanceof HTMLCanvasElement) {
		if (source.width === width && source.height === height && scale === 1 && !userRotate && !hasPan) {
			ctx.drawImage(source, 0, 0);
		} else {
			kioskDrawImageElement(ctx, source, width, height, fitMode, scale, userRotate, panX, panY);
		}
	} else if (source instanceof HTMLImageElement || source instanceof ImageBitmap) {
		kioskDrawImageElement(ctx, source, width, height, fitMode, scale, userRotate, panX, panY);
	} else {
		throw new Error('Unsupported image source');
	}
}

async function kioskRenderToCanvas(source, tagType, options = {}) {
	if (source instanceof Blob || typeof source === 'string') {
		const url = typeof source === 'string' ? source : URL.createObjectURL(source);
		try {
			const img = await kioskLoadImage(url);
			return kioskRenderToCanvas(img, tagType, options);
		} finally {
			if (typeof source !== 'string') {
				URL.revokeObjectURL(url);
			}
		}
	}

	const canvas = document.createElement('canvas');
	const { width, height } = kioskSpriteDimensions(tagType);
	canvas.width = width;
	canvas.height = height;
	kioskDrawSourceToCanvas(canvas.getContext('2d'), source, width, height, options);
	if (options.tone) {
		const ctx = canvas.getContext('2d');
		const imgData = ctx.getImageData(0, 0, width, height);
		kioskApplyToneAdjustments(imgData, options.tone);
		ctx.putImageData(imgData, 0, 0);
	}
	return canvas;
}

function kioskPanelCoordsFromBuffer(x, y, rotate, bufw, bufh) {
	switch (rotate) {
		case 1:
			return [y, bufw - 1 - x];
		case 2:
			return [bufw - 1 - x, bufh - 1 - y];
		case 3:
			return [bufh - 1 - y, x];
		default:
			return [x, y];
	}
}

/** Preview: same pack path as kioskPackCanvas, mapped back to panel view. */
function kioskQuantizeCanvas(canvas, tagType, options = {}) {
	const imageRotate = options.rotate ?? 0;
	const dither = options.dither !== false;
	const { sprW, sprH, bufw, bufh, rotate } = kioskPackParams(tagType, imageRotate);
	const srcCtx = canvas.getContext('2d');
	const imgData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
	const palette = tagType.colortable.map((c) => (Array.isArray(c) ? c : [c.r, c.g, c.b]));
	const errOld = Array.from({ length: bufw + 4 }, () => ({ r: 0, g: 0, b: 0 }));
	const errNew = Array.from({ length: bufw + 4 }, () => ({ r: 0, g: 0, b: 0 }));

	const outData = new ImageData(sprW, sprH);
	outData.data.fill(255);

	for (let y = 0; y < bufh; y++) {
		for (let i = 0; i < bufw + 4; i++) {
			errNew[i].r = 0;
			errNew[i].g = 0;
			errNew[i].b = 0;
		}

		for (let x = 0; x < bufw; x++) {
			const [r, g, b] = kioskSourcePixel(imgData, sprW, sprH, rotate, x, y, bufw, bufh);
			const colorIdx = kioskPickPaletteIndex(r, g, b, palette, errOld, x, dither);
			const [sx, sy] = kioskPanelCoordsFromBuffer(x, y, rotate, bufw, bufh);
			if (sx < 0 || sy < 0 || sx >= sprW || sy >= sprH) {
				continue;
			}
			const o = (sy * sprW + sx) * 4;
			outData.data[o] = palette[colorIdx][0];
			outData.data[o + 1] = palette[colorIdx][1];
			outData.data[o + 2] = palette[colorIdx][2];
			outData.data[o + 3] = 255;

			if (dither) {
				const chosen = palette[colorIdx];
				const err = {
					r: r + errOld[x].r - chosen[0],
					g: g + errOld[x].g - chosen[1],
					b: b + errOld[x].b - chosen[2],
				};
				kioskDistributeBurkeError(err, errOld, errNew, x, bufw);
			}
		}

		for (let i = 0; i < bufw + 4; i++) {
			errOld[i].r = errNew[i].r;
			errOld[i].g = errNew[i].g;
			errOld[i].b = errNew[i].b;
		}
	}

	const out = document.createElement('canvas');
	out.width = sprW;
	out.height = sprH;
	out.getContext('2d').putImageData(outData, 0, 0);
	return out;
}

function kioskQuantizePanelCanvas(canvas, tagType) {
	return kioskQuantizeCanvas(canvas, tagType);
}

async function kioskEncodeImageSource(source, tagType, options = {}) {
	const canvas = await kioskRenderToCanvas(source, tagType, options);
	return kioskPackCanvas(canvas, tagType, options);
}

function kioskLoadImage(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Failed to load image'));
		img.src = url;
	});
}

window.kioskEncodeImageSource = kioskEncodeImageSource;
window.kioskRenderToCanvas = kioskRenderToCanvas;
window.kioskQuantizeCanvas = kioskQuantizeCanvas;
window.kioskQuantizePanelCanvas = kioskQuantizePanelCanvas;
window.kioskPackCanvas = kioskPackCanvas;
window.kioskPackParams = kioskPackParams;
window.KIOSK_FIT_COVER = KIOSK_FIT_COVER;
window.KIOSK_FIT_CONTAIN = KIOSK_FIT_CONTAIN;
window.KIOSK_FIT_STRETCH = KIOSK_FIT_STRETCH;

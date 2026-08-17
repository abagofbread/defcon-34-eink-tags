let progMac = '';
let progHwType = null;
let progHwTypeLocked = false; // set true when AP reports a real hwType for this MAC
let progPaintLoaded = false;
let progEncodedImage = null;
let progPollTimer = null;
let progLastSource = null;
let progPrepareTimer = null;
let progPanDrag = null;

const PROG_DEFAULT_HWTYPE = 0x4F; // M3 2.6" BWRY

function progNormalizeMac(raw) {
	return raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(-16);
}

function progUpdateStageStatus() {
	const hasImage = progEncodedImage instanceof Uint8Array && progEncodedImage.length > 0;
	const hasMac = progMac.length === 16;
	$('#progstagestatus').innerHTML = hasImage
		? `<strong>Image ready</strong> (${progEncodedImage.length} bytes encoded in browser)`
		: '<em>Choose or draw an image first.</em>';
	$('#progprogram').disabled = !(hasImage && hasMac);
}

function progSchedulePrepare() {
	if (progPrepareTimer) {
		clearTimeout(progPrepareTimer);
	}
	progPrepareTimer = setTimeout(() => {
		progPrepareTimer = null;
		if (progLastSource) {
			progPrepareImage();
		}
	}, 180);
}

function progSelectedHwType() {
	const sel = $('#proghwtype');
	if (!sel) {
		return PROG_DEFAULT_HWTYPE;
	}
	if (sel.value === 'custom') {
		const raw = ($('#proghwcustom')?.value || '').trim();
		const n = parseInt(raw, 16);
		return Number.isFinite(n) && n > 0 ? n : PROG_DEFAULT_HWTYPE;
	}
	const n = parseInt(sel.value, 16);
	return Number.isFinite(n) ? n : PROG_DEFAULT_HWTYPE;
}

function progSetHwTypeSelect(hwtype, { locked = false } = {}) {
	const sel = $('#proghwtype');
	const customWrap = $('#proghwcustomwrap');
	const custom = $('#proghwcustom');
	if (!sel) {
		return;
	}
	const hex = Number(hwtype).toString(16).toUpperCase().padStart(2, '0');
	let matched = false;
	for (const opt of sel.options) {
		if (opt.value === 'custom') {
			continue;
		}
		if (opt.value.toUpperCase() === hex) {
			sel.value = opt.value;
			matched = true;
			break;
		}
	}
	if (!matched) {
		sel.value = 'custom';
		if (custom) {
			custom.value = hex;
		}
	}
	if (customWrap) {
		customWrap.style.display = sel.value === 'custom' ? '' : 'none';
	}
	progHwTypeLocked = !!locked;
	sel.disabled = progHwTypeLocked;
	if (custom) {
		custom.disabled = progHwTypeLocked;
	}
}

async function progEnsureHwType(hwtype) {
	const tt = await getTagtype(hwtype);
	if (!tt || !tt.width) {
		return null;
	}
	progHwType = hwtype;
	return tt;
}

async function progResolveTagType() {
	const hwtype = progSelectedHwType();
	const tt = await progEnsureHwType(hwtype);
	if (!tt) {
		showMessage('Could not load tag type ' + hwtype.toString(16).toUpperCase(), true);
		return null;
	}
	return tt;
}

function progFormatTagInfo(tag, tt) {
	const state = tag?.provisionState || 'unknown';
	const typeLabel = tt?.width
		? `${tt.name} (${tt.width}×${tt.height})`
		: 'type not loaded';
	if (!tag) {
		return `<em>Tag not seen by this AP yet</em> — preparing for <strong>${typeLabel}</strong>. Wake / triple-tap when ready to program.`;
	}
	const alias = tag.alias || 'Unnamed';
	if (!tag.hwType) {
		return `<strong>${alias}</strong> — waiting for hardware type from tag<br>Preview type: <strong>${typeLabel}</strong><br>State: <strong>${state}</strong>`;
	}
	return `<strong>${alias}</strong> — ${typeLabel}<br>State: <strong>${state}</strong>`;
}

async function progLoadTag(mac) {
	progMac = progNormalizeMac(mac);
	if (progMac.length !== 16) {
		$('#progtaginfo').textContent = 'Enter a 16-character MAC address when ready to program (image prep works without it).';
		progUpdateStageStatus();
		return;
	}
	$('#progmac').value = progMac;
	$('#progtaginfo').textContent = 'Loading…';
	progUpdateStageStatus();
	try {
		const res = await fetch('get_db?mac=' + progMac);
		const data = await res.json();
		const tag = data.tags?.[0];
		if (!tag) {
			progHwTypeLocked = false;
			progSetHwTypeSelect(progSelectedHwType(), { locked: false });
			const tt = await progResolveTagType();
			$('#progtaginfo').innerHTML = progFormatTagInfo(null, tt);
			if (progLastSource) {
				progSchedulePrepare();
			}
			return;
		}
		if (tag.hwType) {
			progHwType = tag.hwType;
			await getTagtype(progHwType);
			progSetHwTypeSelect(progHwType, { locked: true });
			const tt = tagTypes[progHwType];
			$('#progtaginfo').innerHTML = progFormatTagInfo(tag, tt);
			if (progLastSource) {
				progSchedulePrepare();
			}
			return;
		}
		progHwTypeLocked = false;
		progSetHwTypeSelect(progSelectedHwType(), { locked: false });
		const tt = await progResolveTagType();
		$('#progtaginfo').innerHTML = progFormatTagInfo(tag, tt);
	} catch (e) {
		$('#progtaginfo').textContent = 'Error: ' + e;
	}
}

function progStartPoll() {
	if (progPollTimer) clearInterval(progPollTimer);
	if (!progMac) return;
	progPollTimer = setInterval(async () => {
		try {
			const res = await fetch('get_db?mac=' + progMac);
			const data = await res.json();
			const tag = data.tags?.[0];
			if (!tag) {
				const tt = tagTypes[progHwType] || null;
				$('#progtaginfo').innerHTML = progFormatTagInfo(null, tt);
				return;
			}
			if (tag.hwType && tag.hwType !== progHwType) {
				progHwType = tag.hwType;
				await getTagtype(progHwType);
				progSetHwTypeSelect(progHwType, { locked: true });
				if (progLastSource) {
					progSchedulePrepare();
				}
			}
			const tt = tagTypes[progHwType] || await progResolveTagType();
			$('#progtaginfo').innerHTML = progFormatTagInfo(tag, tt);
		} catch (_) {}
	}, 2500);
}

function progGetFitMode() {
	return $('#progfit')?.value || KIOSK_FIT_CONTAIN;
}

function progGetRotate() {
	return parseInt($('#progrotate')?.value || '0', 10) || 0;
}

function progGetScale() {
	return (parseInt($('#progscale')?.value || '100', 10) || 100) / 100;
}

function progGetShadows() {
	return parseInt($('#progshadows')?.value || '35', 10) || 0;
}

function progGetContrast() {
	return parseInt($('#progcontrast')?.value || '100', 10) || 100;
}

function progGetPanX() {
	return (parseInt($('#progpanx')?.value || '0', 10) || 0) / 100;
}

function progGetPanY() {
	return (parseInt($('#progpany')?.value || '0', 10) || 0) / 100;
}

function progSyncPanLabels() {
	if ($('#progpanxval')) {
		$('#progpanxval').textContent = $('#progpanx')?.value || '0';
	}
	if ($('#progpanyval')) {
		$('#progpanyval').textContent = $('#progpany')?.value || '0';
	}
}

function progResetPan({ prepare = true } = {}) {
	if ($('#progpanx')) {
		$('#progpanx').value = '0';
	}
	if ($('#progpany')) {
		$('#progpany').value = '0';
	}
	progSyncPanLabels();
	if (prepare && progLastSource) {
		progSchedulePrepare();
	}
}

function progGetImageOptions() {
	return {
		fit: progGetFitMode(),
		rotate: progGetRotate(),
		scale: progGetScale(),
		panX: progGetPanX(),
		panY: progGetPanY(),
		tone: {
			shadows: progGetShadows(),
			contrast: progGetContrast(),
		},
		dither: true,
	};
}

function progFitLabel(mode) {
	switch (mode) {
		case KIOSK_FIT_COVER:
			return 'fill (crop edges)';
		case KIOSK_FIT_STRETCH:
			return 'stretch';
		default:
			return 'fit (letterbox)';
	}
}

function progRotateLabel(rot) {
	switch (rot % 4) {
		case 1: return '90° CW';
		case 2: return '180°';
		case 3: return '270° CW';
		default: return '0°';
	}
}

function progShowTagPreview(container, canvas, tt, opts) {
	container.innerHTML = '';
	const caption = document.createElement('p');
	caption.style.margin = '0 0 0.25rem';
	caption.style.fontSize = '0.9rem';
	const zoomPct = Math.round((opts.scale ?? 1) * 100);
	const shadows = opts.tone?.shadows ?? 0;
	const contrast = opts.tone?.contrast ?? 100;
	const panX = Math.round((opts.panX ?? 0) * 100);
	const panY = Math.round((opts.panY ?? 0) * 100);
	caption.textContent = `Preview on tag (${tt.width}×${tt.height}, ${progFitLabel(opts.fit)}, ${progRotateLabel(opts.rotate)}, zoom ${zoomPct}%, pan ${panX}/${panY}, shadows ${shadows}%, contrast ${contrast}%) — drag to pan`;
	const scale = Math.max(1, Math.min(3, Math.floor(560 / tt.width)));
	const wrap = document.createElement('div');
	wrap.style.position = 'relative';
	wrap.style.width = `${tt.width * scale}px`;
	wrap.style.height = `${tt.height * scale}px`;
	wrap.style.overflow = 'hidden';
	wrap.style.border = '1px solid #ccc';
	wrap.style.background = '#fff';
	wrap.style.cursor = 'grab';
	wrap.title = 'Drag to pan image';
	canvas.style.width = `${tt.width * scale}px`;
	canvas.style.height = `${tt.height * scale}px`;
	canvas.style.imageRendering = 'pixelated';
	canvas.style.display = 'block';
	canvas.style.transform = '';
	canvas.style.transformOrigin = '';
	canvas.style.position = '';
	canvas.style.left = '';
	canvas.style.top = '';
	container.appendChild(caption);
	wrap.appendChild(canvas);
	container.appendChild(wrap);
	progAttachPreviewPan(wrap);
}

function progAttachPreviewPan(wrap) {
	wrap.addEventListener('mousedown', (e) => {
		if (e.button !== 0) {
			return;
		}
		progPanDrag = {
			wrap,
			startX: e.clientX,
			startY: e.clientY,
			startPanX: progGetPanX(),
			startPanY: progGetPanY(),
		};
		wrap.style.cursor = 'grabbing';
		e.preventDefault();
	});

	wrap.addEventListener('touchstart', (e) => {
		if (!e.touches?.[0]) {
			return;
		}
		progPanDrag = {
			wrap,
			startX: e.touches[0].clientX,
			startY: e.touches[0].clientY,
			startPanX: progGetPanX(),
			startPanY: progGetPanY(),
		};
	}, { passive: true });

	wrap.addEventListener('touchmove', (e) => {
		if (!progPanDrag || progPanDrag.wrap !== wrap || !e.touches?.[0]) {
			return;
		}
		progPanDragMove(e.touches[0].clientX, e.touches[0].clientY);
	}, { passive: true });

	wrap.addEventListener('touchend', () => {
		if (progPanDrag?.wrap === wrap) {
			progPanDrag = null;
			wrap.style.cursor = 'grab';
		}
	});
}

function progPanDragMove(clientX, clientY) {
	if (!progPanDrag) {
		return;
	}
	const rect = progPanDrag.wrap.getBoundingClientRect();
	if (!rect.width || !rect.height) {
		return;
	}
	const dx = (clientX - progPanDrag.startX) / rect.width;
	const dy = (clientY - progPanDrag.startY) / rect.height;
	const panX = Math.max(-1, Math.min(1, progPanDrag.startPanX + dx));
	const panY = Math.max(-1, Math.min(1, progPanDrag.startPanY + dy));
	if ($('#progpanx')) {
		$('#progpanx').value = String(Math.round(panX * 100));
	}
	if ($('#progpany')) {
		$('#progpany').value = String(Math.round(panY * 100));
	}
	progSyncPanLabels();
	progSchedulePrepare();
}

function progInitPreviewPanHandlers() {
	window.addEventListener('mousemove', (e) => {
		if (!progPanDrag) {
			return;
		}
		progPanDragMove(e.clientX, e.clientY);
	});

	window.addEventListener('mouseup', () => {
		if (!progPanDrag) {
			return;
		}
		progPanDrag.wrap.style.cursor = 'grab';
		progPanDrag = null;
	});
}

async function progPrepareImage(source) {
	if (source !== undefined && source !== null) {
		progLastSource = source;
		progResetPan({ prepare: false });
	} else if (progLastSource) {
		source = progLastSource;
	} else {
		return;
	}
	const tt = await progResolveTagType();
	if (!tt) {
		return;
	}
	const opts = progGetImageOptions();
	$('#progstagestatus').textContent = 'Preparing image…';
	try {
		const rescaled = await kioskRenderToCanvas(source, tt, opts);
		progEncodedImage = kioskPackCanvas(rescaled, tt, opts);
		window.kioskImageBuffers = window.kioskImageBuffers || {};
		if (progMac.length === 16) {
			window.kioskImageBuffers[progMac] = progEncodedImage;
		}
		progUpdateStageStatus();
		const preview = $('#progpreview');
		if (preview) {
			progShowTagPreview(preview, kioskQuantizeCanvas(rescaled, tt, opts), tt, opts);
		}
		showMessage('Image prepared in browser', false);
		progUpdateAnnotateButton();
	} catch (e) {
		progEncodedImage = null;
		progUpdateStageStatus();
		if ($('#progpreview')) {
			$('#progpreview').innerHTML = '';
		}
		showMessage('Image prepare failed: ' + e, true);
	}
}

async function progUploadFile(file) {
	if (!file) return;
	await progPrepareImage(file);
}

function progUpdateAnnotateButton() {
	const btn = $('#progannotate');
	if (!btn) {
		return;
	}
	btn.disabled = !progLastSource;
}

async function progOpenPainter(useBackground) {
	const tt = await progResolveTagType();
	if (!tt) {
		return;
	}
	if (useBackground && !progLastSource) {
		showMessage('Choose an image first', true);
		return;
	}

	$('#progcanvaswrap').innerHTML = '<div id="buttonbar"></div><div id="canvasdiv"></div><div id="layersdiv"></div><p id="savebar"></p>';

	const paintOpts = { hideUpload: true };
	if (useBackground && progLastSource) {
		try {
			paintOpts.backgroundSource = await kioskRenderToCanvas(progLastSource, tt, progGetImageOptions());
		} catch (e) {
			showMessage('Could not prepare image for annotation: ' + e, true);
			return;
		}
	}

	const paintMac = progMac.length === 16 ? progMac : '0000000000000000';

	const start = () => {
		startPainter(paintMac, tt.width, tt.height, tt, paintOpts);
		const savebar = $('#progcanvaswrap #savebar');
		if (savebar) {
			const btn = document.createElement('button');
			btn.textContent = 'Use this image';
			btn.addEventListener('click', async () => {
				const canvas = $('#progcanvaswrap canvas');
				if (canvas) {
					if (typeof canvas.paintCommitPendingText === 'function') {
						canvas.paintCommitPendingText();
					}
					await progPrepareImage(canvas);
				}
			});
			savebar.innerHTML = '';
			savebar.appendChild(btn);
		}
	};

	if (progPaintLoaded) {
		start();
	} else {
		loadScript('painter.js?2.3', () => {
			progPaintLoaded = true;
			start();
		});
	}
}

function progStartPaint() {
	progOpenPainter(false);
}

document.addEventListener('DOMContentLoaded', () => {
	progInitPreviewPanHandlers();
	progSetHwTypeSelect(PROG_DEFAULT_HWTYPE, { locked: false });
	progEnsureHwType(PROG_DEFAULT_HWTYPE);

	$('#progmac').addEventListener('change', () => {
		progLoadTag($('#progmac').value);
		progStartPoll();
	});
	$('#progmac').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			progLoadTag($('#progmac').value);
			progStartPoll();
		}
	});

	$('#proghwtype').addEventListener('change', () => {
		const customWrap = $('#proghwcustomwrap');
		if (customWrap) {
			customWrap.style.display = $('#proghwtype').value === 'custom' ? '' : 'none';
		}
		if (progLastSource) {
			progSchedulePrepare();
		}
	});

	$('#proghwcustom')?.addEventListener('change', () => {
		if (progLastSource) {
			progSchedulePrepare();
		}
	});

	let scanBuf = '';
	document.addEventListener('keypress', (e) => {
		if (document.activeElement === $('#progmac')) return;
		if (e.key.length === 1) scanBuf += e.key;
		else if (e.key === 'Enter' && scanBuf.length > 0) {
			progLoadTag(scanBuf);
			progStartPoll();
			scanBuf = '';
		}
	});

	$('#progfile').addEventListener('change', (e) => {
		const file = e.target.files?.[0];
		if (file) progUploadFile(file);
	});

	$('#progfit').addEventListener('change', () => {
		if (progLastSource) {
			progPrepareImage();
		}
	});

	$('#progrotate').addEventListener('change', () => {
		if (progLastSource) {
			progPrepareImage();
		}
	});

	$('#progscale').addEventListener('input', () => {
		const val = $('#progscale').value;
		if ($('#progscaleval')) {
			$('#progscaleval').textContent = `${val}%`;
		}
		progSchedulePrepare();
	});

	$('#progpanx').addEventListener('input', () => {
		progSyncPanLabels();
		progSchedulePrepare();
	});

	$('#progpany').addEventListener('input', () => {
		progSyncPanLabels();
		progSchedulePrepare();
	});

	$('#progpanreset')?.addEventListener('click', () => {
		progResetPan();
	});

	$('#progshadows').addEventListener('input', () => {
		const val = $('#progshadows').value;
		if ($('#progshadowsval')) {
			$('#progshadowsval').textContent = `${val}%`;
		}
		progSchedulePrepare();
	});

	$('#progcontrast').addEventListener('input', () => {
		const val = $('#progcontrast').value;
		if ($('#progcontrastval')) {
			$('#progcontrastval').textContent = `${val}%`;
		}
		progSchedulePrepare();
	});

	$('#progpaint').addEventListener('click', progStartPaint);
	$('#progannotate').addEventListener('click', () => progOpenPainter(true));

	progUpdateAnnotateButton();

	progSyncPanLabels();

	$('#progprogram').addEventListener('click', async () => {
		progMac = progNormalizeMac($('#progmac')?.value || progMac);
		if (progMac.length !== 16) {
			showMessage('Enter the tag MAC before programming', true);
			return;
		}
		if (!(progEncodedImage instanceof Uint8Array) || progEncodedImage.length === 0) {
			showMessage('Prepare an image first', true);
			return;
		}
		const pin = $('#progpin').value.trim();
		if (!/^[0-9]{6}$/.test(pin)) {
			showMessage('Enter the 6-digit PIN shown on the tag', true);
			return;
		}
		$('#progprogram').disabled = true;
		$('#progstatus').textContent = 'Programming…';
		const fd = new FormData();
		fd.append('mac', progMac);
		fd.append('pin', pin);
		fd.append('image', new Blob([progEncodedImage]), 'kiosk.raw');
		try {
			const res = await fetch('provision_tag', { method: 'POST', body: fd });
			const text = await res.text();
			showMessage(text, !res.ok);
			$('#progstatus').textContent = res.ok ? text : ('Error: ' + text);
			$('#progstatus').style.color = res.ok ? '' : 'crimson';
			await progLoadTag(progMac);
		} catch (error) {
			showMessage('Error: ' + error, true);
			$('#progstatus').textContent = 'Error: ' + error;
		} finally {
			progUpdateStageStatus();
		}
	});

	progUpdateStageStatus();

	const params = new URLSearchParams(window.location.search);
	const qMac = params.get('mac') || params.get('MAC');
	const qPin = params.get('pin') || params.get('PIN');
	if (qMac) {
		progLoadTag(qMac);
		progStartPoll();
	}
	if (qPin != null) {
		const pin = String(qPin).replace(/\D/g, '').slice(0, 6);
		if (/^[0-9]{6}$/.test(pin)) {
			$('#progpin').value = pin;
		}
	}
});

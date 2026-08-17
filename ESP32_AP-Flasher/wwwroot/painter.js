function startPainter(mac, width, height, tagtype, options = {}) {
	let isDrawing = false;
	let lastX = 0;
	let lastY = 0;
	let color = 'black';
	let linewidth = 3;
	let cursor = 'auto';
	let isAddingText = false;
	let layerDiv, intervalId, showCursor, input, textX, textY, font, sizeSelect, isDragging;
	let activeButton = null;
	let hasBackgroundImage = false;
	let brushRange = null;
	let brushVal = null;

	const fonts = ['Roboto', 'Open Sans', 'Lato', 'Montserrat', 'PT Sans', 'Barlow Condensed', 'Headland One', 'Sofia Sans Extra Condensed', 'Mynerve', 'Lilita One', 'Passion One', 'Big Shoulders Display'];

	loadGoogleFonts(fonts);

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d');
	ctx.imageSmoothingEnabled = false;

	const bgCanvas = document.createElement('canvas');
	bgCanvas.width = canvas.width;
	bgCanvas.height = canvas.height;
	const bgCtx = bgCanvas.getContext('2d');

	$("#canvasdiv").appendChild(canvas);
	canvas.style.imageRendering = 'pixelated';

	canvas.addEventListener('mousedown', startDrawing);
	window.addEventListener('mouseup', stopDrawing);
	canvas.addEventListener('mousemove', draw);

	canvas.addEventListener('touchstart', startDrawing, { passive: false });
	window.addEventListener('touchend', stopDrawing);
	canvas.addEventListener('touchmove', draw, { passive: false });

	const rgbToCSSColor = (rgbArray) => `rgb(${rgbArray[0]}, ${rgbArray[1]}, ${rgbArray[2]})`;
	const paletteLabels = ['white', 'black', 'red', 'yellow'];

	function paintFillWhite(targetCtx) {
		targetCtx.fillStyle = '#ffffff';
		targetCtx.fillRect(0, 0, canvas.width, canvas.height);
	}

	function paintRestoreBase() {
		ctx.drawImage(bgCanvas, 0, 0);
	}

	function paintSetActiveButton(button) {
		if (activeButton) {
			activeButton.classList.remove('active');
		}
		activeButton = button;
		if (button) {
			button.classList.add('active');
		}
	}

	function paintUpdateCursor() {
		const r = Math.max(2, Math.round(linewidth / 2));
		cursor = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${r * 2 + 2}' height='${r * 2 + 2}'><circle cx='${r + 1}' cy='${r + 1}' r='${r}' fill='none' stroke='%23000' stroke-opacity='0.45'/></svg>") ${r + 1} ${r + 1}, crosshair`;
		if (!isAddingText && canvas.matches(':hover')) {
			canvas.style.cursor = cursor;
		}
	}

	function paintSetBrushSize(size) {
		linewidth = Math.max(1, Math.min(40, Number(size) || 3));
		if (brushVal) {
			brushVal.textContent = `${linewidth} px`;
		}
		if (brushRange) {
			brushRange.value = String(linewidth);
		}
		paintUpdateCursor();
	}

	function paintStampDot(x, y) {
		ctx.beginPath();
		ctx.fillStyle = color;
		ctx.arc(x, y, linewidth / 2, 0, Math.PI * 2);
		ctx.fill();
	}

	function paintStrokeTo(x, y) {
		ctx.beginPath();
		ctx.moveTo(lastX, lastY);
		ctx.lineTo(x, y);
		ctx.strokeStyle = color;
		ctx.lineWidth = linewidth;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.stroke();
		lastX = x;
		lastY = y;
	}

	function paintChooseColor(rgbArray, button) {
		color = rgbToCSSColor(rgbArray);
		paintSetActiveButton(button);
		if (isAddingText && input) {
			drawText(input.value, textX, textY);
		}
	}

	function paintMakeColorButton(rgbArray, index) {
		const colorButton = document.createElement('button');
		colorButton.type = 'button';
		colorButton.className = 'colorbutton paint-swatch-btn';
		colorButton.title = paletteLabels[index] || `Color ${index}`;
		colorButton.style.backgroundColor = rgbToCSSColor(rgbArray);
		colorButton.addEventListener('click', () => {
			paintChooseColor(rgbArray, colorButton);
		});
		return colorButton;
	}

	paintFillWhite(bgCtx);
	paintFillWhite(ctx);

	const txtButton = document.createElement('button');
	txtButton.type = 'button';
	txtButton.innerHTML = 'tT';
	txtButton.title = 'Add text';
	txtButton.style.fontStyle = 'italic';
	txtButton.addEventListener('click', addText);

	tagtype.colortable.forEach((thiscolor, index) => {
		if (thiscolor[0] === 255 && thiscolor[1] === 255 && thiscolor[2] === 255) {
			return;
		}
		const colorButton = paintMakeColorButton(thiscolor, index);
		if (!activeButton) {
			paintChooseColor(thiscolor, colorButton);
		}
		$("#buttonbar").appendChild(colorButton);
	});

	const whiteButton = document.createElement('button');
	whiteButton.type = 'button';
	whiteButton.className = 'paint-swatch-btn paint-white-btn';
	whiteButton.title = 'Eraser (white)';
	whiteButton.innerHTML = '&#9003;';
	whiteButton.addEventListener('click', () => {
		color = 'white';
		paintSetActiveButton(whiteButton);
		if (isAddingText && input) {
			drawText(input.value, textX, textY);
		}
	});

	const brushWrap = document.createElement('div');
	brushWrap.id = 'paintbrushwrap';
	brushWrap.className = 'paintbrushwrap';

	const brushLabel = document.createElement('label');
	brushLabel.setAttribute('for', 'paintbrushsize');
	brushLabel.textContent = 'Brush';

	const brushRangeInput = document.createElement('input');
	brushRangeInput.type = 'range';
	brushRangeInput.id = 'paintbrushsize';
	brushRangeInput.min = '1';
	brushRangeInput.max = '40';
	brushRangeInput.step = '1';
	brushRangeInput.value = String(linewidth);
	brushRange = brushRangeInput;

	const brushValSpan = document.createElement('span');
	brushValSpan.id = 'paintbrushval';
	brushValSpan.textContent = `${linewidth} px`;
	brushVal = brushValSpan;

	brushRangeInput.addEventListener('input', () => {
		paintSetBrushSize(brushRangeInput.value);
	});

	brushWrap.appendChild(brushLabel);
	brushWrap.appendChild(brushRangeInput);
	brushWrap.appendChild(brushValSpan);

	const clearButton = document.createElement('button');
	clearButton.type = 'button';
	clearButton.className = 'paint-clear-btn';
	clearButton.title = 'Clear drawing';
	clearButton.textContent = 'Clr';
	clearButton.addEventListener('click', () => {
		if (isAddingText) {
			handleFinish(false);
		}
		if (window.confirm('Clear all drawing and text from the canvas?')) {
			paintRestoreBase();
		}
	});

	if (!options.hideUpload) {
		const uploadButton = document.createElement('button');
		uploadButton.innerHTML = 'Upload';
		uploadButton.addEventListener('click', () => {
			if (isAddingText) {
				handleFinish(true);
			}
			const dataURL = canvas.toDataURL('image/jpeg');
			const binaryImage = dataURLToBlob(dataURL);
			const formData = new FormData();
			formData.append('mac', mac);
			formData.append('dither', '0');
			formData.append('contentmode', '22');
			formData.append('file', binaryImage, 'image.jpg');
			const xhr = new XMLHttpRequest();
			xhr.open('POST', '/imgupload');
			xhr.onload = function () {
				const ok = xhr.status >= 200 && xhr.status < 300;
				if (typeof showMessage === 'function') {
					showMessage(xhr.responseText || (ok ? 'Uploaded' : 'Upload failed'), !ok);
				}
				if (ok && typeof loadContentCard === 'function') {
					loadContentCard(mac);
				}
			};
			xhr.onerror = function () {
				if (typeof showMessage === 'function') {
					showMessage('Upload failed', true);
				}
			};
			xhr.send(formData);
			paintShow = false;
		});
		$("#savebar").appendChild(uploadButton);
	}

	$("#buttonbar").appendChild(whiteButton);
	$("#buttonbar").appendChild(txtButton);
	$("#buttonbar").appendChild(clearButton);
	$("#buttonbar").appendChild(brushWrap);

	paintSetBrushSize(linewidth);

	canvas.addEventListener('mouseenter', function () {
		if (!isAddingText) {
			canvas.style.cursor = cursor;
		} else {
			canvas.style.cursor = 'move';
		}
	});

	canvas.addEventListener('mouseleave', function () {
		canvas.style.cursor = 'auto';
	});

	if (options.backgroundSource) {
		paintLoadBackground(options.backgroundSource).catch((err) => {
			console.error('Failed to load painter background', err);
			if (typeof showMessage === 'function') {
				showMessage('Could not load image for annotation', true);
			}
		});
	}

	function startDrawing(e) {
		e.stopPropagation();
		e.preventDefault();
		if (isAddingText) {
			return;
		}
		isDrawing = true;
		const rect = canvas.getBoundingClientRect();
		const scaleX = canvas.width / rect.width;
		const scaleY = canvas.height / rect.height;
		const point = e.touches ? e.touches[0] : e;
		lastX = (point.clientX - rect.left) * scaleX;
		lastY = (point.clientY - rect.top) * scaleY;
		paintStampDot(lastX, lastY);
	}

	function stopDrawing(e) {
		if (isAddingText) {
			return;
		}
		isDrawing = false;
	}

	function draw(e) {
		e.stopPropagation();
		e.preventDefault();
		if (isAddingText || !isDrawing) {
			return;
		}
		const rect = canvas.getBoundingClientRect();
		const scaleX = canvas.width / rect.width;
		const scaleY = canvas.height / rect.height;
		const point = e.touches ? e.touches[0] : e;
		const x = (point.clientX - rect.left) * scaleX;
		const y = (point.clientY - rect.top) * scaleY;
		paintStrokeTo(x, y);
	}

	function addText() {
		if (isAddingText) {
			handleFinish(true);
			return;
		}
		txtButton.classList.add('active');
		bgCtx.drawImage(canvas, 0, 0);

		const defaultX = 5;
		const defaultY = 40;
		isDragging = false;
		let startX, startY;
		showCursor = true;

		textX = defaultX;
		textY = defaultY;
		font = '24px ' + fonts[0];

		input = document.createElement('textarea');
		input.placeholder = 'Type text here';
		input.style.opacity = '0';
		input.style.position = 'absolute';
		input.style.left = '-200px';

		input.addEventListener('input', () => {
			drawText(input.value, textX, textY);
		});
		input.addEventListener('keyup', () => {
			input.selectionStart = input.selectionEnd = input.value.length;
		});
		input.addEventListener('blur', function () {
			input.focus();
		});

		intervalId = setInterval(function () {
			showCursor = !showCursor;
			drawText(input.value, textX, textY);
		}, 300);

		canvas.addEventListener('mouseup', handleMouseUp);
		canvas.addEventListener('mousedown', handleMouseDown);
		canvas.addEventListener('mousemove', handleMouseMove);

		canvas.addEventListener('touchstart', handleTouchStart, { passive: true });
		canvas.addEventListener('touchend', handleTouchEnd);
		canvas.addEventListener('touchmove', handleTouchMove, { passive: true });

		const sizes = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 84, 96, 108, 120, 144, 168, 192, 256, 320, 384, 480, 512];

		const fontSelect = document.createElement('select');
		fontSelect.id = 'font-select';
		for (let i = 0; i < fonts.length; i++) {
			const option = document.createElement('option');
			option.value = fonts[i];
			option.text = fonts[i];
			option.style.fontFamily = fonts[i];
			fontSelect.appendChild(option);
		}

		sizeSelect = document.createElement('select');
		sizeSelect.id = 'size-select';
		for (let i = 0; i < sizes.length; i++) {
			const option = document.createElement('option');
			option.value = sizes[i];
			option.text = sizes[i] + ' px';
			sizeSelect.appendChild(option);
		}

		function updateFont() {
			const selectedFont = fontSelect.value;
			const selectedSize = sizeSelect.value;
			fontSelect.style.fontFamily = selectedFont;
			font = selectedSize + 'px ' + selectedFont;
			drawText(input.value, textX, textY);
		}

		fontSelect.value = fonts[0];
		sizeSelect.value = '24';
		fontSelect.addEventListener('change', updateFont);
		sizeSelect.addEventListener('change', updateFont);

		const finishButton = document.createElement('button');
		finishButton.type = 'button';
		finishButton.innerHTML = '&#10004;';
		finishButton.title = 'Finish text';
		finishButton.addEventListener('click', clickHandleFinish);

		const textColorBar = document.createElement('div');
		textColorBar.className = 'painttextcolors';

		tagtype.colortable.forEach((thiscolor, index) => {
			if (thiscolor[0] === 255 && thiscolor[1] === 255 && thiscolor[2] === 255) {
				return;
			}
			textColorBar.appendChild(paintMakeColorButton(thiscolor, index));
		});

		layerDiv = document.createElement('div');
		layerDiv.appendChild(textColorBar);
		layerDiv.appendChild(input);
		layerDiv.appendChild(fontSelect);
		layerDiv.appendChild(sizeSelect);
		layerDiv.appendChild(finishButton);
		$("#layersdiv").appendChild(layerDiv);
		input.focus();

		isAddingText = true;
		if (color === 'white') {
			const firstColor = document.querySelector('#buttonbar .colorbutton');
			if (firstColor) {
				firstColor.click();
			}
		}
	}

	function handleFinish(apply) {
		clearInterval(intervalId);
		intervalId = null;
		showCursor = false;
		isAddingText = false;
		cursor = 'auto';
		if (layerDiv) {
			layerDiv.remove();
			layerDiv = null;
		}
		canvas.removeEventListener('mousedown', handleMouseDown);
		canvas.removeEventListener('mouseup', handleMouseUp);
		canvas.removeEventListener('mousemove', handleMouseMove);
		canvas.removeEventListener('touchstart', handleTouchStart);
		canvas.removeEventListener('touchend', handleTouchEnd);
		canvas.removeEventListener('touchmove', handleTouchMove);
		if (apply) {
			drawText(input.value, textX, textY);
			bgCtx.drawImage(canvas, 0, 0);
		} else {
			paintRestoreBase();
		}
		txtButton.classList.remove('active');
	}

	function drawText(text, x, y) {
		paintRestoreBase();
		ctx.save();
		ctx.translate(x, y);
		ctx.font = font;
		ctx.fillStyle = color;
		const lines = text.split('\n');
		lines.forEach((line, index) => {
			const showCaret = isAddingText && showCursor && index === lines.length - 1;
			ctx.fillText(line + (showCaret ? '|' : ''), 0, index * (sizeSelect.value * 1.1));
		});
		ctx.restore();
	}

	function handleMouseDown(e) {
		isDragging = true;
		startX = textX;
		startY = textY;
		({ clientX: lastMouseX, clientY: lastMouseY } = e);
	}

	function handleMouseMove(e) {
		if (isDragging) {
			const { clientX, clientY } = e;
			textX = startX + clientX - lastMouseX;
			textY = startY + clientY - lastMouseY;
			drawText(input.value, textX, textY);
		}
	}

	function handleTouchStart(e) {
		isDragging = true;
		startX = textX;
		startY = textY;
		({ clientX: lastTouchX, clientY: lastTouchY } = e.touches[0]);
	}

	function handleTouchMove(e) {
		if (isDragging) {
			const { clientX, clientY } = e.touches[0];
			textX = startX + clientX - lastTouchX;
			textY = startY + clientY - lastTouchY;
			drawText(input.value, textX, textY);
		}
	}

	function handleMouseUp() {
		isDragging = false;
	}

	function handleTouchEnd() {
		isDragging = false;
	}

	function clickHandleFinish() {
		handleFinish(true);
	}

	async function paintLoadBackground(source) {
		const img = await paintSourceToImage(source);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		bgCtx.drawImage(img, 0, 0, bgCanvas.width, bgCanvas.height);
		hasBackgroundImage = true;
	}

	canvas.paintCommitPendingText = function () {
		if (isAddingText) {
			handleFinish(true);
		}
	};
}

function paintSourceToImage(source) {
	return new Promise((resolve, reject) => {
		if (source instanceof HTMLImageElement) {
			if (source.complete && source.naturalWidth) {
				resolve(source);
			} else {
				source.onload = () => resolve(source);
				source.onerror = () => reject(new Error('Failed to load image'));
			}
			return;
		}
		if (source instanceof HTMLCanvasElement) {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('Failed to load canvas'));
			img.src = source.toDataURL('image/png');
			return;
		}
		const img = new Image();
		img.onload = () => {
			if (source instanceof Blob) {
				URL.revokeObjectURL(img.src);
			}
			resolve(img);
		};
		img.onerror = () => reject(new Error('Failed to load image'));
		if (source instanceof Blob || source instanceof File) {
			img.src = URL.createObjectURL(source);
		} else if (typeof source === 'string') {
			img.src = source;
		} else {
			reject(new Error('Unsupported image source'));
		}
	});
}

function loadGoogleFonts(fonts) {
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = 'https://fonts.googleapis.com/css?family=' + fonts.join('|');
	document.head.appendChild(link);
}

function dataURLToBlob(dataURL) {
	const byteString = atob(dataURL.split(',')[1]);
	const mimeString = dataURL.split(',')[0].split(':')[1].split(';')[0];
	const arrayBuffer = new ArrayBuffer(byteString.length);
	const uint8Array = new Uint8Array(arrayBuffer);
	for (let i = 0; i < byteString.length; i++) {
		uint8Array[i] = byteString.charCodeAt(i);
	}
	return new Blob([arrayBuffer], { type: mimeString });
}

paintLoaded = true;

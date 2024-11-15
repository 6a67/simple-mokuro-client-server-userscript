// ==UserScript==
// @name Mokuro Browser-to-Server OCR
// @namespace http://tampermonkey.net/
// @version 0.0.1
// @description Finds images, sends them to the mokuro server and overlays the OCR text on the image
// @match *://*/*
// @grant GM_xmlhttpRequest
// @grant GM_notification
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_registerMenuCommand
// @grant GM_unregisterMenuCommand
// @grant GM_addStyle
// @run-at document-start
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        server_url: 'http://localhost:4527',
    };

    function addCss() {
        GM_addStyle(`
        .text-outline {
            outline: 2px solid rgba(128, 128, 128, 0.5);
            border-radius: 8px;
        }
        .bubble-text {
            color: black;
            opacity: 0.0;
            pointer-events: auto;
            text-align: left;
            vertical-align: top;
        }
        .bubble-text:hover {
            opacity: 1.0;
            background-color: rgba(255, 255, 255, 1);
        }
        `);
    }

    function getXPath(element) {
        if (element.id !== '') {
            return `//*[@id="${element.id}"]`;
        }
        if (element === document.body) {
            return '/html/body';
        }
        let ix = 0;
        const siblings = element.parentNode ? element.parentNode.childNodes : [];
        for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === element) {
                return `${getXPath(element.parentNode)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
            }
            if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
                ix++;
            }
        }
    }

    function getElementByXPath(xpath) {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    }

    function getAllImages() {
        return document.querySelectorAll('img, [style*="background-image"]');
    }

    function getBiggestImageXpath() {
        const images = getAllImages();
        let biggestImage = null;
        let biggestArea = 0;
        for (let i = 0; i < images.length; i++) {
            const { actualWidth, actualHeight } = getActualImageSize(images[i]);
            const area = actualWidth * actualHeight;
            if (area > biggestArea) {
                biggestArea = area;
                biggestImage = images[i];
            }
        }
        const windowArea = window.innerWidth * window.innerHeight;
        return biggestImage && biggestArea / windowArea >= 0.1 ? getXPath(biggestImage) : null;
    }

    function getBiggestVisibleImageXpath() {
        const images = getAllImages();
        let biggestImage = null;
        let biggestArea = 0;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const rect = img.getBoundingClientRect();
    
            // Calculate the visible area of the image
            const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
            const visibleArea = visibleWidth * visibleHeight;
    
            if (visibleArea > biggestArea) {
                biggestArea = visibleArea;
                biggestImage = img;
            }
        }
        return biggestImage ? getXPath(biggestImage) : null;
    }

    async function getImageBytes(element) {
        let imgUrl;
        if (element.dataset.upscaled === 'true' && element.dataset.originalSrc) {
            imgUrl = element.dataset.originalSrc; 
        } else if (element.tagName === 'IMG') {
            imgUrl = element.src;
        } else {
            const bgImage = window.getComputedStyle(element).backgroundImage;
            imgUrl = bgImage.slice(5, -2);
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: imgUrl,
                responseType: 'arraybuffer',
                headers: {
                    'Referer': window.location.href,
                },
                onload: function (response) {
                    const bytes = new Uint8Array(response.response);
                    resolve(bytes);
                },
                onerror: function (error) {
                    reject(error);
                },
            });
        });
    }

    function getActualImageSize(img) {
        const transform = window.getComputedStyle(img).getPropertyValue('transform');
        let scale = 1;
        try {
            if (transform !== 'none') {
                let matrixValues = transform.match(/matrix\((.+)\)/)[1].split(', ');
                scale = parseFloat(matrixValues[0]);
            }
        } catch (error) {
            // console.error('Error parsing transform:', error);
        }
        const actualWidth = img.offsetWidth * scale;
        const actualHeight = img.offsetHeight * scale;
        return { actualWidth, actualHeight };
    }

    function overlayText(xpath_selector, image_data) {
        const img = getElementByXPath(xpath_selector);
        if (!img) {
            console.error('Image not found for xpath:', xpath_selector);
            return;
        }

        const container_id = btoa(xpath_selector);
        let container = document.getElementById(container_id) || document.createElement('div');
        container.id = container_id;
        container.className = 'ocr-text-container';
        container.style.position = 'absolute';
        container.style.pointerEvents = 'none';
        img.parentNode.insertBefore(container, img.nextSibling);

        function updateOutlines() {
            const parent = img.offsetParent || img.parentElement;
            const parentRect = parent?.getBoundingClientRect();
            const imgRect = img.getBoundingClientRect();
            const relativeLeft = imgRect.left - (parentRect?.left || 0);
            const relativeTop = imgRect.top - (parentRect?.top || 0);
            container.style.left = `${relativeLeft}px`;
            container.style.top = `${relativeTop}px`;

            const style = window.getComputedStyle(img);
            const width = parseInt(style.width);
            const height = parseInt(style.height);
            if (width > 0) container.style.width = `${width}px`;
            if (height > 0) container.style.height = `${height}px`;

            const { actualWidth, actualHeight } = getActualImageSize(img);
            const scale_factor = actualWidth / image_data.img_width;

            image_data.blocks.forEach((block, i) => {
                const id = btoa(xpath_selector) + i;
                let outline = document.getElementById(id) || document.createElement('div');
                const [x1, y1, x2, y2] = block.box;
                const relX = x1 / image_data.img_width;
                const relY = y1 / image_data.img_height;
                const relWidth = (x2 - x1) / image_data.img_width;
                const relHeight = (y2 - y1) / image_data.img_height;

                outline.className = 'text-outline';
                outline.style.position = 'absolute';
                outline.style.top = `${relY * 100}%`;
                outline.style.right = `${(1 - relX - relWidth) * 100}%`;
                outline.style.width = `${relWidth * 100}%`;
                outline.style.height = `${relHeight * 100}%`;

                const textDiv = document.createElement('div');
                textDiv.className = 'bubble-text';
                let text = block.lines.join('\n');
                textDiv.textContent = text;
                textDiv.style.fontSize = `${block.font_size * scale_factor}px`;
                textDiv.style.whiteSpace = 'pre';
                textDiv.style.overflow = 'visible';

                if (block.vertical) {
                    textDiv.style.writingMode = 'vertical-rl';
                    textDiv.style.textOrientation = 'upright';
                    textDiv.style.top = '0%';
                    textDiv.style.right = '0%';
                } else {
                    textDiv.style.bottom = '0%';
                    textDiv.style.left = '0%';
                }
                textDiv.style.position = 'absolute';
                textDiv.lang = 'ja';

                outline.innerHTML = '';
                outline.appendChild(textDiv);
                outline.style.overflow = 'visible';
                outline.id = id;
                container.appendChild(outline);
            });
        }

        img.onload = updateOutlines;
        const resizeObserver = new ResizeObserver(updateOutlines);
        resizeObserver.observe(img);
        const mutationObserver = new MutationObserver(updateOutlines);
        mutationObserver.observe(img, { attributes: true });
        mutationObserver.observe(img.parentNode, { attributes: true });
        window.addEventListener('resize', updateOutlines);
        window.addEventListener('zoom', updateOutlines);
        window.addEventListener('scroll', updateOutlines);
    }

    function addOCROverlayToImage(xpath) {
        const element = getElementByXPath(xpath);
        if (!element) {
            console.error('Element not found for xpath:', xpath);
            return;
        }
        getImageBytes(element)
            .then((bytes) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: CONFIG.server_url,
                    headers: {
                        'Content-Type': 'application/octet-stream',
                    },
                    data: bytes,
                    responseType: 'json',
                    onload: function (response) {
                        try {
                            const json = JSON.parse(response.responseText);
                            overlayText(xpath, json);
                        } catch (error) {
                            console.error('Invalid JSON response', response.responseText);
                            GM_notification('Error: Invalid JSON response');
                        }
                    },
                    onerror: function (error) {
                        console.error('Request failed', error);
                        GM_notification('Error: Request failed');
                    },
                });
            })
            .catch((error) => {
                console.error('Failed to get image bytes', error);
                GM_notification('Error: Failed to get image bytes');
            });
    }

    function initKeyListeners() {
        let buttons = [];
        document.addEventListener('keydown', (event) => {
            if (event.altKey && !buttons.length) {
                const elements = getAllImages();
                elements.forEach((element) => {
                    const { actualWidth, actualHeight } = getActualImageSize(element);
                    const windowWidth = window.innerWidth;
                    const windowHeight = window.innerHeight;
                    if (actualWidth / windowWidth < 0.1 || actualHeight / windowHeight < 0.1) {
                        return;
                    }
                    const button = document.createElement('button');
                    button.textContent = 'モ';
                    button.style.cssText = `
                        position: fixed;
                        top: ${element.getBoundingClientRect().top}px;
                        left: ${element.getBoundingClientRect().right - 30}px;
                        z-index: 9999;
                        font-size: 16px;
                        padding: 5px;
                        background-color: white;
                        border: 1px solid black;
                        cursor: pointer;
                    `;
                    button.onclick = () => {
                        const xpath = getXPath(element);
                        addOCROverlayToImage(xpath);
                    };
                    document.body.appendChild(button);
                    buttons.push({ button, element });
                });
            }
        });

        document.addEventListener('keyup', (event) => {
            if (!event.altKey) {
                buttons.forEach(({ button }) => button.remove());
                buttons = [];
            }
        });

        window.addEventListener('scroll', () => {
            if (buttons.length) {
                buttons.forEach(({ button, element }) => {
                    button.style.top = `${element.getBoundingClientRect().top}px`;
                    button.style.left = `${element.getBoundingClientRect().right - 30}px`;
                });
            }
        });
    }

    function removeOCROverlays() {
        const elements = document.querySelectorAll('.ocr-text-container');
        elements.forEach((element) => {
            element.remove();
        });
        previousBiggestImageXpath = null;
        previousBiggestImageSrc = null;
    }

    function addUrlChangeListener() {
        let currentUrl = window.location.href;
        window.addEventListener('popstate', () => {
            handleUrlChange();
        });

        const urlObserver = new MutationObserver((mutations) => {
            mutations.forEach(() => {
                if (currentUrl !== window.location.href) {
                    currentUrl = window.location.href;
                    handleUrlChange();
                }
            });
        });

        urlObserver.observe(document.body, { childList: true, subtree: true });
    }

    function getAutoMode() {
        const hostname = window.location.hostname;
        return GM_getValue(`auto_mode_${btoa(hostname)}`, false);
    }

    let previousBiggestImageXpath = null;
    let previousBiggestImageSrc = null;
    let mutationObserver = null;

    function autoMode() {
        if (!getAutoMode()) {
            // Disconnect the observer if auto mode is disabled
            if (mutationObserver) {
                mutationObserver.disconnect();
                mutationObserver = null;
            }
            // Remove event listeners
            window.removeEventListener('resize', handleAutoModeChange);
            window.removeEventListener('scroll', handleAutoModeChange);
            return;
        }
        handleAutoModeChange();
        // Add event listeners
        window.addEventListener('resize', handleAutoModeChange);
        window.addEventListener('scroll', handleAutoModeChange);
    }
    
    function handleAutoModeChange() {
        const xpath = getBiggestVisibleImageXpath();
        const biggestImageElement = xpath ? getElementByXPath(xpath) : null;
        const src = biggestImageElement ? biggestImageElement.dataset.originalSrc || biggestImageElement.src || biggestImageElement.style.backgroundImage : null;
        if (xpath !== previousBiggestImageXpath || src !== previousBiggestImageSrc) {
            removeOCROverlays();
            previousBiggestImageXpath = xpath;
            previousBiggestImageSrc = src;
            if (xpath) {
                addOCROverlayToImage(xpath);
            }
        }
    }

    function handleUrlChange() {
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        removeOCROverlays();
        handleAutoModeChange();
    }

    function toggleAutoMode(registerFn) {
        const hostname = window.location.hostname;
        GM_setValue(`auto_mode_${btoa(hostname)}`, !getAutoMode());
        GM_notification(`Auto Mode ${getAutoMode() ? 'enabled' : 'disabled'}`);
        if (registerFn) {
            registerFn();
        }
        autoMode();
    }

    function registerAutoModeMenuCommand() {
        let menuCommandId = null;

        return function updateMenuCommand() {
            if (menuCommandId !== null) {
                GM_unregisterMenuCommand(menuCommandId);
            }
            if (getAutoMode()) {
                menuCommandId = GM_registerMenuCommand('Disable Auto Mode for this site', () => toggleAutoMode(updateMenuCommand));
            } else {
                menuCommandId = GM_registerMenuCommand('Enable Auto Mode for this site', () => toggleAutoMode(updateMenuCommand));
            }
        };
    }

    function init() {
        addCss();
        initKeyListeners();
        addUrlChangeListener();
        const updateMenuCommand = registerAutoModeMenuCommand();
        updateMenuCommand();
        autoMode();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

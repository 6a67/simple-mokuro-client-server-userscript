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
            user-select: text;
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
                // console.log('Visible area:', visibleArea);
                // console.log('Image:', img);
                // console.log('Rect:', rect);
                biggestArea = visibleArea;
                biggestImage = img;
            }
        }
        const windowArea = window.innerWidth * window.innerHeight;
        return biggestImage && biggestArea / windowArea >= 0.1 ? getXPath(biggestImage) : null;
    }

    async function getImageBytes(element) {
        let imgUrl;
        if (element.dataset.originalSrc) {
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

        let isHandlingUpdate = false;

        function calculateBlockDimensions(block) {
            const [x1, y1, x2, y2] = block.box;
            return {
                relX: x1 / image_data.img_width,
                relY: y1 / image_data.img_height,
                relWidth: (x2 - x1) / image_data.img_width,
                relHeight: (y2 - y1) / image_data.img_height,
            };
        }

        function createTextElements() {
            const { actualWidth } = getActualImageSize(img);
            const scale_factor = actualWidth / image_data.img_width;

            image_data.blocks.forEach((block, i) => {
                const id = btoa(xpath_selector) + i;
                let outline = document.createElement('div');
                outline.className = 'text-outline';
                outline.style.position = 'absolute';
                outline.id = id;
                outline.style.overflow = 'visible';

                const textDiv = document.createElement('div');
                textDiv.className = 'bubble-text';
                textDiv.textContent = block.lines.join('\n');
                textDiv.style.fontSize = `${block.font_size * scale_factor}px`;
                textDiv.style.whiteSpace = 'pre';
                textDiv.style.overflow = 'visible';
                textDiv.style.position = 'absolute';
                textDiv.lang = 'ja';

                if (block.vertical) {
                    textDiv.style.writingMode = 'vertical-rl';
                    textDiv.style.textOrientation = 'upright';
                    textDiv.style.top = '0%';
                    textDiv.style.right = '0%';
                } else {
                    textDiv.style.bottom = '0%';
                    textDiv.style.left = '0%';
                }

                outline.appendChild(textDiv);
                container.appendChild(outline);
            });
        }

        function updateElementPositions() {
            if (isHandlingUpdate) return;
            isHandlingUpdate = true;

            const parent = img.offsetParent || img.parentElement;
            const parentRect = parent?.getBoundingClientRect();
            const imgRect = img.getBoundingClientRect();

            // Update container position
            container.style.left = `${imgRect.left - (parentRect?.left || 0)}px`;
            container.style.top = `${imgRect.top - (parentRect?.top || 0)}px`;

            // Update container size
            const style = window.getComputedStyle(img);
            const width = parseInt(style.width);
            const height = parseInt(style.height);
            if (width > 0) container.style.width = `${width}px`;
            if (height > 0) container.style.height = `${height}px`;

            // Update block positions
            image_data.blocks.forEach((block, i) => {
                const outline = document.getElementById(btoa(xpath_selector) + i);
                if (!outline) return;

                const { relX, relY, relWidth, relHeight } = calculateBlockDimensions(block);
                outline.style.top = `${relY * 100}%`;
                outline.style.right = `${(1 - relX - relWidth) * 100}%`;
                outline.style.width = `${relWidth * 100}%`;
                outline.style.height = `${relHeight * 100}%`;
            });

            isHandlingUpdate = false;
        }

        function setupUpdateListeners() {
            const events = ['load', 'resize', 'zoom', 'scroll'];
            events.forEach((event) => window.addEventListener(event, updateElementPositions));

            const resizeObserver = new ResizeObserver(updateElementPositions);
            resizeObserver.observe(img);

            const mutationObserver = new MutationObserver(updateElementPositions);
            mutationObserver.observe(img, { attributes: true });
            mutationObserver.observe(img.parentNode, { attributes: true });

            document.querySelectorAll('*').forEach((element) => {
                if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
                    element.addEventListener('scroll', updateElementPositions);
                }
            });
        }

        createTextElements();
        setupUpdateListeners();
        updateElementPositions();

        const event = new CustomEvent('mokuro-browser-to-server.ocr-overlayed', { detail: { targetImg: img, overlayContainer: container }, bubbles: true });
        document.dispatchEvent(event);
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

    function isImageElement(element) {
        return (
            element.tagName === 'IMG' ||
            (element.style && element.style.backgroundImage && element.style.backgroundImage !== 'none') ||
            getComputedStyle(element).backgroundImage !== 'none'
        );
    }

    function checkForImagesRecursively(element) {
        if (!element) return false;

        if (isImageElement(element)) {
            return true;
        }

        for (const child of element.children) {
            if (checkForImagesRecursively(child)) {
                return true;
            }
        }

        return false;
    }

    function attachImageLoadListener(img) {
        img.addEventListener('load', () => {
            // console.log('Image loaded:', img);
            handleAutoModeChange();
            img.removeEventListener('load', () => {});
        });
    }

    let previousBiggestImageXpath = null;
    let previousBiggestImageSrc = null;
    let mutationObserver = null;

    let attachedScrollElements = new Set();
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
            attachedScrollElements.forEach((element) => {
                element.removeEventListener('scroll', handleAutoModeChange);
            });
            return;
        }
        document.querySelectorAll('img').forEach(attachImageLoadListener);
        handleAutoModeChange();
        // Add event listeners
        window.addEventListener('resize', handleAutoModeChange);
        window.addEventListener('scroll', handleAutoModeChange);
        document.querySelectorAll('*').forEach((element) => {
            if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
                element.addEventListener('scroll', handleAutoModeChange);
                attachedScrollElements.add(element);
            }
        });
        mutationObserver = new MutationObserver((mutations) => {
            // console.log('Mutations:', mutations);
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && (mutation.attributeName === 'src' || mutation.attributeName === 'style')) {
                    // console.log('Image src or style changed:', mutation.target);
                    handleAutoModeChange();
                    if (mutation.target.tagName === 'IMG') {
                        attachImageLoadListener(mutation.target);
                    }
                } else if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'IMG') {
                                attachImageLoadListener(node);
                            }
                            if (checkForImagesRecursively(node)) {
                                // console.log('New image found in:', node);
                                handleAutoModeChange();
                                node.querySelectorAll('img').forEach(attachImageLoadListener);
                            }
                        }
                    });
                }
            });
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style'] });
    }

    let isHandlingAutoModeChange = false;

    function handleAutoModeChange() {
        if (isHandlingAutoModeChange) return;
        isHandlingAutoModeChange = true;

        const xpath = getBiggestVisibleImageXpath();
        const biggestImageElement = xpath ? getElementByXPath(xpath) : null;
        const src = biggestImageElement
            ? biggestImageElement.dataset.originalSrc || biggestImageElement.src || biggestImageElement.style.backgroundImage
            : null;
        if ((xpath && xpath !== previousBiggestImageXpath) || src !== previousBiggestImageSrc) {
            removeOCROverlays();
            previousBiggestImageXpath = xpath;
            previousBiggestImageSrc = src;
            if (xpath) {
                addOCROverlayToImage(xpath);
            }
        }

        isHandlingAutoModeChange = false;
    }

    function handleUrlChange() {
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        removeOCROverlays();
        autoMode();
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

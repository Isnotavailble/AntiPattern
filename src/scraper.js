import { chromium } from 'playwright';

export async function initBrowser() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    return { browser, page };
}

export async function detectPatterns(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        if (tables.length > 0) return { type: 'table', count: tables.length, sample: tables[0].innerText.substring(0, 100).replace(/\n/g, ' ') };

		const signatureCounts = {};
        document.querySelectorAll('div, li, article').forEach(el => {
            const cls = el.className;
            if (cls && typeof cls === 'string' && cls.trim() !== '') {
				const trimmedCls = cls.trim();
				const signature = `${el.tagName.toLowerCase()}.${trimmedCls.replace(/\s+/g, '.')}`;
				signatureCounts[signature] = (signatureCounts[signature] || 0) + 1;
            }
        });

		let bestSignature = null, maxCount = 0;
		for (const [sig, count] of Object.entries(signatureCounts)) {
			if (count >= 3 && count > maxCount) { maxCount = count; bestSignature = sig; }
        }

		if (bestSignature) {
			const sampleEl = document.querySelector(bestSignature);
			return { type: 'div_soup', selector: bestSignature, count: maxCount, sample: sampleEl ? sampleEl.innerText.substring(0, 100).replace(/\n/g, ' ') : '' };
        }
        return { type: 'none' };
    });
}
function cleanText(text) {
    if (!text) return "";
    return text
        .replace(/[\r\n\t]+/g, ' ')  // Replace newlines and tabs with a single space
        .replace(/\s\s+/g, ' ')       // Replace multiple spaces with one space
        .replace(/\|\s*\|/g, '|')     // Remove empty pipes
        .trim();                      // Remove leading/trailing whitespace
}

// 2. Update extractData to use textContent() instead of innerText()
export async function extractData(page, selector) {
    const elements = page.locator(selector);
    const count = await elements.count();
    const results = [];
    
    for (let i = 0; i < count; ++i) {
        // textContent() ignores CSS styling and grabs the raw HTML text
        const rawText = await elements.nth(i).textContent(); 
        results.push({ 
            id: i + 1, 
            content: cleanText(rawText) // Assuming you added the cleanText helper earlier
        });
    }
    return results;
}
export async function huntApis(page, url, capturePayloads) {
    const interceptedApis = [];
    page.on('response', async (response) => {
        const reqType = response.request().resourceType();
        if (reqType === 'fetch' || reqType === 'xhr') {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('application/json')) {
                const apiData = { url: response.url(), method: response.request().method() };
                if (capturePayloads) {
                    try { apiData.payload = await response.json(); } 
                    catch (e) { apiData.payload = "Invalid JSON"; }
                }
                interceptedApis.push(apiData);
            }
        }
    });

    try {
        // Change 'networkidle' to 'load' (waits for all HTML/CSS/images to finish)
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        
        // Wait an extra 3 seconds to ensure React/Vue AJAX calls finish firing
        await page.waitForTimeout(3000); 
    } catch (error) {
		if (error.name === 'TimeoutError') {
			// If it times out, intercept the crash and keep going
			console.log('\n  ⚠ Page load took too long, but saving intercepted APIs anyway...');
		} else {
			throw new Error(`Critical Page Failure: ${error.message}`);
		}
    }

    return interceptedApis;
}

// --- NEW: The Action-Observer Model ---
export async function strikeTarget(page, url, selector) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    const target = page.locator(selector).first();
    await target.waitFor({ state: 'visible', timeout: 15000 });

    // Step 1: Set the Traps (5 second timeout for each)
    const timeoutMsg = 'TRAP_TIMEOUT';
    
    const apiTrap = page.waitForResponse(
        res => (res.request().resourceType() === 'fetch' || res.request().resourceType() === 'xhr') 
                && (res.headers()['content-type'] || '').includes('application/json'),
        { timeout: 5000 }
    ).then(async res => {
        let payload = 'Empty Body';
        try { payload = await res.json(); } catch(e) {}
        return { type: 'api', url: res.url(), payload: payload };
    }).catch(() => timeoutMsg);

    const navTrap = page.waitForNavigation({ timeout: 5000 })
        .then(() => ({ type: 'redirect', url: page.url() }))
        .catch(() => timeoutMsg);

    const popupTrap = page.context().waitForEvent('page', { timeout: 5000 })
        .then(async newPage => {
            await newPage.waitForLoadState('domcontentloaded');
            const popupUrl = newPage.url();
            await newPage.close(); // Close the popup to keep things clean
            return { type: 'popup', url: popupUrl };
        }).catch(() => timeoutMsg);

    // Step 2: Trigger the target
    await target.click();

    // Step 3: Wait for the dust to settle
    const [apiResult, navResult, popupResult] = await Promise.all([apiTrap, navTrap, popupTrap]);

    // Step 4: Classify the outcome
	const successfulEvents = [];
	if (apiResult !== timeoutMsg) successfulEvents.push(apiResult);
	if (popupResult !== timeoutMsg) successfulEvents.push(popupResult);
	if (navResult !== timeoutMsg && navResult.url !== url) successfulEvents.push(navResult);

	if (successfulEvents.length === 0) {
		return { type: 'dead_end', message: 'Button clicked, but no network or navigation events were triggered.' };
	}

	const primaryEvent = successfulEvents[0];
	if (successfulEvents.length > 1) {
		primaryEvent.concurrentEvents = successfulEvents.slice(1);
	}
	return primaryEvent;
}
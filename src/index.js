import { intro, outro, text, select, confirm, spinner, isCancel, cancel } from '@clack/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import fs from 'fs';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { initBrowser, detectPatterns, extractData, huntApis, strikeTarget } from './scraper.js';
import { saveFile } from './exporter.js';

// Cleanly handles Ctrl+C / Esc exits anywhere in the UI
function handleCancel(value) {
	if (isCancel(value)) {
		cancel('Operation cancelled. See you next time!');
		process.exit(0);
	}
    return value;
}

function showBanner() {
    console.clear();
    console.log(gradient.atlas.multiline(figlet.textSync('AntiPattern', { font: 'Slant' })));
    console.log('\n');
}

async function checkAndInstallBrowser() {
    const expectedPath = chromium.executablePath();
    if (!fs.existsSync(expectedPath)) {
        const proceed = handleCancel(await confirm({ message: 'First Run Detected: Missing Chromium Engine. Download now? (~150MB)', initialValue: true }));
        if (!proceed) { cancel('Cannot proceed without engine.'); process.exit(0); }

        console.log(chalk.cyan('\n╭── Downloading Engine...'));
        await new Promise((resolve, reject) => {
            const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            const installProcess = spawn(npxCommand, ['playwright', 'install', 'chromium'], { stdio: 'inherit',shell: true });
            installProcess.on('close', (code) => {
                if (code === 0) { console.log(chalk.cyan('╰── Download Complete!\n')); resolve(); } 
                else { cancel(`Installation failed.`); process.exit(1); }
            });
        });
    }
}
async function promptForUrl() {
	while (true) {
		// 1. Strict Format Validation
		const urlInput = handleCancel(await text({
			message: 'Enter the website URL to scrape:',
			placeholder: 'https://example.com',
			validate(value) {
				if (!value || typeof value !== 'string' || value.trim() === '') return 'URL is required!';
				const trimmedUrl = value.trim();
				if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) return 'Must start with http:// or https://';
				try {
					const parsed = new URL(trimmedUrl);
					if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return 'URL must contain a valid domain (e.g., .com, .net) or localhost.';
					const strictRegex = /^https?:\/\/([a-zA-Z0-9.-]+)(:\d+)?(\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?$/;
					if (!strictRegex.test(trimmedUrl)) return 'URL contains invalid or non-standard characters!';
				} catch {
					return 'Invalid URL format. Please check for typos.';
				}
			}
		})).trim();

		const s = spinner();
		s.start(`Pinging ${chalk.cyan(urlInput)} to verify it is online...`);

		// 2. Live Server Ping Verification
		try {
			// Using AbortController for a strict 8-second timeout so the CLI doesn't hang forever
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 8000);

			const response = await fetch(urlInput, {
				method: 'GET',
				signal: controller.signal,
				headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
			});

			clearTimeout(timeoutId);

			// Accept 200 OK, and accept 401/403 (often means the site is alive but has a WAF blocking our basic ping)
			if (response.ok || response.status === 403 || response.status === 401) {
				s.stop(`  ${chalk.green('✔')} Target verified and reachable.`);
				return urlInput;
			} else if (response.status === 404) {
				s.stop(`  ${chalk.red('✖')} Host exists, but the specific page returned 404 Not Found.`);
				console.log(chalk.yellow('Please check the URL path and try again.\n'));
			} else {
				s.stop(`  ${chalk.yellow('⚠')} Server responded with HTTP ${response.status}.`);
				const proceed = handleCancel(await confirm({ message: 'Do you want to proceed anyway?', initialValue: false }));
				if (proceed) return urlInput;
				console.log(''); // spacer
			}
		} catch (error) {
			if (error.name === 'AbortError') {
				s.stop(`  ${chalk.red('✖')} Connection timed out. Server is unresponsive.`);
			} else {
				s.stop(`  ${chalk.red('✖')} Failed to reach host (DNS or Network Error).`);
			}
			console.log(chalk.yellow('Ensure the URL is typed correctly and the server is online.\n'));
		}
	}
}

async function runExtractionSession() {
	// 1. Bulletproof URL Validation
    const targetUrl = await promptForUrl();

    const outputFormat = handleCancel(await select({
        message: 'Select output format:',
        options: [
            { value: 'json', label: 'JSON File', hint: 'Best for nested API data and Code' },
            { value: 'csv', label: 'CSV File', hint: 'Best for flat Tables/Excel' }
        ]
    }));

    const mode = handleCancel(await select({
        message: 'Select your extraction method:',
        options: [
            { value: 'auto', label: 'Magic Auto-Detect', hint: 'Finds Tables & Repeating Div Patterns' },
            { value: 'target', label: 'Target & Strike', hint: 'Provide a CSS target to extract OR click/trace' },
            { value: 'api', label: 'API Hunter', hint: 'Steal background JSON payloads directly on page load' }
        ]
    }));

    let capturePayloads = false;
    let targetSelector = '';
    let targetMission = '';

    if (mode === 'api') {
        capturePayloads = handleCancel(await confirm({ message: 'Extract the actual JSON payloads?', initialValue: true }));
    } else if (mode === 'target') {
		// 2. Bulletproof Selector Validation
		targetSelector = handleCancel(await text({
			message: 'Enter your CSS Selector:',
			placeholder: '#download-btn, .product-card',
			validate(value) {
				if (!value || typeof value !== 'string' || value.trim() === '') return 'CSS Selector is required!';
			}
		})).trim();

        targetMission = handleCancel(await select({
            message: 'What is the mission for this target?',
            options: [
                { value: 'extract', label: 'Extract (Read Text)', hint: 'Scrape the text/data inside this element' },
                { value: 'execute', label: 'Execute (Click & Trace)', hint: 'Click this element and intercept APIs, Redirects, or Popups' }
            ]
        }));
    }

    const s = spinner();
	let browser = null;
	let page = null;

    try {
		s.start('Firing up the browser engine...');
        const session = await initBrowser();
        browser = session.browser;
        page = session.page;
        s.stop('Browser engine initialized.');

        let extractedData = [];
        let finalPath = '';

		// --- API HUNTER MODE ---
        if (mode === 'api') {
            s.start('Listening to network traffic and mapping endpoints...');
            extractedData = await huntApis(page, targetUrl, capturePayloads);
            s.stop('Network analysis complete.');

            if (extractedData.length === 0) {
                console.log(chalk.yellow('\n⚠ No JSON APIs intercepted.'));
                return; 
            }
            console.log(`  ${chalk.green('✔')} Intercepted ${chalk.bold(extractedData.length)} data endpoints.`);
            
		}
		// --- AUTO-DETECT MODE ---
		else if (mode === 'auto') {
            s.start('Navigating and scanning DOM for patterns...');
            const pattern = await detectPatterns(page, targetUrl);
            s.stop('DOM Analysis Complete.');

            let finalSelector = '';
            if (pattern.type === 'table') {
                console.log(`  ${chalk.green('✔')} Found ${chalk.bold(pattern.count)} <table> element(s).`);
                finalSelector = 'table';
            } else if (pattern.type === 'div_soup') {
                console.log(`  ${chalk.yellow('⚠')} Div Soup detected! Hooking into selector: ${pattern.selector}`);
                finalSelector = pattern.selector;
            } else {
                console.log(chalk.red('\n✖ No repeating patterns detected. Try Target mode.'));
                return;
            }

            const proceed = handleCancel(await confirm({ message: 'Extract this data structure?' }));
            if (!proceed) return;
            
            s.start('Ripping data from DOM...');
            extractedData = await extractData(page, finalSelector);
            s.stop('Data ripped successfully.');

		}
		// --- TARGET MODE ---
		else if (mode === 'target') {
            if (targetMission === 'extract') {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                s.start('Test-firing selector...');
                extractedData = await extractData(page, targetSelector);
                s.stop('Test complete.');
                
				if (extractedData.length === 0) {
					console.log(chalk.red('\n✖ Zero elements found.'));
					return;
				}
                console.log(`  ${chalk.green('✔')} Locked onto ${chalk.bold(extractedData.length)} items.`);
            } 
            else if (targetMission === 'execute') {
                s.start(`Setting traps and clicking ${targetSelector}...`);
                const trapResult = await strikeTarget(page, targetUrl, targetSelector);
                s.stop('Action trace complete.');

                console.log(chalk.blue('\n--- Intercept Report ---'));
                if (trapResult.type === 'api') {
                    console.log(`  ${chalk.green('✔ API Triggered!')}`);
                    console.log(`  ${chalk.gray('↳ URL:')} ${trapResult.url}`);
					extractedData = [trapResult]; 
                } else if (trapResult.type === 'redirect') {
                    console.log(`  ${chalk.yellow('⚠ Redirection Detected!')}`);
                    console.log(`  ${chalk.gray('↳ Destination:')} ${trapResult.url}`);
                    extractedData = [{ note: 'Redirect intercepted', targetUrl: trapResult.url }];
                } else if (trapResult.type === 'popup') {
                    console.log(`  ${chalk.cyan('↗ Popup / New Tab Blocked!')}`);
                    console.log(`  ${chalk.gray('↳ Target URL:')} ${trapResult.url}`);
                    extractedData = [{ note: 'Popup intercepted', targetUrl: trapResult.url }];
                } else {
                    console.log(`  ${chalk.red('✖ Dead End.')} ${trapResult.message}`);
                    return;
                }
            }
        }

		// 3. Bulletproof Save Location Validation
		const saveLocation = handleCancel(await text({
			message: 'Where should I drop the payload?',
			initialValue: `./output.${outputFormat}`,
			validate(value) {
				if (!value || typeof value !== 'string' || value.trim() === '') return 'Save location is required!';
			}
		})).trim();

        s.start('Formatting and saving file...');
        finalPath = await saveFile(extractedData, outputFormat, saveLocation);
        s.stop(`Payload secured: ${chalk.underline(finalPath)}`);

    } catch (error) {
		// Safely stop the spinner if a critical engine failure occurs
		s.stop('Error occurred during execution.');
        console.log(chalk.red(`\n✖ Task Failed: ${error.message}`));
    } finally {
		// Ensure browser always closes even if Playwright crashes
        if (browser) await browser.close();
    }
}

async function run() {
    showBanner();
    intro(chalk.bgBlue.white.bold(' Welcome to AntiPattern CLI '));
    await checkAndInstallBrowser();

    let keepRunning = true;
    while (keepRunning) {
        await runExtractionSession();
		keepRunning = handleCancel(await confirm({
			message: chalk.blue('Do you want to run another extraction?'),
			initialValue: false
		}));
        if (keepRunning) console.log(chalk.blue('\n────────────────────────────────────────────────────────\n'));
    }
    outro(chalk.green.bold('Mission Accomplished. Happy Scraping!'));
}

run();
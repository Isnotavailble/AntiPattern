import { intro, outro, text, select, confirm, spinner, isCancel, cancel } from '@clack/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import fs from 'fs';
import { spawn } from 'child_process';
import { chromium } from 'playwright';
import { initBrowser, detectPatterns, extractData, huntApis, strikeTarget } from './scraper.js';
import { saveFile } from './exporter.js';

function handleCancel(value) {
    if (isCancel(value)) { cancel('Operation cancelled. See you next time!'); process.exit(0); }
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

async function runExtractionSession() {
    const targetUrl = handleCancel(await text({
        message: 'Enter the website URL to scrape:',
        placeholder: 'https://example.com',
        validate(value) {
            if (value.length === 0) return 'URL is required!';
            if (!value.startsWith('http')) return 'Must start with http:// or https://';
        }
    }));

    const outputFormat = handleCancel(await select({
        message: 'Select output format:',
        options: [
            { value: 'json', label: 'JSON File', hint: 'Best for nested API data and Code' },
            { value: 'csv', label: 'CSV File', hint: 'Best for flat Tables/Excel' }
        ]
    }));

    // --- The Merged Menu ---
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
        targetSelector = handleCancel(await text({ message: 'Enter your CSS Selector:', placeholder: '#download-btn, .product-card' }));
        targetMission = handleCancel(await select({
            message: 'What is the mission for this target?',
            options: [
                { value: 'extract', label: 'Extract (Read Text)', hint: 'Scrape the text/data inside this element' },
                { value: 'execute', label: 'Execute (Click & Trace)', hint: 'Click this element and intercept APIs, Redirects, or Popups' }
            ]
        }));
    }

    const s = spinner();
    let browser, page;

    try {
        s.start('Firing up the stealth browser engine...');
        const session = await initBrowser();
        browser = session.browser;
        page = session.page;
        s.stop('Browser engine initialized.');

        let extractedData = [];
        let finalPath = '';

        if (mode === 'api') {
            s.start('Listening to network traffic and mapping endpoints...');
            extractedData = await huntApis(page, targetUrl, capturePayloads);
            s.stop('Network analysis complete.');

            if (extractedData.length === 0) {
                console.log(chalk.yellow('\n⚠ No JSON APIs intercepted.'));
                return; 
            }
            console.log(`  ${chalk.green('✔')} Intercepted ${chalk.bold(extractedData.length)} data endpoints.`);
            
        } else if (mode === 'auto') {
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

        } else if (mode === 'target') {
            if (targetMission === 'extract') {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                s.start('Test-firing selector...');
                extractedData = await extractData(page, targetSelector);
                s.stop('Test complete.');
                
                if (extractedData.length === 0) { console.log(chalk.red('\n✖ Zero elements found.')); return; }
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
                    extractedData = [trapResult]; // Package it to be saved
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

        const saveLocation = handleCancel(await text({ message: 'Where should I drop the payload?', initialValue: `./output.${outputFormat}` }));
        s.start('Formatting and saving file...');
        finalPath = await saveFile(extractedData, outputFormat, saveLocation);
        s.stop(`Payload secured: ${chalk.underline(finalPath)}`);

    } catch (error) {
        if (s) s.stop('Error occurred.');
        console.log(chalk.red(`\n✖ Task Failed: ${error.message}`));
    } finally {
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
        keepRunning = handleCancel(await confirm({ message: chalk.blue('Do you want to run another extraction?'), initialValue: false }));
        if (keepRunning) console.log(chalk.blue('\n────────────────────────────────────────────────────────\n'));
    }
    outro(chalk.green.bold('Mission Accomplished. Happy Scraping!'));
}

run();
const puppeteer = require('puppeteer');
const fs = require('fs');

async function search(page, url, retryCount, category, location) {
    console.log(`Processing ${category.name} - ${location.name}`);
    await executeWithRetry(() => page.goto(url, { waitUntil: 'load' }), retryCount);
    // wait for search form to load
    await page.waitForSelector('.form-item.item--search');

    await page.$eval('#s_search', (el, value) => el.value = value, category.name);
    await page.$eval('#s_listing_cat', (el, value) => el.value = value, category.term_id);
    await page.$eval('#s_listing_location', (el, value) => el.value = value, location.name);
    await page.$eval('#s-location-term-id', (el, value) => el.value = value, location.term_id);
    await Promise.all([
        page.evaluate(() => document.querySelector('#listgo-searchform').submit()),
        page.waitForNavigation(),
        page.waitForSelector('div.form-item.item--radius')
    ]);

    while (await page.$('a.listgo-loadmore') !== null) {
        const previousItemCount = await page.evaluate(() => Array.from(document.querySelectorAll('div.wiloke-listgo-listing-item')).length);
        await page.evaluate(() => document.querySelector('a.listgo-loadmore').click());
        await page.waitForFunction((previousItemCount) => {
            return document.querySelectorAll('div.wiloke-listgo-listing-item').length > previousItemCount;
        }, {}, previousItemCount);
    }

    const results = await page.evaluate(() => Array.from(document.querySelectorAll('div.wiloke-listgo-listing-item')).map(item => {
        const dataInfo = JSON.parse(item.getAttribute('data-info'));
        const listingReference = item.querySelector('.listing__content > p').innerText.match(/#.*/)[0];
        return {
            link: dataInfo.link,
            name: dataInfo.title,
            listingReference,
            locations: dataInfo.listing_location.map(l => ({ name: l.name, link: l.link })),
            categories: dataInfo.listing_cat.map(l => ({ name: l.name, link: l.link })),
            ...dataInfo.listing_settings
        };
    }));

    return results;
}

async function executeWithRetry(functionToExecute, retryCount = 3) {
    try {
        return await functionToExecute();
    } catch (ex) {
        if (retryCount > 0) {
            return await executeWithRetry(functionToExecute, --retryCount);
        } else {
            return null;
        }
    }
}

async function scrape(url, retryCount, headless, outputPath, proxyServer) {
    const launchOptions = {
        headless
    };

    if (proxyServer) {
        launchOptions.args = [`--proxy-server=${proxyServer}`];
    }

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await executeWithRetry(() => page.goto(url, { waitUntil: 'load' }), retryCount);
    // wait for search form to load
    await page.waitForSelector('.form-item.item--search');
    const categories = await page.evaluate(() => JSON.parse(document.querySelector('#wiloke-original-search-suggestion').value));
    console.log(`${categories.length} categories found`);
    const locations = await page.evaluate(() => JSON.parse(document.querySelector('#s-listing-location-suggestion').value));
    console.log(`${locations.length} locations found`);
    const resultMap = {};
    for (category of categories) {
        for (location of locations) {
            // only process top level locations since those contain all results
            if (location.parent === 0) {
                try {
                    const items = await search(page, url, retryCount, category, location);
                    for (item of items) {
                        if (!resultMap[item.link]) {
                            resultMap[item.link] = item;
                        }
                    }
                } catch (ex) {
                    console.log(`some unexpected error occurred while processing ${category.name}`);
                }
            }
        }
    }

    await browser.close();
    const results = Object.values(resultMap);
    if(outputPath) {
        fs.writeFileSync(outputPath, JSON.stringify(results));
    }

    return results;
}

module.exports.scrape = scrape;
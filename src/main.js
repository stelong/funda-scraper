require('dotenv').config();
const { writeFileSync, readFileSync } = require('fs');
const puppeteer = require('puppeteer');
const jsdom = require('jsdom');
const nodeFetch = require('node-fetch');
const { getZipCode, getNeighbourhoodData, convertResidentsToPercentage } = require('./utils/utils');

const WIDTH = 1920;
const HEIGHT = 1080;

const data = readFileSync('db.json', { encoding: 'utf8', flag: 'r' });
const pastResults = new Set(JSON.parse(data) || []);
console.log('pastResults:', pastResults);
const newResults = new Set();
const houses = [];
const { CHAT_ID, BOT_API } = process.env;

// Feature flags via environment variables:
// - SAVE_HTML=1 or DEBUG=1 : save debug HTML and screenshot for each page
// - SEND_TELEGRAM=0 or false: run in dry-run mode (do not send Telegram messages)
const SAVE_HTML = process.env.SAVE_HTML === '1' || process.env.DEBUG === '1' || process.env.SAVE_HTML === 'true';
const SEND_TELEGRAM = !(process.env.SEND_TELEGRAM === '0' || process.env.SEND_TELEGRAM === 'false');

const urls = [
    'https://www.funda.nl/zoeken/huur?selected_area=[%22amsterdam%22]&price=%221800-2300%22&object_type=[%22apartment%22]&publication_date=%221%22&availability=[%22available%22]&floor_area=%2255-100%22&renting_condition=[%22partially_furnished%22,%22furnished%22]',
];

const runTask = async () => {
    console.log('SEND_TELEGRAM flag:', process.env.SEND_TELEGRAM);
    if (SEND_TELEGRAM && CHAT_ID && BOT_API) {
        console.log('Telegram sending ENABLED (CHAT_ID and BOT_API present)');
    } else if (SEND_TELEGRAM) {
        console.log('SEND_TELEGRAM is true but CHAT_ID or BOT_API is missing - Telegram will be skipped');
    } else {
        console.log('Telegram sending DISABLED by SEND_TELEGRAM flag');
    }
    for (const url of urls) {
        await runPuppeteer(url);
    }

    console.log('newResults:', newResults);

    if (newResults.size > 0) {
        writeFileSync('db.json', JSON.stringify(Array.from([
            ...newResults,
            ...pastResults,
        ])));

        const date = (new Date()).toISOString().split('T')[0];
        if (SEND_TELEGRAM && CHAT_ID && BOT_API) {
            console.log('sending messages to Telegram');
            houses.forEach(({
                path,
                room,
            }) => {
                const text = `New house on ${date}: [click here](${path}) (${room}).`;

                nodeFetch(`https://api.telegram.org/bot${BOT_API}/sendMessage`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        text,
                        chat_id: CHAT_ID,
                        parse_mode: 'markdown',
                    }),
                }).catch(err => console.warn('Telegram send failed:', err && err.message));
            });
        } else {
            console.log('Skipping Telegram sends (dry-run). Set SEND_TELEGRAM=1 and provide CHAT_ID and BOT_API to enable.');
        }
    }
};

const runPuppeteer = async (url) => {
    console.log('opening headless browser');

    // Add no-sandbox flags for CI (GitHub Actions) and extra stability flags.
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // avoid /dev/shm issues
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            `--window-size=${WIDTH},${HEIGHT}`
        ],
        defaultViewport: {
            width: WIDTH,
            height: HEIGHT,
        },
    });

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.157 Safari/537.36');

        console.log('going to funda');
        // Wait for network to be idle to allow client-side rendering
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Try to accept cookie banners (e.g. button with text 'Alles accepteren' / 'Accepteren')
        try {
            const clicked = await page.evaluate(() => {
                const textRe = /accep|accept|akkoord|agree|cookie/i;
                const candidates = Array.from(document.querySelectorAll('button, a, input'));
                for (const el of candidates) {
                    try {
                        const text = (el.innerText || el.value || '').trim();
                        if (text && textRe.test(text)) {
                            el.click();
                            return true;
                        }
                    } catch (e) {
                        // ignore
                    }
                }
                return false;
            });
            if (clicked) {
                console.log('Attempted to accept cookie banner');
                await page.waitForTimeout(1200);
            }
        } catch (err) {
            // swallow errors from cookie handling
        }

        // Wait for the listing container to appear (use class chain equivalent)
        try {
            await page.waitForSelector('.border-light-2.mb-4.border-b.pb-4', { timeout: 20000 });
        } catch (err) {
            // selector didn't appear quickly; proceed to grab content anyway
            console.warn('Listing selector not found within timeout; continuing to capture page content');
        }

        const htmlString = await page.content();
        const dom = new jsdom.JSDOM(htmlString);

        if (SAVE_HTML) {
            try {
                const now = new Date().toISOString().replace(/[:.]/g, '-');
                const htmlPath = `debug-funda-${now}.html`;
                const pngPath = `debug-funda-${now}.png`;
                require('fs').writeFileSync(htmlPath, htmlString, 'utf8');
                await page.screenshot({ path: pngPath, fullPage: true });
                console.log('Saved debug files:', htmlPath, pngPath);
            } catch (err) {
                console.warn('Failed to save debug files:', err && err.message);
            }
        }


        console.log('parsing funda.nl data');
        // Try multiple selectors (fallbacks) to be resilient against markup changes.
        const selectorsToTry = [
            '.border-light-2.mb-4.border-b.pb-4',
            '[data-testid="listingDetailsAddress"]',
            'a[href^="/detail/"]',
        ];

        let matchedSelector = null;
        let nodes = [];
        for (const sel of selectorsToTry) {
            try {
                const found = Array.from(dom.window.document.querySelectorAll(sel));
                if (found && found.length > 0) {
                    matchedSelector = sel;
                    nodes = found;
                    break;
                }
            } catch (e) {
                // invalid selector or other error -> skip
            }
        }

        console.log('listing selector used:', matchedSelector);
        console.log('listing nodes found:', nodes.length);

        for (const element of nodes) {
            // If the selector returned an anchor (address link), use it directly.
            let anchor = null;
            if (element.tagName && element.tagName.toLowerCase() === 'a') {
                anchor = element;
            } else {
                // otherwise, look for the first link inside the container
                anchor = element.querySelector && element.querySelector('a');
            }

            const urlPath = anchor && anchor.href;
            if (!urlPath) {  // workaround for fake results
                continue
            }
            const headerSubtitle = element?.querySelector('.text-dark-1');
            const subtitleText = headerSubtitle?.innerHTML?.trim();

            let path = urlPath;
            if (!path.includes('https://www.funda.nl')) {
                path = `https://www.funda.nl${urlPath}`;
            }

            path = path.replace('?navigateSource=resultlist', '');
            if (path && !pastResults.has(path) && !newResults.has(path)) {
                let extraDetails = {};
                // const zipCode = getZipCode(subtitleText || '');
                const zipCode = null;

                if (zipCode) {
                    const neighbourhoodData = await getNeighbourhoodData(zipCode);

                    if (neighbourhoodData) {
                        const residentsCount = neighbourhoodData?.['AantalInwoners_5']?.value || 0;
                        const westernImmigrantsCount = neighbourhoodData?.['WestersTotaal_17']?.value || 0;
                        const nonWesternImmigrantsCount = neighbourhoodData?.['NietWestersTotaal_18']?.value || 0;
                        const totalImmigrantsCount = westernImmigrantsCount + nonWesternImmigrantsCount;
                        const income = neighbourhoodData?.['GemiddeldInkomenPerInwoner_66']?.value * 1000;

                        extraDetails = {
                            ...extraDetails,
                            income,
                            residentsAge0to14: neighbourhoodData['k_0Tot15Jaar_8'].value,
                            residentsAge15to24: neighbourhoodData['k_15Tot25Jaar_9'].value,
                            residentsAge25to44: neighbourhoodData['k_25Tot45Jaar_10'].value,
                            residentsAge45to64: neighbourhoodData['k_45Tot65Jaar_11'].value,
                            residentsAge65AndOlder: neighbourhoodData['k_65JaarOfOuder_12'].value,
                            householdsWithChildren: neighbourhoodData['HuishoudensMetKinderen_31'].value,
                            totalImmigrantsCount,
                            shareOfMorocco: convertResidentsToPercentage(residentsCount, neighbourhoodData['Marokko_19'].value),
                            shareOfAntillesOrAruba: convertResidentsToPercentage(residentsCount, neighbourhoodData['NederlandseAntillenEnAruba_20'].value),
                            shareOfSuriname: convertResidentsToPercentage(residentsCount, neighbourhoodData['Suriname_21'].value),
                            shareOfTurkey: convertResidentsToPercentage(residentsCount, neighbourhoodData['Turkije_22'].value),
                            shareOfNonImmigrants: convertResidentsToPercentage(residentsCount, residentsCount - totalImmigrantsCount),
                            neighbourhoodName: neighbourhoodData.neighbourhoodName.value,
                            municipalityName: neighbourhoodData.municipalityName.value,
                            residentsCount,
                        };
                    }
                }

                if (url.includes("%22700-900%22")) {
                    extraDetails = {
                        ...extraDetails,
                        room: "single",
                    };
                } else {
                    extraDetails = {
                        ...extraDetails,
                        room: "double",
                    };
                }

                newResults.add(path);
                houses.push({
                    ...extraDetails,
                    path,
                });
            }
        }

    } finally {
        console.log('closing browser');
        if (page) await page.close().catch(() => { });
        await browser.close().catch(() => { });
    }
};

if (CHAT_ID && BOT_API) {
    runTask();
} else if (!SEND_TELEGRAM) {
    console.log('SEND_TELEGRAM disabled; running in dry-run mode without Telegram sends');
    runTask();
} else {
    console.log('Missing Telegram API keys! Set CHAT_ID and BOT_API, or set SEND_TELEGRAM=0 to run without sending.');
}

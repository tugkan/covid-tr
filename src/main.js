const Apify = require('apify');
const rp = require('request-fixed-tunnel-agent');
const base64 = require('base-64');


const { log,requestAsBrowser } = Apify.utils;
const sourceUrl = 'https://covid19.saglik.gov.tr/';
const LATEST = 'LATEST';

Apify.main(async () => {
    const requestQueue = await Apify.openRequestQueue();
    const kvStore = await Apify.openKeyValueStore('COVID-19-TURKEY');
    const dataset = await Apify.openDataset('COVID-19-TURKEY-HISTORY');


    // Get input schema
    const {apiKey} = await Apify.getInput() || {};

    // API Key validation
    if(!apiKey){
        log.error('Google Vision API Key is required');
        process.exit(1);
    }

    await requestQueue.addRequest({ url: sourceUrl });
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        useApifyProxy: true,
        handlePageTimeoutSecs: 60 * 2,
        useSessionPool:true,
        handlePageFunction: async (context) => {
            const {$,request,session} = context;
            log.info('Page loaded.');
            const now = new Date();

            const dataUrl = 'https://covid19.saglik.gov.tr/' + $('.card-body img[src]').map((i,el) => $(el).attr('src')).get(0);

            log.info('Found image');

            // Download image
            const response = await rp({
                url:dataUrl,
                encoding:null,
                resolveWithFullResponse:true,
                proxyUrl: Apify.getApifyProxyUrl({
                    groups: ['SHADER']
                })
            });

            log.info('Image downloaded');

            // Parse to base64
            const imageData = Buffer.from(response.body).toString('base64');

            // Send to Google vision
            const visionResponse = await requestAsBrowser({
                url: `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
                method: 'POST',
                payload: JSON.stringify({
                    "requests": [
                        {
                            "image": {
                                "content": imageData,
                            },
                            "features": [{
                                "type": "TEXT_DETECTION"
                            }]
                        }
                    ]
                }),
                apifyProxyGroups:['SHADER'],
                timeoutSecs: 120,
                abortFunction: (res) => {
                    // Status code check
                    if (!res || res.statusCode !== 200) {
                        session.markBad();
                        return true;
                    }
                    session.markGood();
                    return false;
                },
            }).catch((err) => {
                session.markBad();
                throw new Error(err);
            });

            log.info('Image processed');

            const textResponse = JSON.parse(visionResponse.body).responses[0].fullTextAnnotation.text

            const textArray = textResponse.split('\n').filter(text => text.match(/^\d+(\.\d+)*$/g))

            const infected = parseInt(textArray[3].replace(/\D/g,''));
            const deceased = parseInt(textArray[4].replace(/\D/g,''));

            const returningData = {
                infected,
                deceased,
                sourceUrl,
                lastUpdatedAtApify: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString(),
                readMe: 'https://apify.com/tugkan/covid-tr',
            };


            // Compare and save to history
            const latest = await kvStore.getValue(LATEST) || {};
            delete latest.lastUpdatedAtApify;
            const actual = Object.assign({}, returningData);
            delete actual.lastUpdatedAtApify;

            await Apify.pushData({...returningData});

            if (JSON.stringify(latest) !== JSON.stringify(actual)) {
                log.info('Data did change :( storing new to dataset.');
                await dataset.pushData(returningData);
            }

            await kvStore.setValue(LATEST, returningData);
            log.info('Data stored, finished.');
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed twice.`);
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});

/**
 * Welcome to the DeepLX-Worker!
 *
 * This is a Cloudflare Worker that proxies translation requests to the DeepL API.
 * It's a JavaScript rewrite of the original Go project, designed to be deployed on the edge.
 *
 * This version uses zero third-party dependencies and a robust, manual routing system
 * to ensure maximum stability and prevent runtime exceptions.
 *
 * @author [Your Name/Alias]
 * @link https://github.com/OwO-Network/DeepLX
 */

// --- Helper Functions (A precise port from the original Go program) ---

function getICount(translateText) {
    return translateText.split('i').length - 1;
}

function getRandomNumber() {
    const rand = Math.floor(Math.random() * 99999) + 100000;
    return rand * 1000;
}

function getTimeStamp(iCount) {
    const ts = Date.now();
    if (iCount !== 0) {
        iCount = iCount + 1;
        return ts - (ts % iCount) + iCount;
    }
    return ts;
}

function handlerBodyMethod(random, body) {
    const calc = (random + 5) % 29 === 0 || (random + 3) % 13 === 0;
    if (calc) {
        return body.replace('"method":"', '"method" : "');
    }
    return body.replace('"method":"', '"method": "');
}

// --- Core Translation Logic (Replicated from Go) ---

async function deeplxTranslate(sourceLang, targetLang, translateText, dlSession = '', useCache, ctx) {
    if (!translateText) {
        return {
            code: 400,
            message: 'No text to translate.'
        };
    }

    const finalSourceLang = (!sourceLang || sourceLang === 'auto') ? 'EN' : sourceLang.toUpperCase();
    const finalTargetLang = targetLang.toUpperCase();

    const cacheKey = new Request(`https://deeplx.cache/${finalSourceLang}/${finalTargetLang}/${encodeURIComponent(translateText)}`);
    const cache = caches.default;

    if (useCache) {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
            const result = await cachedResponse.json();
            result.cached = true;
            return result;
        }
    }

    const id = getRandomNumber();
    const iCount = getICount(translateText);
    const timestamp = getTimeStamp(iCount);

    const postData = {
        jsonrpc: '2.0',
        method: 'LMT_handle_texts',
        id: id,
        params: {
            splitting: 'newlines',
            lang: {
                source_lang_user_selected: finalSourceLang,
                target_lang: finalTargetLang,
            },
            texts: [{
                text: translateText,
                requestAlternatives: 3,
            }, ],
            timestamp: timestamp,
        },
    };

    let postStr = JSON.stringify(postData);
    postStr = handlerBodyMethod(id, postStr);

    const url = 'https://www2.deepl.com/jsonrpc';
    const headers = {
        'Content-Type': 'application/json',
    };

    if (dlSession) {
        headers['Cookie'] = `dl_session=${dlSession}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: postStr,
    });

    if (response.status === 429) {
        throw new Error('Too many requests, your IP has been blocked by DeepL temporarily.');
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepL API error: ${response.status} ${errorText}`);
    }

    const resultJson = await response.json();

    if (resultJson.error) {
        throw new Error(`DeepL API returned an error: ${resultJson.error.message}`);
    }

    const texts = resultJson.result?.texts;
    if (!texts || texts.length === 0) {
        throw new Error('Translation failed, no text returned.');
    }

    const alternatives = texts[0].alternatives?.map(alt => alt.text) || [];

    const finalResult = {
        code: 200,
        id: id,
        data: texts[0].text,
        alternatives: alternatives,
        source_lang: resultJson.result.lang,
        target_lang: finalTargetLang,
        method: dlSession ? 'Pro' : 'Free',
        cached: false,
    };

    if (useCache) {
        const cacheableResponse = new Response(JSON.stringify(finalResult), {
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=3600'
            }
        });
        ctx.waitUntil(cache.put(cacheKey, cacheableResponse));
    }

    return finalResult;
}

// --- Main Handler ---

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    // Authentication Middleware Logic
    const auth = (request, env) => {
        if (env.TOKEN) {
            const tokenInQuery = url.searchParams.get('token');
            const authHeader = request.headers.get('Authorization');
            let tokenInHeader = '';

            if (authHeader) {
                const parts = authHeader.split(' ');
                if (parts.length === 2 && (parts[0] === 'Bearer' || parts[0] === 'DeepL-Auth-Key')) {
                    tokenInHeader = parts[1];
                }
            }

            if (tokenInQuery !== env.TOKEN && tokenInHeader !== env.TOKEN) {
                return new Response(JSON.stringify({ code: 401, message: 'Invalid access token' }), { status: 401 });
            }
        }
        return null; // Auth passed
    };

    // Handle API routes
    if (request.method === 'POST' && url.pathname.startsWith('/translate') || url.pathname.startsWith('/v1/translate') || url.pathname.startsWith('/v2/translate')) {
        const authResponse = auth(request, env);
        if (authResponse) return authResponse;

        let body;
        try {
            body = await request.json();
        } catch (e) {
            return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON in request body' }), { status: 400 });
        }

        const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';
        const useCache = body.cache !== undefined ? body.cache : !isPrivate;

        if (url.pathname === '/translate') {
            const result = await deeplxTranslate(body.source_lang, body.target_lang, body.text, '', useCache, ctx);
            return new Response(JSON.stringify(result), { status: result.code });
        }

        if (url.pathname === '/v1/translate') {
            const dlSession = env.DL_SESSION || '';
            if (!dlSession) {
                return new Response(JSON.stringify({ code: 401, message: "DL_SESSION is not configured in worker environment." }), { status: 401 });
            }
            const result = await deeplxTranslate(body.source_lang, body.target_lang, body.text, dlSession, useCache, ctx);
            return new Response(JSON.stringify(result), { status: result.code });
        }

        if (url.pathname === '/v2/translate') {
            const translateText = Array.isArray(body.text) ? body.text.join('\n') : body.text;
            const result = await deeplxTranslate('auto', body.target_lang, translateText, '', useCache, ctx);
            if (result.code === 200) {
                const officialResponse = {
                    translations: [{ detected_source_language: result.source_lang, text: result.data }],
                    cached: result.cached,
                };
                return new Response(JSON.stringify(officialResponse));
            }
        }
    }

    if (request.method === 'GET' && url.pathname === '/') {
        return new Response(JSON.stringify({
            code: 200,
            message: 'DeepLX-Worker: A Cloudflare Worker implementation of DeepLX.',
            repository: 'https://github.com/OwO-Network/DeepLX',
        }));
    }

    return new Response(JSON.stringify({ code: 404, message: 'Not Found' }), { status: 404 });
}


// --- Worker Entrypoint ---

export default {
    async fetch(request, env, ctx) {
        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        let response;
        try {
            response = await handleRequest(request, env, ctx);
        } catch (err) {
            console.error(err);
            response = new Response(JSON.stringify({
                code: 500,
                message: 'Worker threw an exception',
                error: err.message,
            }), { status: 500 });
        }

        // Add CORS headers to all responses
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Content-Type', 'application/json');
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    },
};

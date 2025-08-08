/**
 * Welcome to the DeepLX-Worker!
 *
 * This is a Cloudflare Worker that proxies translation requests to the DeepL API.
 * It's a JavaScript rewrite of the original Go project, designed to be deployed on the edge.
 *
 * This version is a precise, logical replica of the original Go program's core request logic,
 * ensuring the highest compatibility and success rate.
 *
 * @author [Your Name/Alias]
 * @link https://github.com/OwO-Network/DeepLX
 */

import { Router } from 'itty-router';

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
      message: 'No text to translate.',
      cached: false
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
  
  // ** CRITICAL: Replicating the exact minimal headers from the Go program **
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

// --- Router and Middleware ---

const router = Router();

const withAuth = (request, env) => {
  if (env.TOKEN) {
    const tokenInQuery = request.query.token;
    const authHeader = request.headers.get('Authorization');
    let tokenInHeader = '';

    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && (parts[0] === 'Bearer' || parts[0] === 'DeepL-Auth-Key')) {
        tokenInHeader = parts[1];
      }
    }

    if (tokenInQuery !== env.TOKEN && tokenInHeader !== env.TOKEN) {
      return new Response(
        JSON.stringify({ code: 401, message: 'Invalid access token' }),
        { status: 401 }
      );
    }
  }
};

// --- API Endpoints ---

router.options('*', () => new Response(null, { status: 204 }));

router.get('/', () => {
  return new Response(
    JSON.stringify({
      code: 200,
      message: 'DeepLX-Worker: A Cloudflare Worker implementation of DeepLX.',
      repository: 'https://github.com/OwO-Network/DeepLX',
    })
  );
});

const handleTranslateRequest = async (request, env, ctx) => {
    const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON in request body' }), { status: 400 });
    }

    const { text, source_lang, target_lang, cache } = body;
    const useCache = cache !== undefined ? cache : !isPrivate;
    const result = await deeplxTranslate(source_lang, target_lang, text, '', useCache, ctx);
    return new Response(JSON.stringify(result), { status: result.code });
};

router.post('/translate', withAuth, handleTranslateRequest);

router.post('/v1/translate', withAuth, async (request, env, ctx) => {
    const dlSession = env.DL_SESSION || '';
    if (!dlSession) {
        return new Response(JSON.stringify({ code: 401, message: "DL_SESSION is not configured in worker environment." }), { status: 401 });
    }
    
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON in request body' }), { status: 400 });
    }

    const { text, source_lang, target_lang, cache } = body;
    const useCache = cache !== undefined ? cache : false;
    const result = await deeplxTranslate(source_lang, target_lang, text, dlSession, useCache, ctx);
    return new Response(JSON.stringify(result), { status: result.code });
});

router.post('/v2/translate', withAuth, async (request, env, ctx) => {
    const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ code: 400, message: 'Invalid JSON in request body' }), { status: 400 });
    }

    const { text, target_lang, cache } = body;
    const useCache = cache !== undefined ? cache : !isPrivate;
    const translateText = Array.isArray(text) ? text.join('\n') : text;
    const result = await deeplxTranslate('auto', target_lang, translateText, '', useCache, ctx);

    if (result.code === 200) {
        const officialResponse = {
            translations: [{
                detected_source_language: result.source_lang,
                text: result.data,
            }, ],
            cached: result.cached,
        };
        return new Response(JSON.stringify(officialResponse));
    } else {
        return new Response(JSON.stringify(result), { status: result.code });
    }
});

router.all('*', () => new Response(JSON.stringify({ code: 404, message: 'Not Found' }), { status: 404 }));

// --- Worker Entrypoint ---

const corsify = (response) => {
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
};

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router.handle(request, env, ctx);
      return corsify(response);
    } catch (err) {
      console.error(err);
      const errorResponse = new Response(JSON.stringify({
        code: 500,
        message: 'Worker threw an exception',
        error: err.message,
      }), { status: 500 });
      return corsify(errorResponse);
    }
  },
};
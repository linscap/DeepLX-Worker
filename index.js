/**
 * Welcome to the DeepLX-Worker!
 *
 * This is a Cloudflare Worker that proxies translation requests to the DeepL API.
 * It's a JavaScript rewrite of the original Go project, designed to be deployed on the edge.
 *
 * Features:
 * - Caching mechanism to reduce API calls and improve response time.
 * - Public/Private mode based on the presence of an auth TOKEN.
 * - Cache control via a request parameter.
 * - Cache hit identification in the response.
 *
 * @author [Your Name/Alias]
 * @link https://github.com/OwO-Network/DeepLX
 */

// A lightweight router
import { Router } from 'itty-router';

// --- Helper Functions (ported from Go) ---

/**
 * Returns the number of 'i' characters in the text.
 * @param {string} translateText The text to translate.
 * @returns {number} The count of 'i's.
 */
function getICount(translateText) {
  return translateText.split('i').length - 1;
}

/**
 * Generates a random number for the request ID.
 * @returns {number} A random number.
 */
function getRandomNumber() {
  const rand = Math.floor(Math.random() * 99999) + 100000;
  return rand * 1000;
}

/**
 * Generates a timestamp for the request based on the 'i' count.
 * @param {number} iCount The number of 'i's in the text.
 * @returns {number} The timestamp.
 */
function getTimeStamp(iCount) {
  const ts = Date.now();
  if (iCount !== 0) {
    iCount = iCount + 1;
    return ts - (ts % iCount) + iCount;
  }
  return ts;
}

/**
 * Manipulates the request body string based on the request ID.
 * This is a crucial part of mimicking the official client.
 * @param {number} random The random request ID.
 * @param {string} body The JSON string of the request body.
 * @returns {string} The manipulated body string.
 */
function handlerBodyMethod(random, body) {
  const calc = (random + 5) % 29 === 0 || (random + 3) % 13 === 0;
  if (calc) {
    return body.replace('"method":"', '"method" : "');
  }
  return body.replace('"method":"', '"method": "');
}

// --- Core Translation Logic with Caching ---

/**
 * Performs the translation by calling the DeepL API, with caching.
 * @param {string} sourceLang The source language.
 * @param {string} targetLang The target language.
 * @param {string} translateText The text to translate.
 * @param {string} dlSession Optional DeepL Pro session cookie.
 * @param {boolean} useCache Whether to use the cache for this request.
 * @param {ExecutionContext} ctx The execution context for caching.
 * @returns {Promise<object>} The translation result.
 */
async function deeplxTranslate(sourceLang, targetLang, translateText, dlSession = '', useCache, ctx) {
  if (!translateText) {
    return {
      code: 400,
      message: 'No text to translate.',
      cached: false
    };
  }

  // Default to English if source language is not specified
  const finalSourceLang = (!sourceLang || sourceLang === 'auto') ? 'EN' : sourceLang.toUpperCase();
  const finalTargetLang = targetLang.toUpperCase();

  // Create a cache key
  const cacheKey = new Request(`https://deeplx.cache/${finalSourceLang}/${finalTargetLang}/${encodeURIComponent(translateText)}`);
  const cache = caches.default;

  if (useCache) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const result = await cachedResponse.json();
      result.cached = true; // Add cache hit identifier
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
    'Accept': '*/*',
    'x-app-os-name': 'iOS',
    'x-app-os-version': '16.3.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'DeepL-iOS/2.9.1 iOS 16.3.1 (iPad14,1)',
    'x-app-device': 'iPad14,1',
    'x-app-build': '514288',
    'x-app-version': '2.9.1',
  };

  if (dlSession) {
    headers['Cookie'] = `dl_session=${dlSession}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: postStr,
    });

    if (response.status === 429) {
      return {
        code: 429,
        message: 'Too many requests, your IP has been blocked by DeepL temporarily.',
        cached: false
      };
    }

    if (!response.ok) {
      const errorText = await response.text();
      return {
        code: response.status,
        message: `DeepL API error: ${errorText}`,
        cached: false
      };
    }

    const resultJson = await response.json();

    if (resultJson.error) {
      return {
        code: 500,
        message: `DeepL API returned an error: ${resultJson.error.message}`,
        cached: false
      };
    }

    const texts = resultJson.result?.texts;
    if (!texts || texts.length === 0) {
      return {
        code: 500,
        message: 'Translation failed, no text returned.',
        cached: false
      };
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
      cached: false, // Add cache miss identifier
    };

    // Cache the successful response
    if (useCache) {
      const cacheableResponse = new Response(JSON.stringify(finalResult), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        }
      });
      ctx.waitUntil(cache.put(cacheKey, cacheableResponse));
    }

    return finalResult;

  } catch (error) {
    return {
      code: 500,
      message: `An unexpected error occurred: ${error.message}`,
      cached: false
    };
  }
}

// --- Router and Middleware ---

const router = Router();

// Middleware for authentication
const authMiddleware = (request, env) => {
  // This middleware only runs if env.TOKEN is set.
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
      JSON.stringify({
        code: 401,
        message: 'Invalid access token'
      }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
};

// --- API Endpoints ---

router.get('/', () => {
  return new Response(
    JSON.stringify({
      code: 200,
      message: 'DeepLX-Worker: A Cloudflare Worker implementation of DeepLX.',
      repository: 'https://github.com/OwO-Network/DeepLX',
    }), {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
});

const handleTranslateRequest = async (request, env, ctx) => {
    const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';
    const body = await request.json();
    const {
      text,
      source_lang,
      target_lang,
      cache
    } = body;

    // Determine if cache should be used.
    // User's `cache` param takes precedence.
    // Otherwise, default is ON for public mode, OFF for private mode.
    const useCache = cache !== undefined ? cache : !isPrivate;

    const result = await deeplxTranslate(source_lang, target_lang, text, '', useCache, ctx);
    return new Response(JSON.stringify(result), {
      status: result.code,
      headers: {
        'Content-Type': 'application/json'
      }
    });
};

router.post('/translate', handleTranslateRequest);

router.post('/v1/translate', async (request, env, ctx) => {
    const dlSession = env.DL_SESSION || '';
    if (!dlSession) {
        return new Response(JSON.stringify({
        code: 401,
        message: "DL_SESSION is not configured in worker environment."
        }), {
        status: 401
        });
    }

    const body = await request.json();
    const {
        text,
        source_lang,
        target_lang,
        cache
    } = body;

    // For /v1, we default to no cache, but allow user override
    const useCache = cache !== undefined ? cache : false;

    const result = await deeplxTranslate(source_lang, target_lang, text, dlSession, useCache, ctx);
    return new Response(JSON.stringify(result), {
        status: result.code,
        headers: {
        'Content-Type': 'application/json'
        }
    });
});

router.post('/v2/translate', async (request, env, ctx) => {
    const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';
    const body = await request.json();
    const {
        text,
        target_lang,
        cache
    } = body;

    const useCache = cache !== undefined ? cache : !isPrivate;
    const translateText = Array.isArray(text) ? text.join('\n') : text;
    const result = await deeplxTranslate('auto', target_lang, translateText, '', useCache, ctx);

    if (result.code === 200) {
        const officialResponse = {
        translations: [{
            detected_source_language: result.source_lang,
            text: result.data,
        }, ],
        cached: result.cached, // Pass through the cache status
        };
        return new Response(JSON.stringify(officialResponse), {
        status: 200,
        headers: {
            'Content-Type': 'application/json'
        }
        });
    } else {
        return new Response(JSON.stringify(result), {
        status: result.code,
        headers: {
            'Content-Type': 'application/json'
        }
        });
    }
});


// Catch-all for 404s
router.all('*', () => new Response(JSON.stringify({
  code: 404,
  message: 'Not Found'
}), {
  status: 404
}));

// --- Worker Entrypoint ---

export default {
  async fetch(request, env, ctx) {
    const isPrivate = env.TOKEN !== undefined && env.TOKEN !== '';

    // Only apply auth middleware for private mode on relevant paths
    const url = new URL(request.url);
    if (isPrivate && url.pathname.startsWith('/translate') || url.pathname.startsWith('/v1/translate') || url.pathname.startsWith('/v2/translate')) {
        const authResult = authMiddleware(request, env);
        if (authResult) { // If auth fails, authMiddleware returns a Response
            return authResult;
        }
    }
    
    return router.handle(request, env, ctx);
  },
};
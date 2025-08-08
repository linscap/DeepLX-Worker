# DeepLX-Worker

This project is a complete rewrite of the original [DeepLX Go project](https://github.com/OwO-Network/DeepLX), refactored into a high-performance, easy-to-deploy Cloudflare Worker.

It serves as a proxy to the DeepL API, meticulously replicating the request logic of the official client to provide a free, fast, and reliable translation service. By leveraging the Cloudflare Edge network, this worker is resilient to IP bans and offers a globally distributed, low-latency experience.

## Features

- **Complete DeepLX Functionality**: Implements all core API endpoints (`/translate`, `/v1/translate`, `/v2/translate`) with compatible request and response formats.
- **IP Ban Resilience**: All requests to DeepL are made through Cloudflare's vast network, effectively rotating IP addresses and preventing IP-based blocking.
- **Intelligent Caching**: Utilizes Cloudflare's Cache API to store translation results, reducing redundant API calls, minimizing costs, and providing near-instant responses for repeated requests.
- **Flexible Cache Control**: Force-enable or disable the cache for any specific request by adding a simple parameter to your JSON payload.
- **Public & Private Modes**:
  - **Public Mode (Default)**: No authentication required. Caching is enabled by default to handle high traffic efficiently.
  - **Private Mode**: Secure your worker by setting a `TOKEN` in your environment variables. All requests will require authentication. Caching is disabled by default for private use.
- **Cache Hit Identification**: Every response includes a `cached` boolean field, making it transparent whether the result came from the cache or a live DeepL API call.
- **Easy Deployment**: Deploy globally in minutes with the `wrangler` CLI. No servers to manage, no Docker containers to build.

## Deployment

Deploying this worker is a straightforward process.

### 1. Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up).
- [Node.js](https://nodejs.org/) and `npm` installed.
- The `wrangler` CLI installed: `npm install -g wrangler`.

### 2. Setup

1.  **Clone or download this project.**
2.  **Navigate into the `worker/` directory:**
    ```bash
    cd worker
    ```
3.  **Install dependencies:**
    ```bash
    npm install
    ```
4.  **Authenticate Wrangler:**
    ```bash
    wrangler login
    ```

### 3. Configuration (Private Mode - Optional)

To run your worker in **Private Mode**, you need to set an authentication token. This is highly recommended for personal use.

1.  **Generate a secure secret token.** You can use a password generator for this.
2.  **Set the secret in your Cloudflare Worker:**
    ```bash
    # This is more secure than setting it in wrangler.toml
    wrangler secret put TOKEN
    ```
    Wrangler will then prompt you to enter the token value.

If you have a DeepL Pro account and want to use the `/v1/translate` endpoint, set your `dl_session` as well:
```bash
wrangler secret put DL_SESSION
```

### 4. Deploy

Run the deploy command:
```bash
wrangler deploy
```
Wrangler will build and deploy your worker, providing you with a public URL (e.g., `https://deeplx-worker.<your-subdomain>.workers.dev`).

## API Usage

All endpoints are available via `POST` request.

### Endpoint: `/translate`

The primary endpoint for free-tier translations.

**Request Body (JSON):**
```json
{
  "text": "Hello, world!",
  "source_lang": "EN",
  "target_lang": "JA",
  "cache": true // Optional: `true` to force cache, `false` to bypass.
}
```

**Success Response:**
```json
{
  "code": 200,
  "id": 81431000,
  "data": "こんにちは、世界！",
  "alternatives": [
    "ハローワールド",
    "ハロー・ワールド"
  ],
  "source_lang": "EN",
  "target_lang": "JA",
  "method": "Free",
  "cached": false // `true` if the response was from the cache
}
```

### Endpoint: `/v1/translate` (Pro Account)

Requires a `DL_SESSION` to be configured in the worker's environment variables.

**Request Body (JSON):**
(Same as `/translate`)

### Endpoint: `/v2/translate` (Official API Compatibility)

Mimics the format of the official DeepL API.

**Request Body (JSON):**
```json
{
  "text": ["Hello, world!"],
  "target_lang": "JA",
  "cache": true // Optional
}
```

**Success Response:**
```json
{
  "translations": [
    {
      "detected_source_language": "EN",
      "text": "こんにちは、世界！"
    }
  ],
  "cached": true // `true` if the response was from the cache
}
```

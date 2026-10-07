# SF.gov API Package

This package contains serverless functions for the SF.gov Wagtail Extension, deployed on Vercel.

## Setup

### 1. Install Dependencies

From the repository root:

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the repository root with the following variables:

```bash
WAGTAIL_API_URL=https://api.sf.gov/admin/api/v2
AIRTABLE_API_KEY=your_airtable_api_key
AIRTABLE_BASE_ID=your_airtable_base_id
# current table receiving feedback (e.g. "Karl Fillout Data")
AIRTABLE_TABLE_NAME=your_table_name
# optional: older table to also read from and merge (e.g. "Karl data")
AIRTABLE_TABLE_NAME_LEGACY=your_legacy_table_name
# optional: table IDs (tbl...) for record deep-links; default to known values
# AIRTABLE_TABLE_ID=tblpk25gxXFi7bamZ
# AIRTABLE_TABLE_ID_LEGACY=tblbhivrMRm5X8eSU
```

**Token Authentication (Required):**
```bash
# Generate a secure signing secret with:
# openssl rand -hex 32
TOKEN_SIGNING_SECRET=your_64_character_hex_string_here
```

For Upstash Redis (automatically set by Vercel when connected via Marketplace):
```bash
UPSTASH_REDIS_REST_URL=your_upstash_redis_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token
```

Optional configuration:
```bash
TOKEN_TTL_SECONDS=900  # token lifetime in seconds (default: 900 = 15 minutes)
WAGTAIL_VALIDATION_TIMEOUT=5000  # validation timeout in milliseconds (default: 5000)
```

## Development

### Start the Development Server

From the repository root:

```bash
npm run dev:api
```

This will start the Vercel dev server on `http://localhost:3001`.

**Note:** The first time you run this, Vercel CLI will prompt you to set up the project. Answer the prompts to link it to your Vercel account (or skip for local-only development).

### Type Checking

```bash
npm run type-check --workspace=@sf-gov/server
```

## API Endpoints

### POST /api/auth/token

Exchanges a Wagtail session ID for a short-lived companion API token.

**Headers:**
- `X-Wagtail-Session`: Session cookie value from api.sf.gov
- `Origin`: Extension origin (chrome-extension://... or edge-extension://...)

**Response:**
```json
{
  "token": "eyJzZn...signature",
  "expiresAt": "2025-06-15T12:30:00.000Z"
}
```

**Error Responses:**
- `401`: Invalid or missing session
- `403`: Invalid origin
- `405`: Method not allowed

### GET /api/feedback

Proxies requests to Airtable with token-based authentication.

**Headers:**
- `Authorization`: Bearer token from /api/auth/token
- `Origin`: Extension origin (chrome-extension://... or edge-extension://...)

**Query Parameters:**
- `pagePath`: SF.gov page path (e.g., `/services/housing`)

**Response:**
```json
{
  "records": [
    {
      "id": "rec123",
      "submissionId": "sub456",
      "submissionCreated": "2025-11-08T10:30:00Z",
      "referrer": "/services/housing",
      "wasHelpful": "yes",
      "issueCategory": null,
      "whatWasHelpful": "Clear information",
      "additionalDetails": "Very helpful page"
    }
  ]
}
```

**Error Responses:**
- `401`: Invalid or missing session
- `403`: Invalid origin
- `429`: Rate limit exceeded
- `500`: Server error
- `502`: Airtable API error

## Testing Locally

You can test the token exchange endpoint using curl once the dev server is running:

```bash
# First, exchange your Wagtail session for a token
curl -X POST "http://localhost:3000/api/auth/token" \
  -H "X-Wagtail-Session: your_session_cookie" \
  -H "Origin: http://localhost:5173"

# Then use the token to access the feedback endpoint
curl -X GET "http://localhost:3000/api/feedback?pagePath=/services/housing" \
  -H "Authorization: Bearer your_token_here" \
  -H "Origin: http://localhost:5173"
```

## Deployment

### Deploy to Vercel

```bash
npm run deploy --workspace=@sf-gov/server
```

Or from the Vercel dashboard, connect your GitHub repository and Vercel will automatically deploy on push.

### Environment Variables in Production

Set the following environment variables in your Vercel project settings:

**Required:**
- `TOKEN_SIGNING_SECRET` - Generate with `openssl rand -hex 32`
- `WAGTAIL_API_URL`
- `AIRTABLE_API_KEY`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_TABLE_NAME` - current table receiving feedback (e.g. "Karl Fillout Data")

**Optional:**
- `AIRTABLE_TABLE_NAME_LEGACY` - an older feedback table (e.g. "Karl data"). When set, the feedback endpoint reads from both tables and merges the results so historical feedback keeps displaying. Leave unset to read only from `AIRTABLE_TABLE_NAME`.
- `AIRTABLE_TABLE_ID` / `AIRTABLE_TABLE_ID_LEGACY` - Airtable table IDs (`tbl...`) used to deep-link each feedback record to its own source table in the side panel. These default to the known table IDs for the feedback base, so you only need to set them if the tables change.

**Automatically Set by Vercel (when Upstash Redis is connected):**
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

**Optional (with defaults):**
- `TOKEN_TTL_SECONDS` (default: 900 seconds = 15 minutes)
- `WAGTAIL_VALIDATION_TIMEOUT` (default: 5000 milliseconds)

## Architecture

- **Token Exchange** (`/api/auth/token`): Validates Wagtail sessions once and issues short-lived HS256 JWTs
- **Token Validation**: Verifies JWTs locally using the `jose` library (no external calls needed)
- **Session Validation**: Validates Wagtail admin sessions by making requests to the Wagtail API (only during token exchange)
- **Shared Auth** (`lib/auth.ts`): Centralized authentication helpers — `authenticateRequest()` handles token-or-session auth, `handleCors()` handles CORS/preflight/origin validation
- **Caching**: Uses Upstash Redis to cache feedback data (2 hour TTL)
- **Security**: Validates origin headers (extension and localhost only), tokens contain a SHA-256 session fingerprint (not the raw session ID)

## Upstash Redis Setup

The API uses Upstash Redis for caching feedback data from Airtable. To set up Upstash Redis:

### Production (Vercel)

1. Navigate to your Vercel project dashboard
2. Go to the "Storage" tab
3. Click "Create Database" or "Browse Marketplace"
4. Select "Upstash Redis" from the Marketplace integrations
5. Click "Add Integration" and follow the prompts
6. Create a database (Free tier is sufficient for this use case)
7. Connect the database to your Vercel project

Vercel automatically injects the following environment variables:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Local Development

To test with Upstash Redis locally:

```bash
# Pull environment variables from Vercel (includes Upstash credentials)
vercel env pull .env.development.local

# Start the development server with Upstash access
vercel dev
```

**Note:** Standard `npm run dev:server` will not have Upstash access locally unless you manually copy the environment variables. Use `vercel dev` for full Redis functionality during development.

## Dependencies

- `@vercel/node`: Vercel serverless function runtime
- `@upstash/redis`: Upstash Redis SDK for caching and rate limiting
- `jose`: Standards-compliant JWT signing and verification (HS256)
- `@sf-gov/shared`: Shared TypeScript types

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { AirtableRecord, AirtableResponse, FeedbackRecord, FeedbackResponse, FeedbackStats } from "@sf-gov/shared";
import { authenticateRequest, handleCors } from "../lib/auth.js";

// cache TTL for feedback data (2 hours in seconds).  all users access the same
// feedback data for a given URL.
const FEEDBACK_CACHE_TTL = 7200;

interface ProxyEnv {
	WAGTAIL_API_URL: string;
	AIRTABLE_API_KEY: string;
	AIRTABLE_BASE_ID: string;
	AIRTABLE_TABLE_NAME: string;
	AIRTABLE_TABLE_NAME_LEGACY?: string;
	AIRTABLE_TABLE_ID?: string;
	AIRTABLE_TABLE_ID_LEGACY?: string;
	TOKEN_SIGNING_SECRET: string;
	UPSTASH_REDIS_REST_URL?: string;
	UPSTASH_REDIS_REST_TOKEN?: string;
}

function validateEnv(): ProxyEnv {
	const env = {
		WAGTAIL_API_URL: process.env.WAGTAIL_API_URL,
		AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
		AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
		AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME,
		AIRTABLE_TABLE_NAME_LEGACY: process.env.AIRTABLE_TABLE_NAME_LEGACY,
		AIRTABLE_TABLE_ID: process.env.AIRTABLE_TABLE_ID,
		AIRTABLE_TABLE_ID_LEGACY: process.env.AIRTABLE_TABLE_ID_LEGACY,
		TOKEN_SIGNING_SECRET: process.env.TOKEN_SIGNING_SECRET,
		UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
		UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
	};

	const required = ["WAGTAIL_API_URL", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_NAME", "TOKEN_SIGNING_SECRET"];
	const missing = required.filter(key => !env[key as keyof ProxyEnv]);

	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
	}

	return env as ProxyEnv;
}

/**
 * Describes how a given Airtable table names its free-text feedback columns.
 * The key fields (submission_id, submission_created, referrer,
 * wasTheLastPageYouViewedHelpful) are identical across tables, so only the
 * columns that differ need mapping.  A field name set to null means the table
 * has no equivalent column.
 */
interface TableFieldMapping {
	tableName: string;
	// Airtable table ID (tbl...), used to build per-record deep-links.  Null when
	// not configured for this table.
	tableId: string | null;
	whatWasWrong: string;
	whatWasHelpful: string;
	shareMoreDetails: string;
	whatWasDifficult: string | null;
}

// Known Airtable table IDs for the feedback tables in base appo4SjothLkSxmbG.
// Used as deep-link defaults when the AIRTABLE_TABLE_ID* env vars are not set.
// These IDs are stable identifiers (not secrets).
const DEFAULT_TABLE_ID_CURRENT = "tblpk25gxXFi7bamZ"; // "Karl Fillout Data"
const DEFAULT_TABLE_ID_LEGACY = "tblbhivrMRm5X8eSU"; // "Karl data"

/**
 * Builds the list of tables to query, newest first.  The current table
 * ("Karl Fillout Data") is always queried; the legacy table ("Karl data") is
 * queried only when AIRTABLE_TABLE_NAME_LEGACY is configured.
 *
 * Table IDs (used for per-record deep-links) fall back to the known defaults
 * above when the corresponding env var is not set.
 */
function getTableMappings(env: ProxyEnv): TableFieldMapping[] {
	const mappings: TableFieldMapping[] = [
		{
			tableName: env.AIRTABLE_TABLE_NAME,
			tableId: env.AIRTABLE_TABLE_ID ?? DEFAULT_TABLE_ID_CURRENT,
			whatWasWrong: "WhatWasWrong",
			whatWasHelpful: "WhatWasHelpful",
			shareMoreDetails: "ShareMoreDetails",
			whatWasDifficult: "WhatWasDifficult",
		},
	];

	if (env.AIRTABLE_TABLE_NAME_LEGACY) {
		mappings.push({
			tableName: env.AIRTABLE_TABLE_NAME_LEGACY,
			tableId: env.AIRTABLE_TABLE_ID_LEGACY ?? DEFAULT_TABLE_ID_LEGACY,
			whatWasWrong: "whatWasWrongWithThePage1",
			whatWasHelpful: "whatWasHelpful",
			shareMoreDetails: "shareMoreDetails",
			whatWasDifficult: null,
		});
	}

	return mappings;
}

async function redisGet<T>(key: string, url: string, token: string): Promise<T | null> {
	const start = Date.now();
	try {
		const encodedKey = encodeURIComponent(key);
		const fetchUrl = `${url}/get/${encodedKey}`;
		const response = await fetch(fetchUrl, {
			headers: { Authorization: `Bearer ${token}` }
		});

		if (!response.ok) {
			console.log(`Redis GET ${key}: ${Date.now() - start}ms (not ok)`);
			return null;
		}

		const data: any = await response.json();
		console.log(`Redis GET ${key}: ${Date.now() - start}ms`);
		if (!data.result) return null;

		try {
			return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
		} catch {
			return data.result as T;
		}
	} catch (error) {
		console.error(`Redis GET failed for ${key} after ${Date.now() - start}ms:`, error);
		return null;
	}
}

async function redisSet(key: string, value: any, url: string, token: string, ttlSeconds: number): Promise<void> {
	try {
		const encodedKey = encodeURIComponent(key);
		const fetchUrl = `${url}/set/${encodedKey}?ex=${ttlSeconds}`;
		const body = JSON.stringify(value);

		const response = await fetch(fetchUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json"
			},
			body: body
		});

		if (!response.ok) {
			const text = await response.text();
			console.error(`Redis SET failed for ${key}: ${response.status} ${text}`);
		}
	} catch (error) {
		console.error(`Redis SET failed for ${key}:`, error);
	}
}

function normalizePath(path: string): string {
	const withoutQuery = path.split("?")[0];
	const withoutTrailingSlash = withoutQuery === "/" ? "/" : withoutQuery.replace(/\/+$/, "");
	return withoutTrailingSlash.toLowerCase();
}

/**
 * Fetches every matching record for a page path from a single Airtable table,
 * following pagination.  Returns the raw Airtable records unchanged.
 */
async function fetchTableRecords(
	normalizedPath: string,
	tableName: string,
	env: ProxyEnv
): Promise<AirtableRecord[]> {
	const encodedTableName = encodeURIComponent(tableName);
	const filterFormula = `LOWER({referrer})='${normalizedPath}'`;

	let allRecords: AirtableRecord[] = [];
	let offset: string | undefined;

	let requestCount = 0;
	const MAX_REQUESTS = 50;
	const startTime = Date.now();

	do {
		requestCount++;
		if (requestCount > MAX_REQUESTS) {
			console.warn(`Hit max requests limit for table "${tableName}", path: ${normalizedPath}`);
			break;
		}

		const url = new URL(
			`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodedTableName}`
		);
		url.searchParams.set("filterByFormula", filterFormula);
		url.searchParams.set("sort[0][field]", "submission_created");
		url.searchParams.set("sort[0][direction]", "desc");
		if (offset) {
			url.searchParams.set("offset", offset);
		}

		console.log(`Fetching page ${requestCount} from table "${tableName}" for ${normalizedPath}`);
		let timeoutId: NodeJS.Timeout;

		const fetchPromise = fetch(url.toString(), {
			method: "GET",
			headers: {
				"Authorization": `Bearer ${env.AIRTABLE_API_KEY}`,
			},
		});

		const timeoutPromise = new Promise<Response>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error("Request timed out")), 30000);
		});

		let response: Response;
		try {
			response = await Promise.race([fetchPromise, timeoutPromise]);
			clearTimeout(timeoutId!);
		} catch (e) {
			// @ts-ignore
			if (typeof timeoutId !== "undefined") clearTimeout(timeoutId);
			throw e;
		}

		if (!response.ok) {
			console.error(`Airtable error for table "${tableName}": ${response.status}`);
			throw new Error(`Airtable API error: ${response.status}`);
		}

		const data = await response.json() as AirtableResponse;
		allRecords = allRecords.concat(data.records);
		offset = data.offset;

	} while (offset);

	const duration = Date.now() - startTime;
	console.log(`Fetched ${allRecords.length} records from table "${tableName}" in ${duration}ms (${requestCount} requests)`);

	return allRecords;
}

/**
 * Normalizes a raw Airtable record into a FeedbackRecord using the given
 * table's field mapping.  This lets rows from tables with different column
 * names be projected into one consistent shape.
 */
function normalizeRecord(record: AirtableRecord, mapping: TableFieldMapping): FeedbackRecord {
	const fields = record.fields as Record<string, string | undefined>;
	return {
		id: record.id,
		submissionId: fields.submission_id ?? "",
		submissionCreated: fields.submission_created ?? "",
		referrer: fields.referrer ?? "",
		wasHelpful: (fields.wasTheLastPageYouViewedHelpful as "yes" | "no" | undefined) || null,
		issueCategory: fields[mapping.whatWasWrong] || null,
		whatWasHelpful: fields[mapping.whatWasHelpful] || null,
		additionalDetails: fields[mapping.shareMoreDetails] || null,
		whatWasDifficult: mapping.whatWasDifficult ? fields[mapping.whatWasDifficult] || null : null,
		airtableTableId: mapping.tableId,
	};
}

/**
 * Fetches feedback for a page path across every configured table (current +
 * legacy), merges the results, recomputes combined stats, and returns records
 * that carry free-text feedback, sorted newest first.
 */
async function fetchAllAirtableFeedback(
	pagePath: string,
	env: ProxyEnv
): Promise<FeedbackResponse> {
	const normalizedPath = normalizePath(pagePath);
	const mappings = getTableMappings(env);

	// query all tables in parallel; each returns raw records paired with its mapping
	const perTableResults = await Promise.all(
		mappings.map(async mapping => ({
			mapping,
			records: await fetchTableRecords(normalizedPath, mapping.tableName, env),
		}))
	);

	// normalize every row into the common shape using its own table's mapping
	const normalizedRecords: FeedbackRecord[] = perTableResults.flatMap(
		({ mapping, records }) => records.map(record => normalizeRecord(record, mapping))
	);

	// calculate stats over the combined set
	let helpful = 0;
	let notHelpful = 0;

	normalizedRecords.forEach(record => {
		if (record.wasHelpful === "yes") {
			helpful++;
		} else if (record.wasHelpful === "no") {
			notHelpful++;
		}
	});

	const total = normalizedRecords.length;
	const helpfulPercent = total > 0 ? Math.round((helpful / total) * 100) : 0;
	const notHelpfulPercent = total > 0 ? Math.round((notHelpful / total) * 100) : 0;

	const stats: FeedbackStats = {
		total,
		helpful,
		notHelpful,
		helpfulPercent,
		notHelpfulPercent
	};

	// keep only records with text feedback, then sort newest first across all tables
	const recentRecords = normalizedRecords
		.filter(record => record.additionalDetails)
		.sort((a, b) => {
			const aTime = a.submissionCreated ? Date.parse(a.submissionCreated) : 0;
			const bTime = b.submissionCreated ? Date.parse(b.submissionCreated) : 0;
			return bTime - aTime;
		});

	return { stats, records: recentRecords };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	const handlerStart = Date.now();

	// handle CORS, preflight, method, and origin validation
	if (handleCors(req, res, "GET")) return;

	try {
		const env = validateEnv();

		// authenticate via token or legacy session
		const auth = await authenticateRequest(req, env.TOKEN_SIGNING_SECRET, env.WAGTAIL_API_URL);
		if (!auth.ok) {
			return res.status(auth.status).json({ error: auth.error });
		}
		const { sessionFingerprint } = auth;

		const pagePath = req.query.pagePath as string | undefined;
		if (!pagePath) {
			return res.status(400).json({ error: "Missing pagePath" });
		}

		const normalizedPath = normalizePath(pagePath);
		const cacheKey = `feedback:${normalizedPath}`;

		// check feedback cache
		let cachedFeedback: FeedbackResponse | null = null;
		if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
			cachedFeedback = await redisGet<FeedbackResponse>(cacheKey, env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
		}

		// return cached feedback if available
		if (cachedFeedback) {
			console.log(`Feedback cache hit for ${normalizedPath} (session: ${sessionFingerprint}) - total handler time: ${Date.now() - handlerStart}ms`);
			return res.status(200).json(cachedFeedback);
		}

		const feedbackData = await fetchAllAirtableFeedback(pagePath, env);

		// cache the result
		if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
			await redisSet(cacheKey, feedbackData, env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN, FEEDBACK_CACHE_TTL);
		}

		return res.status(200).json(feedbackData);

	} catch (error) {
		console.error("Feedback handler error:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
}

/**
 * Airtable API type definitions for SF.gov feedback integration
 */

/**
 * Represents a user feedback submission from Airtable
 */
export interface FeedbackRecord {
	id: string;
	submissionId: string;
	submissionCreated: string; // ISO 8601 date string
	referrer: string;
	wasHelpful: "yes" | "no" | null;
	issueCategory: string | null;
	whatWasHelpful: string | null;
	additionalDetails: string | null;
	whatWasDifficult: string | null;
	// Airtable table ID this record came from, used to build a deep-link to the
	// correct table.  Null when the source table's ID is not configured.
	airtableTableId: string | null;
}

/**
 * Calculated feedback statistics for a page
 */
export interface FeedbackStats {
	total: number;
	helpful: number;
	notHelpful: number;
	helpfulPercent: number;
	notHelpfulPercent: number;
}

/**
 * Combined feedback response with stats and recent records
 */
export interface FeedbackResponse {
	stats: FeedbackStats;
	records: FeedbackRecord[];
}

/**
 * Raw Airtable API response structure
 */
export interface AirtableResponse {
	records: AirtableRecord[];
	offset?: string;
}

/**
 * Individual record from Airtable API
 *
 * Feedback is spread across two tables that share the key fields
 * (submission_id, submission_created, referrer, wasTheLastPageYouViewedHelpful)
 * but differ in how the free-text columns are named:
 * - "Karl data" (legacy): whatWasWrongWithThePage1, whatWasHelpful, shareMoreDetails
 * - "Karl Fillout Data" (current): WhatWasWrong, WhatWasHelpful, ShareMoreDetails, WhatWasDifficult
 * All variant columns are optional so a single type can represent rows from either table.
 */
export interface AirtableRecord {
	id: string;
	fields: {
		submission_id: string;
		submission_created: string;
		referrer: string;
		wasTheLastPageYouViewedHelpful?: "yes" | "no";
		// legacy "Karl data" column names
		whatWasWrongWithThePage1?: string;
		whatWasHelpful?: string;
		shareMoreDetails?: string;
		// current "Karl Fillout Data" column names
		WhatWasWrong?: string;
		WhatWasHelpful?: string;
		ShareMoreDetails?: string;
		WhatWasDifficult?: string;
	};
	createdTime: string;
}

/**
 * Airtable API error structure
 */
export interface AirtableApiError {
	type: "auth" | "network" | "timeout" | "rate_limit" | "server_error";
	message: string;
	statusCode?: number;
	retryable: boolean;
}

/**
 * Airtable configuration stored in chrome.storage
 */
export interface AirtableConfig {
	accessToken: string | null;
}

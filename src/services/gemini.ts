import axios from "axios";
import dotenv from "dotenv";
import { ReviewResult } from "../types";
import { CallSite } from "./ast";
import {
  buildReviewPrompt,
  parseAndValidateReviewResponse,
  attemptJsonRecovery,
  enrichFindingsWithTreeSitter,
} from "./hermes";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT || "300000", 10); // Default 5 minutes
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || "3", 10);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls the Google Gemini API (`generateContent`) and returns the raw text payload.
 * Simple exponential backoff is used to survive transient free-tier throttling.
 */
async function callGeminiWithRetry(prompt: string): Promise<string | null> {
  if (!GEMINI_API_KEY) {
    console.error("[CLIFF] GEMINI_API_KEY is not set.");
    return null;
  }

  let lastRaw: string | null = null;

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          systemInstruction: {
            parts: [
              {
                text: "You are an expert, evidence-based AI Code Reviewer. Respond ONLY with valid JSON that matches the schema you were given. Never wrap your answer in code fences.",
              },
            ],
          },
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        },
        {
          timeout: GEMINI_TIMEOUT,
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
          },
        },
      );

      const candidates = response.data?.candidates;
      const parts = candidates?.[0]?.content?.parts;
      const raw = Array.isArray(parts)
        ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";

      if (raw && raw.trim().length > 0) {
        return raw;
      }

      lastRaw = null;
      console.warn(`[CLIFF] Gemini attempt ${attempt} returned empty content. Retrying...`);
    } catch (error: any) {
      lastRaw = null;
      const status = error?.response?.status;
      const msg = error?.response?.data?.error?.message || error?.message || String(error);
      console.warn(`[CLIFF] Gemini attempt ${attempt} failed (${status ?? "no status"}): ${msg}`);
    }

    if (attempt < GEMINI_MAX_RETRIES) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }

  return null;
}

/**
 * Runs a full CLIFF evidence-based review using Google's Gemini API.
 * Suitable for serverless execution (GitHub Actions / Cloud Functions).
 */
export async function runGeminiAnalysis(
  diffText: string,
  prTitle: string,
  dominoSites: CallSite[] = [],
  fileContentMap?: Record<string, string>,
): Promise<ReviewResult> {
  const prompt = await buildReviewPrompt(diffText, prTitle, dominoSites, fileContentMap);

  console.log(`[CLIFF] Sending request to Gemini (${GEMINI_MODEL}) with timeout ${GEMINI_TIMEOUT}ms...`);
  console.log(`[CLIFF] API Key present: ${!!GEMINI_API_KEY}`);

  const rawResponse = await callGeminiWithRetry(prompt);

  if (!rawResponse) {
    return {
      summary: "Review output unavailable. Gemini API failed to produce a response after retries. Please try again later.",
      risk_level: "low",
      breaking_changes: [],
      findings: [],
    };
  }

  console.log(`[CLIFF] Raw response length: ${rawResponse.length}`);
  console.log(`[CLIFF] Raw response preview: ${rawResponse.slice(0, 200)}...`);

  let parsedResult = parseAndValidateReviewResponse(rawResponse);

  if (parsedResult.summary.includes("fallback due to malformed")) {
    const recovered = attemptJsonRecovery(rawResponse);
    if (recovered) {
      parsedResult = parseAndValidateReviewResponse(recovered);
    }
  }

  return enrichFindingsWithTreeSitter(parsedResult, fileContentMap, diffText);
}
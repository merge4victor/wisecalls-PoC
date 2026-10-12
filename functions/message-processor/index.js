"use strict";

const BLOCK_PATTERNS = [
  { name: "CVV", regex: /\b(?:cvv|cvc|security\s*code)\s*(?:is\s*)?[:=-]?\s*\d{3,4}\b/i },
  { name: "PIN", regex: /\b(?:pin)\s*(?:is\s*)?[:=-]?\s*\d{4,8}\b/i },
  { name: "PASSWORD", regex: /\b(?:password|passcode)\s*(?:is\s*)?[:=-]?\s*\S+/i },
  { name: "OTP", regex: /\b(?:otp|one[- ]time\s*(?:password|code)|verification\s*code)\s*(?:is\s*)?[:=-]?\s*\d{4,8}\b/i }
];

function sanitizeMessage(text = "") {
  const matches = BLOCK_PATTERNS.filter((pattern) => pattern.regex.test(text));
  if (matches.length) {
    return {
      blocked: true,
      categories: matches.map((match) => match.name),
      text: "For your security, do not enter a PIN, password, CVV, or verification code in chat. Use the secure sign-in window."
    };
  }
  return { blocked: false, categories: [], text };
}

function extractMessage(event = {}) {
  return event.chatContent?.content
    || event.message?.content
    || event.Content
    || event.content
    || event.Details?.Parameters?.message
    || "";
}

async function handler(event) {
  const result = sanitizeMessage(extractMessage(event));
  return {
    status: "PROCESSED",
    result: {
      processedChatContent: {
        content: result.text,
        contentType: event.chatContent?.contentType || "text/plain"
      }
    }
  };
}

module.exports = { handler, extractMessage, sanitizeMessage };

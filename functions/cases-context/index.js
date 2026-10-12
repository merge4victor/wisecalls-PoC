"use strict";

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}), ...(event.arguments || {}) };
}

function fieldValue(fields, id) {
  return fields?.find((field) => field.id === id)?.value?.stringValue;
}

function commentsFromRelatedItems(items = [], limit = 3) {
  return items
    .filter((item) => item.type === "Comment" && item.content?.comment?.body)
    .sort((a, b) => String(b.associationTime).localeCompare(String(a.associationTime)))
    .slice(0, Math.min(Number(limit), 5))
    .map((item) => ({
      createdAt: item.associationTime,
      body: String(item.content.comment.body).slice(0, 1500)
    }));
}

async function handler(event) {
  const input = parametersFromEvent(event);
  if (input.customerVerified !== true && input.customerVerified !== "true") {
    return { ok: false, code: "AUTHENTICATION_REQUIRED" };
  }
  if (!input.profileArn?.startsWith("arn:aws:profile:")) {
    return { ok: false, code: "INVALID_PROFILE_ARN" };
  }
  if (!process.env.CASES_DOMAIN_ID) {
    return { ok: false, code: "CASES_DOMAIN_NOT_CONFIGURED" };
  }

  const {
    ConnectCasesClient,
    SearchCasesCommand,
    SearchRelatedItemsCommand
  } = await import("@aws-sdk/client-connectcases");
  const client = new ConnectCasesClient({});
  const found = await client.send(new SearchCasesCommand({
    domainId: process.env.CASES_DOMAIN_ID,
    maxResults: 5,
    filter: {
      field: {
        equalTo: {
          id: "customer_id",
          value: { stringValue: input.profileArn }
        }
      }
    },
    fields: [
      { id: "title" },
      { id: "status" },
      { id: "last_updated_datetime" }
    ],
    sorts: [{ fieldId: "last_updated_datetime", sortOrder: "Desc" }]
  }));

  const cases = await Promise.all((found.cases || []).map(async (item) => {
    const related = await client.send(new SearchRelatedItemsCommand({
      domainId: process.env.CASES_DOMAIN_ID,
      caseId: item.caseId,
      maxResults: 25,
      filters: [{ comment: {} }]
    }));
    return {
      caseId: item.caseId,
      title: fieldValue(item.fields, "title"),
      status: fieldValue(item.fields, "status"),
      lastUpdatedAt: fieldValue(item.fields, "last_updated_datetime"),
      latestComments: commentsFromRelatedItems(related.relatedItems, input.commentLimit || 3)
    };
  }));
  return {
    ok: true,
    cases,
    instruction: "Summarize only returned facts. Do not infer decisions, liability, coverage, or approval."
  };
}

module.exports = { handler, commentsFromRelatedItems, fieldValue, parametersFromEvent };

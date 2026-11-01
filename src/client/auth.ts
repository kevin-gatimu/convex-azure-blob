import { DEFAULT_AUTHORITY_HOST, type AzureBlobConfig } from "./config.js";
import { sasTime, SAS_VERSION } from "./sas.js";
import type { UserDelegationKey } from "./sas.js";

const KEY_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_START_SKEW_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getAccessToken(config: AzureBlobConfig) {
  if (!config.tenantId || !config.clientId || !config.clientSecret) {
    throw new Error(
      "Microsoft Entra client credentials are required when AZURE_BLOB_KEY is not set",
    );
  }
  const authorityHost = (
    config.authorityHost || DEFAULT_AUTHORITY_HOST
  ).replace(/\/+$/, "");
  const tokenUrl = `${authorityHost}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://storage.azure.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Microsoft Entra token request failed with ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    body.access_token.length === 0
  ) {
    throw new Error(
      "Microsoft Entra token response did not contain an access token",
    );
  }
  return body.access_token;
}

function requiredTag(xml: string, name: string) {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  if (!match?.[1]) {
    throw new Error(
      `Azure Blob user delegation key response is missing ${name}`,
    );
  }
  return match[1];
}

function optionalTag(xml: string, name: string) {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

export async function requestUserDelegationKey(
  config: AzureBlobConfig,
  now: number,
): Promise<UserDelegationKey> {
  const accessToken = await getAccessToken(config);
  const start = new Date(now - KEY_START_SKEW_MS);
  const expiry = new Date(start.getTime() + KEY_VALIDITY_MS);
  const base = config.internalEndpoint ?? config.endpoint;
  const response = await fetch(
    `${base}/?restype=service&comp=userdelegationkey`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/xml",
        "x-ms-version": SAS_VERSION,
      },
      body: `<KeyInfo><Start>${sasTime(start.getTime())}</Start><Expiry>${sasTime(expiry.getTime())}</Expiry></KeyInfo>`,
    },
  );
  const xml = await response.text();
  if (!response.ok) {
    const errorCode = response.headers.get("x-ms-error-code");
    const message = optionalTag(xml, "Message");
    const details = [errorCode, message].filter(Boolean).join(": ");
    throw new Error(
      `Azure Blob user delegation key request failed with ${response.status}${details ? ` (${details})` : ""}`,
    );
  }
  const key: UserDelegationKey = {
    signedObjectId: requiredTag(xml, "SignedOid"),
    signedTenantId: requiredTag(xml, "SignedTid"),
    signedStart: requiredTag(xml, "SignedStart"),
    signedExpiry: requiredTag(xml, "SignedExpiry"),
    signedService: requiredTag(xml, "SignedService"),
    signedVersion: requiredTag(xml, "SignedVersion"),
    keyValue: requiredTag(xml, "Value"),
  };
  if (
    key.signedService !== "b" ||
    !Number.isFinite(Date.parse(key.signedStart)) ||
    !Number.isFinite(Date.parse(key.signedExpiry))
  ) {
    throw new Error("Azure Blob returned an invalid user delegation key");
  }
  return key;
}

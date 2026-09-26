import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";
export function databaseOptions(
  connectionString: string,
  caFile?: string,
): PoolConfig {
  const url = new URL(connectionString);
  if (!["postgresql:", "postgres:"].includes(url.protocol))
    throw new Error("Invalid PostgreSQL URL scheme.");
  if (
    (url.hostname.endsWith(".rds.amazonaws.com") ||
      url.hostname.endsWith(".rds.amazonaws.com.cn")) &&
    !caFile
  )
    throw new Error("RDS connections require an explicit trusted CA file.");
  if (!caFile) return { connectionString };
  // pg-connection-string URI SSL options can replace the explicit ssl object. Reject ambiguity/downgrades.
  for (const name of url.searchParams.keys())
    if (
      name.toLowerCase().startsWith("ssl") ||
      name.toLowerCase() === "uselibpqcompat"
    )
      throw new Error(
        "Configure PostgreSQL TLS only through DATABASE_SSL_CA_FILE, not URL SSL parameters.",
      );
  const ca = readFileSync(caFile, "utf8");
  const certificates = ca.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!certificates?.length)
    throw new Error("Database CA file contains no certificates.");
  for (const certificate of certificates) new X509Certificate(certificate);
  return { connectionString, ssl: { ca, rejectUnauthorized: true } };
}

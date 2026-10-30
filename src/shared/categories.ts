// The only values the Enrichment Service accepts (Logline.category in openapi.json).
export const CATEGORIES = [
  "contentinjection",
  "drivebycompromise",
  "exploitpublicfacingapplication",
  "externalremoteservices",
  "hardwareadditions",
  "phishing",
  "replicationthroughremovablemedia",
  "supplychaincompromise",
  "trustedrelationship",
  "validaccounts",
] as const;

export type Category = (typeof CATEGORIES)[number];

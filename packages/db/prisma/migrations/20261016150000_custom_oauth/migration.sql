-- Custom OAuth 2 providers, kept next to the single sign-on ones.

ALTER TABLE "SsoProvider" ADD COLUMN "oauthConfig" TEXT;

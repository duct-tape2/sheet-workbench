import { betterAuth } from "better-auth";
import type { SqlClient } from "./db.ts";

export const defaultAuthBaseURL = "http://localhost:3001";
export const defaultTrustedOrigins = [
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export interface AuthConfiguration {
  baseURL?: string;
  secret?: string;
  trustedOrigins?: string[];
  /** HTTPS endpoint operated by a deployer to deliver verification email. */
  verificationWebhookURL?: string;
  /** HTTPS endpoint operated by a deployer to deliver password-reset email. */
  passwordResetWebhookURL?: string;
  /**
   * Invoked by Better Auth immediately before its own hard account delete.
   * The host uses this to make application-owned foreign keys erasable.
   */
  beforeUserDelete?: (user: SessionUser) => Promise<void> | void;
}

/** True only when a deployer has supplied a real reset-delivery callback. */
export function passwordResetEnabled(config: AuthConfiguration = {}): boolean {
  return Boolean(
    config.passwordResetWebhookURL ?? process.env.PASSWORD_RESET_WEBHOOK_URL,
  );
}

/** Explicit exact origins only; never wildcard CORS or reflected request origins. */
export function trustedOriginsFor(config: AuthConfiguration = {}): string[] {
  const configured =
    config.trustedOrigins ??
    (process.env.TRUSTED_ORIGINS?.trim()
      ? process.env.TRUSTED_ORIGINS.split(",").map((value) => value.trim())
      : undefined);
  const canonical = config.baseURL ?? process.env.BETTER_AUTH_URL;
  const candidates =
    configured ??
    (canonical ? [new URL(canonical).origin] : defaultTrustedOrigins);
  return [
    ...new Set(
      candidates.map((value) => {
        const parsed = new URL(value);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.origin !== value ||
          value.includes("*")
        )
          throw new Error(
            "TRUSTED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.",
          );
        if (
          process.env.NODE_ENV === "production" &&
          parsed.protocol !== "https:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        )
          throw new Error("Public production trusted origins must use HTTPS.");
        return parsed.origin;
      }),
    ),
  ];
}

/**
 * Better Auth owns password hashing, session issuance, expiry, and CSRF-aware
 * auth endpoints. The rest of the service only ever consumes its session.
 *
 * `SqlClient` is deliberately narrower than pg.Pool. Better Auth accepts a
 * Postgres pool at runtime; the cast avoids tying every route to pg's concrete
 * type and keeps PGlite usable for database integration tests.
 */
export function createBetterAuth(
  db: SqlClient,
  config: AuthConfiguration = {},
) {
  const secret = config.secret ?? process.env.BETTER_AUTH_SECRET;
  // Better Auth signs long-lived session material with this secret. Treat a
  // short value as missing configuration rather than starting weak auth.
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return undefined;

  const verificationWebhookURL =
    config.verificationWebhookURL ?? process.env.EMAIL_VERIFICATION_WEBHOOK_URL;
  const emailVerification = verificationWebhookURL
    ? {
        sendOnSignUp: true,
        sendVerificationEmail: async ({
          user,
          url,
        }: {
          user: { id: string; email: string; name: string };
          url: string;
        }) => {
          const response = await fetch(verificationWebhookURL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "sheet-workbench.verify-email",
              user: { id: user.id, email: user.email, name: user.name },
              verificationUrl: url,
            }),
          });
          if (!response.ok)
            throw new Error(
              "Email verification delivery endpoint rejected the request.",
            );
        },
      }
    : undefined;
  const passwordResetWebhookURL =
    config.passwordResetWebhookURL ?? process.env.PASSWORD_RESET_WEBHOOK_URL;
  const sendResetPassword = passwordResetWebhookURL
    ? async ({
        user,
        url,
      }: {
        user: { id: string; email: string; name: string };
        url: string;
      }) => {
        const response = await fetch(passwordResetWebhookURL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "sheet-workbench.reset-password",
            user: { id: user.id, email: user.email, name: user.name },
            resetUrl: url,
          }),
        });
        if (!response.ok)
          throw new Error(
            "Password reset delivery endpoint rejected the request.",
          );
      }
    : undefined;

  return betterAuth({
    database: db as never,
    baseURL:
      config.baseURL ?? process.env.BETTER_AUTH_URL ?? defaultAuthBaseURL,
    secret,
    trustedOrigins: trustedOriginsFor(config),
    emailAndPassword: {
      enabled: true,
      // Auth remains usable for self-hosters without an outbound mail
      // integration. Invitations still require a verified email and fail
      // explicitly until a deployer configures delivery.
      requireEmailVerification: Boolean(emailVerification),
      // Better Auth refuses reset requests without this documented callback;
      // the UI exposes that configuration state instead of faking delivery.
      ...(sendResetPassword ? { sendResetPassword } : {}),
      revokeSessionsOnPasswordReset: true,
    },
    ...(emailVerification ? { emailVerification } : {}),
    ...(config.beforeUserDelete
      ? {
          user: {
            deleteUser: {
              enabled: true,
              beforeDelete: async (user: {
                id: string;
                email: string;
                name: string;
                emailVerified: boolean;
              }) =>
                config.beforeUserDelete!({
                  id: user.id,
                  email: user.email,
                  name: user.name,
                  emailVerified: user.emailVerified,
                }),
            },
          },
        }
      : {}),
    advanced: {
      // The schema below intentionally uses the documented Better Auth camel
      // case column names. Do not allow automatic schema changes in requests.
      database: { casing: "camel", validateSchema: true },
    },
  });
}

export type BetterAuthInstance = NonNullable<
  ReturnType<typeof createBetterAuth>
>;

export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export async function sessionFromAuth(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.user) return null;
  return {
    id: result.user.id,
    email: result.user.email,
    emailVerified: result.user.emailVerified,
    name: result.user.name,
  };
}

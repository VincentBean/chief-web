export { type CookieOptions, parseCookieHeader, serializeCookie } from './cookies.js';
export { isSecureRequest, LOGIN_PATH, requireApiAuth, requirePageAuth } from './middleware.js';
export { generatePassword, hashPassword, secretsMatch, verifyPasswordHash } from './password.js';
export {
  createLoginRateLimiter,
  describeRetryAfter,
  type LoginRateLimiter,
  type LoginRateLimitOptions,
  type RateLimitVerdict,
} from './ratelimit.js';
export { deriveSigningKey, issueSessionToken, verifySessionToken } from './session.js';
export {
  type AuthService,
  createAuthService,
  type HeaderCarrier,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './service.js';

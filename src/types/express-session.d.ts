import "express-session";

declare module "express-session" {
  interface SessionData {
    userId: string;
    username: string;
    role: string;
    authProvider: string;   // "local" or "azure"
    samlRelayState: string;   // CSRF token for SAML flow
    samlNameID: string;       // SAML NameID for logout
    samlSessionIndex: string; // SAML SessionIndex for logout
    lastActivity: number;     // Timestamp for inactivity tracking
    mfaVerified: boolean;     // True when the session has cleared TOTP (local accounts only)
    csrfToken: string;        // Synchronizer token for state-changing requests
  }
}

declare global {
  namespace Express {
    interface Request {
      // Set by apiTokenAuth middleware when the request presented a valid
      // bearer token. Mutually exclusive with req.session.userId in
      // practice — token callers don't get a session.
      apiToken?: { id: string; name: string; scopes: string[] };
    }
  }
}

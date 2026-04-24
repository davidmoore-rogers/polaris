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
  }
}

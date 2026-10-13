import type { Request, Response, NextFunction } from "express";
import { createClerkClient, verifyToken } from "@clerk/backend";

// Augment Express's Request type so downstream handlers can read the verified,
// server-derived Clerk user id instead of trusting whatever the client body claims.
declare global {
  namespace Express {
    interface Request {
      verifiedClerkUserId?: string;
    }
  }
}

// Verifies the Clerk session token (sent as `Authorization: Bearer <token>`) and
// attaches the verified user id to the request. Does NOT reject the request if
// the token is missing/invalid - it just leaves verifiedClerkUserId unset, so
// existing anonymous/local-dev flows (no login) keep working. Route handlers
// that need to trust user identity should check `req.verifiedClerkUserId` and
// ignore any `clerkId` sent in the request body, which is NOT verified.
export async function attachVerifiedClerkUser(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (token && process.env.CLERK_SECRET_KEY) {
    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      req.verifiedClerkUserId = payload.sub;
    } catch (err) {
      console.warn("[clerkAuth] Token verification failed:", (err as Error).message);
    }
  }

  next();
}

export function getVerifiedPrimaryEmail(user: {
  primaryEmailAddress: { emailAddress: string; verification: { status: string } | null } | null;
}): string | null {
  const email = user.primaryEmailAddress;
  if (!email || email.verification?.status !== "verified") return null;
  return email.emailAddress.trim().toLowerCase();
}

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
export async function getVerifiedClerkIdentity(clerkId: string): Promise<{ clerkId: string; email: string; name: string }> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is required to resolve the authenticated account.");
  clerkClient ??= createClerkClient({ secretKey });
  const user = await clerkClient.users.getUser(clerkId);
  const email = getVerifiedPrimaryEmail(user);
  if (!email) throw new Error("A verified primary email is required for this account.");
  const name = user.fullName?.trim() || user.username?.trim() || email;
  return { clerkId: user.id, email, name };
}

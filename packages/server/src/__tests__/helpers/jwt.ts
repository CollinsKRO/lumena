import { signRoleToken, type Role } from "../../middleware/rbac.js";

export interface TestTokenPayload {
  /** Actor identifier recorded in the token's `sub` claim. */
  sub: string;
  /** Roles granted to the actor. The first entry becomes the token's role. */
  roles: Role[];
}

/**
 * Mint a bearer token for the given actor and roles.
 *
 * The server verifies these tokens with the `JWT_SECRET` environment variable;
 * when it is not set, signature verification is skipped and any well-formed
 * token is accepted.
 */
export function signTestToken(payload: TestTokenPayload): string {
  const role = payload.roles[0] ?? "auditor";
  return signRoleToken(
    { sub: payload.sub, role },
    process.env.JWT_SECRET ?? "lumen-test-secret",
  );
}

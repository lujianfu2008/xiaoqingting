import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { verifyCredentials, addUser } from "./users.js";

export interface TokenPayload {
  uid: string;
}

export { verifyCredentials, addUser };

export function signToken(userId: string): string {
  return jwt.sign({ uid: userId } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: "7d",
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === "object" && payload !== null && "uid" in payload) {
      return { uid: String((payload as { uid: unknown }).uid) };
    }
    return null;
  } catch {
    return null;
  }
}

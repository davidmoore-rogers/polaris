/**
 * tests/unit/privateNetworkOnly.test.ts
 *
 * The Dash wallboard's source-IP gate: RFC1918/loopback pass through,
 * everything else gets a 403 AppError via next(err).
 */

import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { privateNetworkOnly } from "../../src/api/middleware/privateNetworkOnly.js";
import { AppError } from "../../src/utils/errors.js";

function run(ip: string | undefined): { err: unknown } {
  const req = { ip } as unknown as Request;
  const res = {} as Response;
  let captured: unknown = "not-called";
  const next: NextFunction = (err?: unknown) => {
    captured = err;
  };
  privateNetworkOnly(req, res, next);
  return { err: captured };
}

describe("privateNetworkOnly", () => {
  it("passes RFC1918 and loopback sources through", () => {
    expect(run("10.1.2.3").err).toBeUndefined();
    expect(run("192.168.0.50").err).toBeUndefined();
    expect(run("172.20.0.9").err).toBeUndefined();
    expect(run("127.0.0.1").err).toBeUndefined();
    expect(run("::1").err).toBeUndefined();
    expect(run("::ffff:10.0.0.7").err).toBeUndefined();
  });

  it("403s public and undefined sources", () => {
    for (const ip of ["8.8.8.8", "203.0.113.5", "::ffff:203.0.113.5", "2001:db8::1", "", undefined]) {
      const { err } = run(ip as string | undefined);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).httpStatus).toBe(403);
    }
  });

  it("never calls next() bare with a spoofy non-IP value", () => {
    const { err } = run("10.0.0.1; DROP TABLE");
    expect(err).toBeInstanceOf(AppError);
  });
});

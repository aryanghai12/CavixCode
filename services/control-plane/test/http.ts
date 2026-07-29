// Reading a JSON response, in a way `tsc` can check the rest of the file around.
//
// WHY THIS EXISTS, since a helper this small usually does not deserve a file.
//
// `services/control-plane/test` sat outside the tsconfig `include` list for most
// of this project's life, and that is how `requireOrgMember` shipped: called
// twice, defined nowhere, and `GET /api/orgs/:org/analytics` answered
// `500 {"error":"requireOrgMember is not defined"}` from the day it landed. The
// documented gate (`npx tsc --noEmit`) had simply never looked at the service.
//
// The one thing standing in the way of including it was `Response.json()`, which
// returns `unknown`, so every `assert.equal((await res.json()).role, "admin")`
// was an error. There were about ninety of them.
//
// The obvious fix is to hand-write a response interface per endpoint. It is the
// wrong one, and worth saying why: nothing would tie those interfaces to the
// server's actual output. They would be a second, unchecked description of the
// wire format that drifts from the first one silently, which is a worse failure
// than the untyped access it replaced, because it LOOKS verified.
//
// So the body stays deliberately indexed, and the value of including the
// directory is everything else: imports that no longer resolve, a Store method
// that changed shape, a helper called with the wrong arguments. That is exactly
// the class of bug that shipped a 500 to production, and it is now checked.

/** A decoded JSON response body. Indexed, not modelled: see the note above. */
export type Body = Record<string, any>;

/**
 * Await a response and decode its body.
 *
 * Takes a `Response` or a promise of one, so a test can write
 * `await readJson(fetch(url))` without a second set of brackets.
 */
export async function readJson(res: Response | Promise<Response>): Promise<Body> {
  return (await (await res).json()) as Body;
}

/** The same, for an endpoint that answers with a JSON array. */
export async function readList(res: Response | Promise<Response>): Promise<Body[]> {
  return (await (await res).json()) as Body[];
}

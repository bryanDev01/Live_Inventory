import { timingSafeEqual } from "node:crypto";

const originSecret = process.env.ORIGIN_SECRET;
if (!originSecret) throw new Error("ORIGIN_SECRET is required");

const expectedSecret = Buffer.from(originSecret);

function hasOriginSecret(request: Request): boolean {
	const suppliedSecret = request.headers.get("x-secret");
	if (!suppliedSecret) return false;

	const suppliedBytes = Buffer.from(suppliedSecret);
	return suppliedBytes.byteLength === expectedSecret.byteLength && timingSafeEqual(suppliedBytes, expectedSecret);
}

const handler = {
	async fetch(request: Request): Promise<Response> {
		if (!hasOriginSecret(request)) return new Response("Unauthorized", { status: 401 });
		return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
	},
};

export default handler;

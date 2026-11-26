import { timingSafeEqual } from "node:crypto";
import { attachDatabasePool } from "@neon/functions";
import { createRealtime, rawSql } from "@neon/realtime/server";
import { Pool } from "pg";

const originSecret = process.env.ORIGIN_SECRET;
if (!originSecret) throw new Error("ORIGIN_SECRET is required");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
const pool = new Pool({
	connectionString: databaseUrl,
	max: 1,
	connectionTimeoutMillis: 5_000,
});
attachDatabasePool(pool);

const expectedSecret = Buffer.from(originSecret);

function hasOriginSecret(request: Request): boolean {
	const suppliedSecret = request.headers.get("x-secret");
	if (!suppliedSecret) return false;

	const suppliedBytes = Buffer.from(suppliedSecret);
	return suppliedBytes.byteLength === expectedSecret.byteLength && timingSafeEqual(suppliedBytes, expectedSecret);
}

async function checkPostgres(): Promise<{ ok: boolean }> {
	const { rows } = await pool.query("SELECT 1 AS connected");
	return { ok: rows[0]?.connected === 1 };
}

async function checkAuth(): Promise<{ ok: boolean }> {
	const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
	if (!jwksUrl) return { ok: false };

	const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) return { ok: false };

	const jwks = (await response.json()) as { keys?: unknown[] };
	return { ok: Array.isArray(jwks.keys) };
}

async function checkAiGateway(): Promise<{ ok: boolean; enabledModels: number }> {
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
	const token = process.env.NEON_AI_GATEWAY_TOKEN;
	if (!baseUrl || !token) return { ok: false, enabledModels: 0 };

	const response = await fetch(new URL("/v1/models", baseUrl), {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok) return { ok: false, enabledModels: 0 };

	const catalog = (await response.json()) as {
		data?: Array<{ enabled?: boolean }>;
	};
	if (!Array.isArray(catalog.data)) return { ok: false, enabledModels: 0 };

	return {
		ok: true,
		enabledModels: catalog.data.filter((model) => model.enabled === true).length,
	};
}

async function checkRealtime(): Promise<{ ok: boolean }> {
	const url = process.env.REALTIME_URL;
	const secret = process.env.REALTIME_SECRET;
	if (!url || !secret) return { ok: false };

	const realtime = createRealtime({ url, secret, db: databaseName });
	let subscription: Awaited<ReturnType<typeof realtime.subscribe>> | undefined;

	try {
		subscription = await realtime.subscribe(rawSql<{ connected: number }>("SELECT 1 AS connected"));
		const row = await new Promise<{ connected: number }>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Realtime probe timed out")), 10_000);
			subscription?.onChange((snapshot) => {
				if (snapshot.status === "error") {
					clearTimeout(timeout);
					reject(new Error("Realtime probe failed"));
					return;
				}

				const connected = snapshot.data?.find((result) => Number(result.connected) === 1);
				if (connected) {
					clearTimeout(timeout);
					resolve(connected);
				}
			});
			subscription?.onStateChange((state) => {
				if (state.status === "error") {
					clearTimeout(timeout);
					reject(new Error("Realtime probe failed"));
				}
			});
		});

		return { ok: Number(row.connected) === 1 };
	} finally {
		subscription?.unsubscribe();
		await realtime.close();
	}
}

async function runCheck<T extends { ok: boolean }>(check: () => Promise<T>): Promise<T> {
	try {
		return await check();
	} catch {
		return { ok: false } as T;
	}
}

const handler = {
	async fetch(request: Request): Promise<Response> {
		if (!hasOriginSecret(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const url = new URL(request.url);
		if (url.pathname !== "/health") return new Response("Not Found", { status: 404 });
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
		}

		const [postgres, auth, aiGateway] = await Promise.all([
			runCheck(checkPostgres),
			runCheck(checkAuth),
			runCheck(checkAiGateway),
		]);
		const realtime = await runCheck(checkRealtime);
		const services = { postgres, auth, aiGateway, realtime };
		const ok = Object.values(services).every((service) => service.ok);

		return Response.json(
			{ ok, services },
			{ status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
		);
	},
};

export default handler;

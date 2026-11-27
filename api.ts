import { attachDatabasePool } from "@neon/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Pool } from "pg";
import { cupEquivalent, formatRounded, parseDecimal, profitPercent } from "./src/lib/money";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
	connectionString: databaseUrl,
	max: 1,
	connectionTimeoutMillis: 10_000,
});
attachDatabasePool(pool);

const jwksUrl = process.env.NEON_AUTH_JWKS_URL;
const authBaseUrl = process.env.NEON_AUTH_BASE_URL;
const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;
const issuer = authBaseUrl ? new URL(authBaseUrl).origin : null;

const MAX_BODY_BYTES = 16 * 1024;

// The selectable currency set is an owner decision (AGENTS.md B.11 item 9), so it comes from
// configuration instead of being decided here. Empty configuration rejects every currency explicitly.
const allowedCurrencies = (process.env.ALLOWED_CURRENCIES ?? "")
	.split(",")
	.map((code) => code.trim().toUpperCase())
	.filter(Boolean);

// The reference rate is quoted in one currency. This is the rate's domain, not a product default.
const REFERENCE_CURRENCY = "USD";

const allowedOrigins = (process.env.APP_ORIGIN ?? "")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

function corsHeaders(request: Request): Record<string, string> | null {
	const origin = request.headers.get("origin");
	if (allowedOrigins.length === 0) {
		// Not configured yet: allow only calls without a browser Origin header.
		return origin ? null : {};
	}
	if (!origin || !allowedOrigins.includes(origin)) return null;
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-headers": "authorization, content-type",
		"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"vary": "origin",
	};
}

type Failure = { status: number; body: unknown };

// Thrown for client mistakes. Anything else is treated as an internal error.
class ValidationError extends Error {}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});
}

async function readLimitedText(request: Request, limit: number): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";

	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new ValidationError("Body too large");
		}
		chunks.push(value);
	}

	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	const text = await readLimitedText(request, MAX_BODY_BYTES);
	if (!text) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ValidationError("Body must be valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ValidationError("Body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new ValidationError(`${key} is required`);
	}
	return value.trim();
}

// Passwords are used exactly as typed: trimming them would change the credential.
function requirePassword(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string" || value === "") {
		throw new ValidationError(`${key} is required`);
	}
	return value;
}

function requireCurrency(body: Record<string, unknown>, key: string): string {
	const value = requireString(body, key).toUpperCase();
	if (!/^[A-Z]{3}$/.test(value)) throw new ValidationError(`${key} must be a 3-letter currency code`);
	if (!allowedCurrencies.includes(value)) {
		throw new ValidationError(`${key} is not an allowed currency`);
	}
	return value;
}

function requiredAmount(body: Record<string, unknown>, key: string): string {
	const value = requireString(body, key);
	parseDecimal(value);
	return value;
}

type Identity = { sub: string; role: string };

async function authenticate(request: Request): Promise<Identity | Failure> {
	if (!jwks || !issuer) return { status: 500, body: { error: "Auth is not configured" } };

	const header = request.headers.get("authorization");
	if (!header?.toLowerCase().startsWith("bearer ")) {
		return { status: 401, body: { error: "Missing bearer token" } };
	}

	let payload: Record<string, unknown>;
	try {
		({ payload } = await jwtVerify(header.slice(7).trim(), jwks, {
			algorithms: ["EdDSA"],
			issuer,
			audience: issuer,
		}) as { payload: Record<string, unknown> });
	} catch {
		return { status: 401, body: { error: "Invalid token" } };
	}

	if (typeof payload.sub !== "string") return { status: 401, body: { error: "Invalid subject" } };

	const email = typeof payload.email === "string" ? payload.email : null;
	if (!email) return { status: 403, body: { error: "Not allowed" } };

	// A database failure here is a service error, not a bad token.
	try {
		const { rows } = await pool.query<{ role: string }>(
			`select role from app_user where lower(email) = lower($1) limit 1`,
			[email],
		);
		const row = rows[0];
		if (!row) return { status: 403, body: { error: "Not allowed" } };
		return { sub: payload.sub, role: row.role };
	} catch {
		return { status: 503, body: { error: "Service unavailable" } };
	}
}

function isFailure(value: Identity | Failure): value is Failure {
	return typeof value !== "object" || value === null || "status" in value;
}

type RateRow = {
	currency: string;
	cup_per_unit: string;
	source: string;
	observed_at: Date;
	fetched_at: Date;
};

type Rate = { cupPerUnit: string; source: string; observedAt: string; fetchedAt: string };

function toRate(row: RateRow | undefined): Rate | null {
	if (!row) return null;
	return {
		// Two decimals everywhere, even though the column keeps more precision for history.
		cupPerUnit: formatRounded(parseDecimal(String(row.cup_per_unit)), 2),
		source: row.source,
		observedAt: new Date(row.observed_at).toISOString(),
		fetchedAt: new Date(row.fetched_at).toISOString(),
	};
}

// One query for every currency in play, so listing products does not scale queries with rows.
async function latestRates(currencies: string[]): Promise<Map<string, Rate>> {
	const rates = new Map<string, Rate>();
	if (currencies.length === 0) return rates;

	const { rows } = await pool.query<RateRow>(
		`select distinct on (currency) currency, cup_per_unit, source, observed_at, fetched_at
		 from exchange_rate
		 where currency = any($1::text[])
		 order by currency, observed_at desc, fetched_at desc`,
		[currencies],
	);

	for (const row of rows) {
		const rate = toRate(row);
		if (rate) rates.set(row.currency, rate);
	}
	return rates;
}

type ProductRow = {
	id: string;
	name: string;
	purchase_amount: string;
	purchase_currency: string;
	sale_amount: string;
	sale_currency: string;
};

async function productsPayload(): Promise<unknown[]> {
	const { rows } = await pool.query<ProductRow>(
		`select id, name, purchase_amount, purchase_currency, sale_amount, sale_currency
		 from product order by lower(name)`,
	);

	const rates = await latestRates([...new Set(rows.map((row) => row.purchase_currency))]);

	return rows.map((row) => {
		const purchase = String(row.purchase_amount);
		const sale = String(row.sale_amount);
		const rate = rates.get(row.purchase_currency) ?? null;

		return {
			id: row.id,
			name: row.name,
			purchaseAmount: purchase,
			purchaseCurrency: row.purchase_currency,
			saleAmount: sale,
			saleCurrency: row.sale_currency,
			cupEquivalent: rate ? cupEquivalent(purchase, rate.cupPerUnit) : null,
			// Explicit state instead of a silent null: the UI can explain what is missing.
			cupUnavailable: rate ? null : `no-rate-for-${row.purchase_currency}`,
			rate,
			profitMargin: profitPercent(purchase, sale, "margin"),
			profitMarkup: profitPercent(purchase, sale, "markup"),
		};
	});
}

async function listProducts(headers: Record<string, string>): Promise<Response> {
	return json({ products: await productsPayload() }, 200, headers);
}

async function createProduct(request: Request, headers: Record<string, string>): Promise<Response> {
	const body = await readJson(request);
	const name = requireString(body, "name");
	const purchase = requiredAmount(body, "purchaseAmount");
	const sale = requiredAmount(body, "saleAmount");
	// Currency is explicit: no silent reliance on a column default.
	const purchaseCurrency = requireCurrency(body, "purchaseCurrency");
	const saleCurrency = requireCurrency(body, "saleCurrency");

	const { rows } = await pool.query<{ id: string }>(
		`insert into product (name, purchase_amount, purchase_currency, sale_amount, sale_currency)
		 values ($1, $2, $3, $4, $5) returning id`,
		[name, purchase, purchaseCurrency, sale, saleCurrency],
	);

	return json({ id: rows[0]?.id, products: await productsPayload() }, 201, headers);
}

async function updateProduct(
	request: Request,
	headers: Record<string, string>,
	id: string,
): Promise<Response> {
	const body = await readJson(request);
	const fields: string[] = [];
	const values: unknown[] = [];

	const add = (column: string, value: unknown) => {
		values.push(value);
		fields.push(`${column} = $${values.length + 1}`);
	};

	if (body.name !== undefined) add("name", requireString(body, "name"));
	if (body.purchaseAmount !== undefined) add("purchase_amount", requiredAmount(body, "purchaseAmount"));
	if (body.saleAmount !== undefined) add("sale_amount", requiredAmount(body, "saleAmount"));
	if (body.purchaseCurrency !== undefined) add("purchase_currency", requireCurrency(body, "purchaseCurrency"));
	if (body.saleCurrency !== undefined) add("sale_currency", requireCurrency(body, "saleCurrency"));

	if (fields.length === 0) throw new ValidationError("Nothing to update");

	const { rowCount } = await pool.query(
		`update product set ${fields.join(", ")}, updated_at = now() where id = $1`,
		[id, ...values],
	);
	if (rowCount === 0) return json({ error: "Product not found" }, 404, headers);

	return json({ products: await productsPayload() }, 200, headers);
}

async function deleteProduct(headers: Record<string, string>, id: string): Promise<Response> {
	const { rowCount } = await pool.query(`delete from product where id = $1`, [id]);
	if (rowCount === 0) return json({ error: "Product not found" }, 404, headers);
	return json({ products: await productsPayload() }, 200, headers);
}

async function getRate(headers: Record<string, string>): Promise<Response> {
	const rates = await latestRates([REFERENCE_CURRENCY]);
	return json({ currency: REFERENCE_CURRENCY, rate: rates.get(REFERENCE_CURRENCY) ?? null }, 200, headers);
}

async function putRate(
	request: Request,
	headers: Record<string, string>,
	identity: Identity,
): Promise<Response> {
	// Rate entry is server-side work: only the admin account changes it.
	if (identity.role !== "admin") return json({ error: "Admin only" }, 403, headers);

	const body = await readJson(request);
	const cupPerUsd = requiredAmount(body, "cupPerUsd");
	if (parseDecimal(cupPerUsd).n <= 0n) throw new ValidationError("cupPerUsd must be greater than zero");

	const { rows } = await pool.query<RateRow>(
		`insert into exchange_rate (currency, cup_per_unit, source, observed_at)
		 values ($1, $2, 'manual', now())
		 returning currency, cup_per_unit, source, observed_at, fetched_at`,
		[REFERENCE_CURRENCY, cupPerUsd],
	);

	return json({ currency: REFERENCE_CURRENCY, rate: toRate(rows[0]) }, 200, headers);
}

async function getSettings(headers: Record<string, string>): Promise<Response> {
	const { rows } = await pool.query<{ value: string }>(
		`select value from app_setting where key = 'profitMode'`,
	);
	// No default: an unset preference stays null so the user chooses.
	return json({ profitMode: rows[0]?.value ?? null }, 200, headers);
}

// Best-effort throttle: serverless instances are per-process, so this limits bursts, not a determined attacker.
const attempts = new Map<string, { count: number; resetAt: number }>();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function isThrottled(key: string): boolean {
	const now = Date.now();
	const entry = attempts.get(key);
	if (!entry || entry.resetAt <= now) {
		attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
		return false;
	}
	entry.count += 1;
	return entry.count > MAX_ATTEMPTS;
}

// Public: exchanges the name the user types for a JWT, without exposing the internal email.
async function createSession(request: Request, headers: Record<string, string>): Promise<Response> {
	if (!authBaseUrl) return json({ error: "Auth is not configured" }, 500, headers);

	const body = await readJson(request);
	const name = requireString(body, "name");
	const password = requirePassword(body, "password");

	const key = name.toLowerCase();
	if (isThrottled(key)) return json({ error: "Too many attempts" }, 429, headers);

	const { rows } = await pool.query<{ email: string; role: string }>(
		`select email, role from app_user where lower(name) = lower($1) limit 1`,
		[name],
	);
	const account = rows[0] ?? null;
	const email = account?.email ?? null;

	// Always perform the sign-in call so an unknown name and a wrong password take similar time.
	const attemptEmail = email ?? `unknown-${crypto.randomUUID()}@invalid.local`;
	const origin = new URL(authBaseUrl).origin;
	const signIn = await fetch(`${authBaseUrl}/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ email: attemptEmail, password }),
	});
	if (!email || !signIn.ok) return json({ error: "Invalid credentials" }, 401, headers);

	const cookies = (signIn.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
	const tokenResponse = await fetch(`${authBaseUrl}/token`, { headers: { cookie: cookies, origin } });
	if (!tokenResponse.ok) return json({ error: "Could not issue a token" }, 502, headers);

	const { token } = (await tokenResponse.json()) as { token?: string };
	if (!token) return json({ error: "Could not issue a token" }, 502, headers);

	return json({ token, role: account?.role ?? "user" }, 200, headers);
}

async function putSettings(request: Request, headers: Record<string, string>): Promise<Response> {
	const body = await readJson(request);
	const mode = requireString(body, "profitMode");
	if (mode !== "margin" && mode !== "markup") {
		throw new ValidationError("profitMode must be margin or markup");
	}

	await pool.query(
		`insert into app_setting (key, value) values ('profitMode', $1)
		 on conflict (key) do update set value = excluded.value, updated_at = now()`,
		[mode],
	);

	return json({ profitMode: mode }, 200, headers);
}

function failureResponse(error: unknown, headers: Record<string, string>): Response {
	if (error instanceof ValidationError) return json({ error: error.message }, 400, headers);
	// Log only the error type: messages can carry driver or upstream detail.
	console.error("Unhandled API error:", error instanceof Error ? error.name : typeof error);
	return json({ error: "Unexpected error" }, 500, headers);
}

const handler = {
	async fetch(request: Request): Promise<Response> {
		const cors = corsHeaders(request);
		if (!cors) return new Response("Origin not allowed", { status: 403 });
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const productMatch = /^\/products\/([0-9a-f-]{36})$/.exec(path);

		if (path === "/session" && request.method === "POST") {
			try {
				return await createSession(request, cors);
			} catch (error) {
				return failureResponse(error, cors);
			}
		}

		const auth = await authenticate(request);
		if (isFailure(auth)) return json(auth.body, auth.status, cors);

		try {
			if (path === "/products" && request.method === "GET") return await listProducts(cors);
			if (path === "/products" && request.method === "POST") return await createProduct(request, cors);
			if (productMatch && request.method === "PATCH") {
				return await updateProduct(request, cors, productMatch[1]);
			}
			if (productMatch && request.method === "DELETE") return await deleteProduct(cors, productMatch[1]);
			if (path === "/rate" && request.method === "GET") return await getRate(cors);
			if (path === "/rate" && request.method === "PUT") return await putRate(request, cors, auth);
			if (path === "/settings" && request.method === "GET") return await getSettings(cors);
			if (path === "/settings" && request.method === "PUT") return await putSettings(request, cors);

			return json({ error: "Not found" }, 404, cors);
		} catch (error) {
			return failureResponse(error, cors);
		}
	},
};

export default handler;


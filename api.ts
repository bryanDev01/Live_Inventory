import { attachDatabasePool } from "@neon/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Pool } from "pg";
import { parseImportFile } from "./import-rows";
import { canonicalDecimalKey, cupEquivalent, decimalEquals, formatRounded, parseDecimal, profitPercent } from "./src/lib/money";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
	connectionString: databaseUrl,
	max: 1,
	connectionTimeoutMillis: 10_000,
});
attachDatabasePool(pool);

// A suspended compute can drop idle clients; without this listener Node would crash the process.
pool.on("error", (error) => {
	console.error("Database pool error:", error instanceof Error ? error.name : typeof error);
});

function isConnectionError(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "57P01" || code === "08006") return true;
	// A cold start often surfaces as a connection timeout without a code.
	return /timeout|terminat|connection/i.test((error as Error | null)?.message ?? "");
}

// Writes are never retried: a lost acknowledgement would duplicate the row.
async function query<T = unknown>(text: string, params: unknown[] = []) {
	return pool.query<T>(text, params);
}

// Reads may be retried once, to absorb a Neon cold start.
async function queryRead<T = unknown>(text: string, params: unknown[] = []) {
	try {
		return await pool.query<T>(text, params);
	} catch (error) {
		if (!isConnectionError(error)) throw error;
		return pool.query<T>(text, params);
	}
}

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
	return readJsonLimit(request, MAX_BODY_BYTES);
}

async function readJsonLimit(request: Request, limit: number): Promise<Record<string, unknown>> {
	const text = await readLimitedText(request, limit);
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
	let parsed;
	try {
		parsed = parseDecimal(value);
	} catch {
		throw new ValidationError(`${key} must be a plain decimal, for example 12.50`);
	}
	if (parsed.n <= 0n) throw new ValidationError(`${key} must be greater than zero`);
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
		const { rows } = await queryRead<{ role: string }>(
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

type RateRecord = { display: Rate; exact: string };

// One query for every currency in play, so listing products does not scale queries with rows.
async function latestRates(currencies: string[]): Promise<Map<string, RateRecord>> {
	const rates = new Map<string, RateRecord>();
	if (currencies.length === 0) return rates;

	const { rows } = await queryRead<RateRow>(
		`select distinct on (currency) currency, cup_per_unit, source, observed_at, fetched_at
		 from exchange_rate
		 where currency = any($1::text[])
		 order by currency, observed_at desc, fetched_at desc`,
		[currencies],
	);

	for (const row of rows) {
		const display = toRate(row);
		// The exact stored value feeds conversions; rounding is for display only.
		if (display) rates.set(row.currency, { display, exact: String(row.cup_per_unit) });
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
	const { rows } = await queryRead<ProductRow>(
		`select id, name, purchase_amount, purchase_currency, sale_amount, sale_currency
		 from product order by lower(name)`,
	);

	const rates = await latestRates([...new Set(rows.map((row) => row.purchase_currency))]);

	return rows.map((row) => {
		const purchase = String(row.purchase_amount);
		const sale = String(row.sale_amount);
		const record = rates.get(row.purchase_currency) ?? null;
		const sameCurrency = row.purchase_currency === row.sale_currency;

		// CUP needs no conversion; other currencies need their own stored rate.
		let cupEquivalentValue: string | null = null;
		let cupUnavailable: string | null = null;
		if (row.purchase_currency === "CUP") {
			cupEquivalentValue = formatRounded(parseDecimal(purchase), 2);
		} else if (record) {
			// Convert with the exact stored rate, then round the result once.
			cupEquivalentValue = cupEquivalent(purchase, record.exact);
		} else {
			cupUnavailable = `no-rate-for-${row.purchase_currency}`;
		}

		return {
			id: row.id,
			name: row.name,
			purchaseAmount: purchase,
			purchaseCurrency: row.purchase_currency,
			saleAmount: sale,
			saleCurrency: row.sale_currency,
			cupEquivalent: cupEquivalentValue,
			// Explicit state instead of a silent null: the UI can explain what is missing.
			cupUnavailable,
			rate: record?.display ?? null,
			// Comparing different currencies without an explicit conversion would be meaningless.
			profitMargin: sameCurrency ? profitPercent(purchase, sale, "margin") : null,
			profitMarkup: sameCurrency ? profitPercent(purchase, sale, "markup") : null,
			profitUnavailable: sameCurrency ? null : "different-currencies",
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

	const { rows } = await query<{ id: string }>(
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

	const { rowCount } = await query(
		`update product set ${fields.join(", ")}, updated_at = now() where id = $1`,
		[id, ...values],
	);
	if (rowCount === 0) return json({ error: "Product not found" }, 404, headers);

	return json({ products: await productsPayload() }, 200, headers);
}

async function deleteProduct(headers: Record<string, string>, id: string): Promise<Response> {
	const { rowCount } = await query(`delete from product where id = $1`, [id]);
	if (rowCount === 0) return json({ error: "Product not found" }, 404, headers);
	return json({ products: await productsPayload() }, 200, headers);
}

async function getRate(headers: Record<string, string>): Promise<Response> {
	const rates = await latestRates([REFERENCE_CURRENCY]);
	return json({ currency: REFERENCE_CURRENCY, rate: rates.get(REFERENCE_CURRENCY)?.display ?? null }, 200, headers);
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

	// A repeated identical value must not add a history row.
	const current = await queryRead<RateRow>(
		`select currency, cup_per_unit, source, observed_at, fetched_at
		 from exchange_rate where currency = $1
		 order by observed_at desc, fetched_at desc limit 1`,
		[REFERENCE_CURRENCY],
	);
	const latest = current.rows[0];
	const incoming = parseDecimal(cupPerUsd);
	if (latest) {
		const stored = parseDecimal(String(latest.cup_per_unit));
		if (decimalEquals(stored, incoming)) {
			return json({ currency: REFERENCE_CURRENCY, rate: toRate(latest) }, 200, headers);
		}
	}

	// Uniqueness is enforced by the (currency, source, observed_at) constraint in
	// db/migrations/001_core.sql, so a concurrent insert cannot create a duplicate.
	const { rows } = await query<RateRow>(
		`insert into exchange_rate (currency, cup_per_unit, source, observed_at)
		 select $1, $2, 'manual', date_trunc('minute', now())
		 on conflict (currency, source, observed_at) do nothing
		 returning currency, cup_per_unit, source, observed_at, fetched_at`,
		[REFERENCE_CURRENCY, cupPerUsd],
	);

	if (!rows[0]) {
		// The row existed already: identical value means success, a different one is a real conflict.
		const latest = await queryRead<RateRow>(
			`select currency, cup_per_unit, source, observed_at, fetched_at
			 from exchange_rate where currency = $1 order by observed_at desc, fetched_at desc limit 1`,
			[REFERENCE_CURRENCY],
		);
		const stored = latest.rows[0];
		if (stored && decimalEquals(parseDecimal(String(stored.cup_per_unit)), parseDecimal(cupPerUsd))) {
			return json({ currency: REFERENCE_CURRENCY, rate: toRate(stored) }, 200, headers);
		}
		return json({ error: "A different rate was already recorded this minute" }, 409, headers);
	}

	return json({ currency: REFERENCE_CURRENCY, rate: toRate(rows[0]) }, 200, headers);
}

async function getSettings(headers: Record<string, string>): Promise<Response> {
	const { rows } = await queryRead<{ value: string }>(
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
	// Drop expired entries so the map cannot grow without bound.
	for (const [storedKey, stored] of attempts) {
		if (stored.resetAt <= now) attempts.delete(storedKey);
	}
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

	const { rows } = await queryRead<{ email: string; role: string }>(
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

	if (!account) return json({ error: "Account is not configured" }, 500, headers);
	return json({ token, role: account.role }, 200, headers);
}

async function putSettings(request: Request, headers: Record<string, string>): Promise<Response> {
	const body = await readJson(request);
	const mode = requireString(body, "profitMode");
	if (mode !== "margin" && mode !== "markup") {
		throw new ValidationError("profitMode must be margin or markup");
	}

	await query(
		`insert into app_setting (key, value) values ('profitMode', $1)
		 on conflict (key) do update set value = excluded.value, updated_at = now()`,
		[mode],
	);

	return json({ profitMode: mode }, 200, headers);
}

function failureResponse(error: unknown, headers: Record<string, string>): Response {
	if (error instanceof ValidationError) return json({ error: error.message }, 400, headers);
	// 23505 is the unique violation raised by the product identity index.
	if ((error as { code?: string } | null)?.code === "23505") {
		return json({ error: "An identical product already exists" }, 409, headers);
	}
	if (error instanceof ConfigurationError) return json({ error: "Service is not configured" }, 503, headers);
	// Log only the error type: messages can carry driver or upstream detail.
	console.error("Unhandled API error:", error instanceof Error ? error.name : typeof error);
	return json({ error: "Unexpected error" }, 500, headers);
}

type ImportRowInput = {
	name: string;
	purchaseAmount: string;
	purchaseCurrency: string;
	saleAmount: string;
	saleCurrency: string;
};

type ImportRowResult = {
	row: number;
	values: ImportRowInput;
	status: "ok" | "error" | "duplicate";
	errors: string[];
};

// Limits are owner decisions (AGENTS.md B.9), so they must be configured explicitly.
class ConfigurationError extends Error {}

function importLimits(): { bytes: number; rows: number; uncompressed: number } {
	const megabytes = Number(process.env.IMPORT_MAX_MB);
	const rows = Number(process.env.IMPORT_MAX_ROWS);
	const expanded = Number(process.env.IMPORT_MAX_UNCOMPRESSED_MB);
	if (
		!Number.isFinite(megabytes) || megabytes <= 0 ||
		!Number.isInteger(rows) || rows <= 0 ||
		!Number.isFinite(expanded) || expanded <= 0
	) {
		throw new ConfigurationError("Import limits are not configured");
	}
	return { bytes: megabytes * 1024 * 1024, rows, uncompressed: expanded * 1024 * 1024 };
}

function validateImportRow(row: ImportRowInput): string[] {
	const errors: string[] = [];
	if (!row.name.trim()) errors.push("Missing name");

	for (const [label, value] of [
		["purchase price", row.purchaseAmount],
		["sale price", row.saleAmount],
	] as const) {
		if (!value) {
			errors.push(`Missing ${label}`);
			continue;
		}
		try {
			const parsed = parseDecimal(value);
			if (parsed.n <= 0n) errors.push(`${label} must be greater than zero`);
		} catch {
			errors.push(`${label} is not a valid number. Use a dot decimal separator, for example 12.50.`);
		}
	}

	for (const [label, value] of [
		["purchase currency", row.purchaseCurrency],
		["sale currency", row.saleCurrency],
	] as const) {
		const code = value.toUpperCase();
		if (!/^[A-Z]{3}$/.test(code)) errors.push(`${label} is invalid`);
		else if (!allowedCurrencies.includes(code)) errors.push(`${label} is not allowed`);
	}

	return errors;
}

function productKey(
	name: string,
	purchaseAmount: string,
	purchaseCurrency: string,
	saleAmount: string,
	saleCurrency: string,
): string {
	return JSON.stringify([
		name.trim(),
		canonicalDecimalKey(purchaseAmount),
		purchaseCurrency.toUpperCase(),
		canonicalDecimalKey(saleAmount),
		saleCurrency.toUpperCase(),
	]);
}

async function existingProductKeys(): Promise<Set<string>> {
	const { rows } = await queryRead<{
		name: string;
		purchase_amount: string;
		purchase_currency: string;
		sale_amount: string;
		sale_currency: string;
	}>(`select name, purchase_amount, purchase_currency, sale_amount, sale_currency from product`);

	const keys = new Set<string>();
	for (const row of rows) {
		keys.add(
			productKey(
				row.name,
				String(row.purchase_amount),
				row.purchase_currency,
				String(row.sale_amount),
				row.sale_currency,
			),
		);
	}

	return keys;
}

async function readImport(
	filename: string,
	buffer: Buffer,
	limits: { bytes: number; rows: number; uncompressed: number },
): Promise<{ rows: ImportRowResult[]; warnings: string[] }> {
	if (buffer.byteLength > limits.bytes) throw new ValidationError("The file is too large");

	let parsed;
	try {
		parsed = await parseImportFile(filename, buffer, limits.uncompressed);
	} catch (error) {
		// Client-fixable file problems must be reported, not turned into a 500.
		throw new ValidationError(error instanceof Error ? error.message : "The file could not be read");
	}

	if (parsed.rows.length > limits.rows) {
		throw new ValidationError(`The file has more than ${limits.rows} rows`);
	}

	const existing = await existingProductKeys();
	const seen = new Set<string>();
	const results: ImportRowResult[] = [];
	const warnings = [...parsed.warnings];

	for (const values of parsed.rows) {
		const { sourceRow, ...fields } = values;
		const errors = validateImportRow(fields);
		let status: ImportRowResult["status"] = errors.length > 0 ? "error" : "ok";

		if (status === "ok") {
			const key = productKey(
				fields.name,
				fields.purchaseAmount,
				fields.purchaseCurrency,
				fields.saleAmount,
				fields.saleCurrency,
			);
			if (existing.has(key) || seen.has(key)) status = "duplicate";
			seen.add(key);
		}

		results.push({ row: sourceRow, values: fields, status, errors });
	}

	return { rows: results, warnings };
}

async function importProducts(request: Request, headers: Record<string, string>): Promise<Response> {
	const limits = importLimits();
	const body = await readJsonLimit(request, limits.bytes * 2);
	const filename = typeof body.filename === "string" ? body.filename : "";
	const data = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
	const mode = body.mode === "apply" ? "apply" : "preview";
	if (!filename || !data) throw new ValidationError("Missing file");

	const buffer = Buffer.from(data, "base64");
	const { rows: results, warnings } = await readImport(filename, buffer, limits);
	const summary = {
		total: results.length,
		ok: results.filter((row) => row.status === "ok").length,
		errors: results.filter((row) => row.status === "error").length,
		duplicates: results.filter((row) => row.status === "duplicate").length,
	};

	if (mode !== "apply") return json({ mode: "preview", summary, warnings, rows: results }, 200, headers);

	const insertable = results.filter((row) => row.status === "ok");
	if (insertable.length === 0) {
		return json({ mode: "apply", summary, warnings, inserted: 0, rows: results }, 200, headers);
	}

	// Duplicates are blocked by the product_identity_idx unique index in db/migrations/003_product_identity.sql.
	const client = await pool.connect();
	const skipped: number[] = [];
	let inserted = 0;
	try {
		await client.query("begin");
		for (const row of insertable) {
			const result = await client.query(
				`insert into product (name, purchase_amount, purchase_currency, sale_amount, sale_currency)
				 values ($1, $2, $3, $4, $5)
				 on conflict do nothing
				 returning id`,
				[
					row.values.name,
					row.values.purchaseAmount,
					row.values.purchaseCurrency.toUpperCase(),
					row.values.saleAmount,
					row.values.saleCurrency.toUpperCase(),
				],
			);
			if (result.rowCount === 1) inserted += 1;
			else skipped.push(row.row);
		}
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}

	if (skipped.length > 0) {
		warnings.push(`Rows already present, not inserted: ${skipped.join(", ")}.`);
	}

	return json(
		{ mode: "apply", summary, warnings, inserted, skipped, products: await productsPayload() },
		200,
		headers,
	);
}


async function listCurrencies(headers: Record<string, string>): Promise<Response> {
	return json({ currencies: allowedCurrencies }, 200, headers);
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
			if (path === "/currencies" && request.method === "GET") return await listCurrencies(cors);
			if (path === "/products/import" && request.method === "POST") return await importProducts(request, cors);

			return json({ error: "Not found" }, 404, cors);
		} catch (error) {
			return failureResponse(error, cors);
		}
	},
};

export default handler;


import { inflateRawSync } from "node:zlib";
import mammoth from "mammoth";
import * as XLSX from "xlsx";

export type ImportRow = {
	// Physical row in the file, counting the header. Used to point the user at the right place.
	sourceRow: number;
	name: string;
	purchaseAmount: string;
	purchaseCurrency: string;
	saleAmount: string;
	saleCurrency: string;
};

export type ParsedImport = { rows: ImportRow[]; warnings: string[] };

// Only the five column names the owner confirmed. No aliases, no abbreviations.
const COLUMNS = {
	name: "nombre",
	purchaseAmount: "precio de compra",
	purchaseCurrency: "moneda de compra",
	saleAmount: "precio de venta",
	saleCurrency: "moneda de venta",
} as const;

type ColumnKey = keyof typeof COLUMNS;

function normalize(value: unknown): string {
	return String(value ?? "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

function mapHeaders(headerRow: unknown[]): Record<ColumnKey, number> | null {
	const normalized = headerRow.map(normalize);
	const map = {} as Record<ColumnKey, number>;

	for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
		const index = normalized.indexOf(COLUMNS[key]);
		if (index === -1) return null;
		map[key] = index;
	}
	return map;
}

// baseRow is the physical row number of matrix[0], so blank rows do not shift the reported numbers.
function rowsFromMatrix(matrix: unknown[][], warnings: string[], baseRow = 1): ImportRow[] {
	if (matrix.length === 0) throw new Error("The file is empty");

	const map = mapHeaders(matrix[0]);
	if (!map) {
		throw new Error(
			"Missing columns. Expected: nombre, precio de compra, moneda de compra, precio de venta, moneda de venta.",
		);
	}

	const rows: ImportRow[] = [];
	let blank = 0;

	for (let index = 1; index < matrix.length; index += 1) {
		const row = matrix[index];
		const sourceRow = baseRow + index;

		if (!row || row.every((cell) => normalize(cell) === "")) {
			blank += 1;
			continue;
		}

		rows.push({
			sourceRow,
			name: String(row[map.name] ?? "").trim(),
			purchaseAmount: String(row[map.purchaseAmount] ?? "").trim(),
			purchaseCurrency: String(row[map.purchaseCurrency] ?? "").trim(),
			saleAmount: String(row[map.saleAmount] ?? "").trim(),
			saleCurrency: String(row[map.saleCurrency] ?? "").trim(),
		});
	}

	if (blank > 0) warnings.push(`${blank} blank row(s) were skipped.`);
	return rows;
}

function tablesFromHtml(html: string): string[] {
	return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]);
}

function decodeEntities(text: string): string {
	// &amp; is decoded last so that "&amp;lt;" stays as the literal "&lt;".
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function rowsFromTable(table: string): unknown[][] {
	const matrix: unknown[][] = [];
	// Every <tr> is counted, including empty ones, so row numbers match the document.
	for (const rowMatch of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
		const cells: string[] = [];
		for (const cellMatch of rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
			const text = decodeEntities(cellMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
			cells.push(text);
		}
		matrix.push(cells);
	}
	return matrix;
}

export async function parseImportFile(
	filename: string,
	buffer: Buffer,
	maxUncompressedBytes: number,
): Promise<ParsedImport> {
	const name = filename.toLowerCase();
	const warnings: string[] = [];

	if (exceedsExpandedLimit(buffer, maxUncompressedBytes)) {
		throw new Error("The file expands to more than the allowed size");
	}
	// .xls (BIFF) is not a zip container, so the expansion guard does not apply to it.

	if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
		// raw: false returns the text the user sees in the cell, so money never passes through a binary float.
		const workbook = XLSX.read(buffer, { type: "buffer", cellText: true });
		if (workbook.SheetNames.length === 0) throw new Error("The workbook has no sheets");

		const populated = workbook.SheetNames.filter((sheet) => {
			const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], {
				header: 1,
				blankrows: false,
				raw: false,
			});
			return matrix.length > 0;
		});

		if (populated.length === 0) throw new Error("The workbook has no data");

		const chosen = populated[0];
		const ignored = workbook.SheetNames.filter((sheet) => sheet !== chosen);
		if (ignored.length > 0) {
			warnings.push(`Only sheet "${chosen}" was imported. Ignored sheets: ${ignored.join(", ")}.`);
		}

		const sheet = workbook.Sheets[chosen];
		const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
			header: 1,
			blankrows: true,
			raw: false,
			defval: "",
		});
		const baseRow = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r + 1 : 1;
		return { rows: rowsFromMatrix(matrix, warnings, baseRow), warnings };
	}

	if (name.endsWith(".docx")) {
		const result = await mammoth.convertToHtml({ buffer });
		for (const message of result.messages) {
			warnings.push(`Converter note: ${message.message}`);
		}

		const tables = tablesFromHtml(result.value);
		if (tables.length === 0) throw new Error("No table was found in the document");
		if (tables.length > 1) {
			warnings.push(`Only the first table was imported. The document contains ${tables.length} tables.`);
		}

		return { rows: rowsFromMatrix(rowsFromTable(tables[0]), warnings), warnings };
	}

	throw new Error("Unsupported format. Use .xlsx or .docx.");
}

// Walks the ZIP central directory (what readers use), then inflates each entry with a hard
// output cap so forged local headers cannot bypass the limit. Fails closed on anything unexpected.
export function exceedsExpandedLimit(buffer: Buffer, maxBytes: number): boolean {
	if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return false;
	// A zip container we cannot fully parse is rejected, never trusted.
	if (buffer.length < 22) return true;

	const eocdSignature = 0x06054b50;
	let eocd = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
		if (buffer.readUInt32LE(i) === eocdSignature) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return true;

	const entries = buffer.readUInt16LE(eocd + 10);
	const directoryOffset = buffer.readUInt32LE(eocd + 16);
	if (entries === 0xffff || directoryOffset === 0xffffffff) return true;

	let total = 0;
	let pointer = directoryOffset;

	for (let index = 0; index < entries; index += 1) {
		if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) return true;

		const method = buffer.readUInt16LE(pointer + 10);
		const compressedSize = buffer.readUInt32LE(pointer + 20);
		const localOffset = buffer.readUInt32LE(pointer + 42);
		const nameLength = buffer.readUInt16LE(pointer + 28);
		const extraLength = buffer.readUInt16LE(pointer + 30);
		const commentLength = buffer.readUInt16LE(pointer + 32);

		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) return true;

		const localName = buffer.readUInt16LE(localOffset + 26);
		const localExtra = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localName + localExtra;
		const data = buffer.subarray(dataStart, dataStart + compressedSize);
		if (data.length !== compressedSize) return true;

		try {
			if (method === 0) {
				total += compressedSize;
			} else {
				total += inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes - total) }).length;
			}
		} catch {
			return true;
		}

		if (total > maxBytes) return true;
		pointer += 46 + nameLength + extraLength + commentLength;
	}

	return false;
}

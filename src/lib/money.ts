// Exact decimal arithmetic for money and rates. No binary floating point.
// Values are kept as rationals n / d with d > 0, using bigint.

export type Decimal = { n: bigint; d: bigint };

export type ProfitMode = "margin" | "markup";

const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;

// Accepts only plain "digits" or "digits.digits" with a dot. Thousands separators and commas are rejected on purpose.
export function parseDecimal(input: string): Decimal {
  const value = input.trim();
  if (!UNSIGNED_DECIMAL.test(value)) {
    throw new Error(`Invalid decimal: "${input}"`);
  }
  const [whole, fraction = ""] = value.split(".");
  return { n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length) };
}

// Rounds half up (away from zero for negatives) to the given number of decimals.
export function formatRounded(value: Decimal, decimals: number): string {
  const negative = value.n < 0n;
  const absolute = negative ? -value.n : value.n;
  const scale = 10n ** BigInt(decimals);
  const scaled = (2n * absolute * scale + value.d) / (2n * value.d);

  const digits = scaled.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const body = decimals > 0 ? `${whole}.${fraction}` : whole;

  return negative && scaled !== 0n ? `-${body}` : body;
}

// CUP equivalent of an amount, given the rate expressed as CUP per one unit of that amount's currency.
// The caller owns the currency: this helper assumes no specific one.
export function cupEquivalent(purchaseAmount: string, ratePerUnitCup: string): string {
  const purchase = parseDecimal(purchaseAmount);
  const rate = parseDecimal(ratePerUnitCup);
  return formatRounded({ n: purchase.n * rate.n, d: purchase.d * rate.d }, 2);
}

// Profit percentage. Returns null when the denominator is zero, so the UI can show "not available".
//   margin: (sale - purchase) / sale * 100
//   markup: (sale - purchase) / purchase * 100
export function profitPercent(purchaseAmount: string, saleAmount: string, mode: ProfitMode): string | null {
  const purchase = parseDecimal(purchaseAmount);
  const sale = parseDecimal(saleAmount);
  const difference = sale.n * purchase.d - purchase.n * sale.d;

  if (mode === "margin") {
    if (sale.n === 0n) return null;
    return formatRounded({ n: 100n * difference, d: purchase.d * sale.n }, 2);
  }

  if (purchase.n === 0n) return null;
  return formatRounded({ n: 100n * difference, d: sale.d * purchase.n }, 2);
}

// Equality without division: a/b === c/d when a*d === c*b.
export function decimalEquals(a: Decimal, b: Decimal): boolean {
  return a.n * b.d === b.n * a.d;
}

// Canonical key so "12.50" and "12.5" produce the same string.
export function canonicalDecimalKey(value: string): string {
  const { n, d } = parseDecimal(value);
  let a = n;
  let b = d;
  while (b !== 0n) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  const divisor = a === 0n ? 1n : a;
  return `${n / divisor}/${d / divisor}`;
}


export function multiplyDecimals(a: string, b: string): Decimal {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return { n: x.n * y.n, d: x.d * y.d };
}

export function subtractDecimals(a: Decimal, b: Decimal): Decimal {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d };
}

// Percentage from exact values, so no intermediate rounding happens.
export function percentOf(purchase: Decimal, sale: Decimal, mode: ProfitMode): string | null {
  const difference = sale.n * purchase.d - purchase.n * sale.d;
  const denominator = mode === "margin" ? purchase.d * sale.n : sale.d * purchase.n;
  if (denominator === 0n) return null;
  return formatRounded({ n: 100n * difference, d: denominator }, 2);
}

export function formatDecimal(value: Decimal): string {
  return formatRounded(value, 2);
}

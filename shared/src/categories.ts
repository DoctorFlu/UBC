/**
 * Market categories. The id is the bit position in the policy's `allowedCategories` bitmask and the
 * `uint8 category` argument of `proposeTrade`.
 */

export const Category = {
  Crypto: 0,
  Sports: 1,
  Economics: 2,
  Commodities: 3,
  Weather: 4,
  Politics: 5,
  Other: 6,
} as const;

export type CategoryName = keyof typeof Category;
export type CategoryId = (typeof Category)[CategoryName];

export const CATEGORY_IDS: readonly CategoryId[] = Object.values(Category);

export const CATEGORY_LABELS: Readonly<Record<CategoryId, CategoryName>> = {
  0: "Crypto",
  1: "Sports",
  2: "Economics",
  3: "Commodities",
  4: "Weather",
  5: "Politics",
  6: "Other",
};

/** Every known category allowed. */
export const ALL_CATEGORIES_MASK: number = categoryMask(CATEGORY_IDS);

export function isCategoryId(value: number): value is CategoryId {
  return Number.isInteger(value) && value >= 0 && value <= Category.Other;
}

export function categoryLabel(id: number): string {
  return isCategoryId(id) ? CATEGORY_LABELS[id] : `Unknown (${id})`;
}

/**
 * Maps Gemini's market `category` string (for example "Crypto", "Sports", "Economics", "Commodities",
 * "Weather") to a category id. Matching ignores case and surrounding space; anything unknown is Other.
 */
export function categoryFromGemini(geminiCategory: string): CategoryId {
  const wanted = geminiCategory.trim().toLowerCase();
  for (const id of CATEGORY_IDS) {
    if (CATEGORY_LABELS[id].toLowerCase() === wanted) return id;
  }
  return Category.Other;
}

/** Bitmask with the given category ids set. */
export function categoryMask(ids: Iterable<number>): number {
  let mask = 0;
  for (const id of new Set(ids)) {
    if (!isCategoryId(id)) throw new RangeError(`unknown category id ${id}`);
    mask += 2 ** id;
  }
  return mask;
}

/**
 * Whether bit `category` is set in `mask`. Uses arithmetic instead of bitwise operators, which truncate
 * to 32 bits, so it agrees with the contract for any safe-integer mask and any uint8 category.
 */
export function isCategoryAllowed(mask: number, category: number): boolean {
  if (!Number.isInteger(category) || category < 0 || category > 255) return false;
  return Math.floor(mask / 2 ** category) % 2 === 1;
}

/** Known category ids whose bit is set in `mask`, in id order. */
export function categoriesFromMask(mask: number): CategoryId[] {
  return CATEGORY_IDS.filter((id) => isCategoryAllowed(mask, id));
}

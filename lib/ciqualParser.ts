export function parseTeneurValue(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '-' || trimmed === '') return 0;
  if (trimmed.toLowerCase() === 'traces') return 0;
  const withoutLessThan = trimmed.replace(/^(&lt;|<)\s*/, '');
  const normalized = withoutLessThan.replace(',', '.');
  const value = parseFloat(normalized);
  return Number.isNaN(value) ? 0 : value;
}

export function normalizeFoodName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// Ciqual names are comma-separated descriptor lists ("Poulet, filet sans peau grillé/poêlé"),
// not natural phrases, and use gendered/plural cooking adjectives ("cuite", "cuits", "rôties")
// that a plain "cuit" query never literally contains. Matching by tokens (instead of a raw
// substring of the whole query) makes word order and punctuation irrelevant; folding all cooking-
// state variants down to isCookedToken/isRawToken lets "poulet cuit" match "grillé/poêlé" or
// "rôtie/cuite au four" entries, and excludes raw ones, without needing an exact wording match.
const COOKED_TOKENS = new Set([
  'cuit', 'cuite',
  'roti', 'rotie',
  'grille', 'grillee',
  'bouilli', 'bouillie',
  'poele', 'poelee',
  'frit', 'frite',
  'vapeur', 'four', 'poche', 'pochee',
]);

const RAW_TOKENS = new Set(['cru', 'crue']);

function singularize(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

export function tokenizeFoodName(name: string): string[] {
  return normalizeFoodName(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(singularize);
}

export function isCookedToken(token: string): boolean {
  return COOKED_TOKENS.has(token);
}

export function isRawToken(token: string): boolean {
  return RAW_TOKENS.has(token);
}

export interface CiqualFoodName {
  alimCode: string;
  nameFr: string;
}

export function parseAlimNames(xmlContent: string): CiqualFoodName[] {
  const blocks = xmlContent.split('<ALIM>').slice(1);
  const foods: CiqualFoodName[] = [];
  for (const block of blocks) {
    const codeMatch = block.match(/<alim_code>\s*([^<]*?)\s*<\/alim_code>/);
    const nameMatch = block.match(/<alim_nom_fr>\s*([^<]*?)\s*<\/alim_nom_fr>/);
    if (codeMatch && nameMatch) {
      foods.push({ alimCode: codeMatch[1].trim(), nameFr: nameMatch[1].trim() });
    }
  }
  return foods;
}

export interface CiqualCompoRow {
  alimCode: string;
  constCode: string;
  teneur: number;
}

export function parseCompoBlock(blockText: string): CiqualCompoRow | null {
  const alimMatch = blockText.match(/<alim_code>\s*([^<]*?)\s*<\/alim_code>/);
  const constMatch = blockText.match(/<const_code>\s*([^<]*?)\s*<\/const_code>/);
  const teneurMatch = blockText.match(/<teneur>\s*([^<]*?)\s*<\/teneur>/);
  if (!alimMatch || !constMatch || !teneurMatch) return null;
  return {
    alimCode: alimMatch[1].trim(),
    constCode: constMatch[1].trim(),
    teneur: parseTeneurValue(teneurMatch[1]),
  };
}

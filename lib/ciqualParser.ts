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

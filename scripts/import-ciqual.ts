import 'dotenv/config';
import { readFileSync, createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { prisma } from '../lib/db.js';
import { parseAlimNames, parseCompoBlock, normalizeFoodName } from '../lib/ciqualParser.js';

const ALIM_PATH = fileURLToPath(new URL('../data/alim_2025_11_03.xml', import.meta.url));
const COMPO_PATH = fileURLToPath(new URL('../data/compo_2025_11_03.xml', import.meta.url));

const TARGET_CODES: Record<string, 'kcal' | 'protein' | 'carbs' | 'fat'> = {
  '328': 'kcal',
  '25000': 'protein',
  '31000': 'carbs',
  '40000': 'fat',
};

interface Macros {
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
}

async function readMacrosByAlimCode(): Promise<Map<string, Macros>> {
  const macrosByCode = new Map<string, Macros>();
  const rl = createInterface({ input: createReadStream(COMPO_PATH, { encoding: 'utf-8' }) });

  let buffer: string[] = [];
  let inCompo = false;

  for await (const line of rl) {
    if (line.includes('<COMPO>')) {
      inCompo = true;
      buffer = [];
      continue;
    }
    if (line.includes('</COMPO>')) {
      inCompo = false;
      const row = parseCompoBlock(buffer.join('\n'));
      const key = row ? TARGET_CODES[row.constCode] : undefined;
      if (row && key) {
        const entry = macrosByCode.get(row.alimCode) ?? {};
        entry[key] = row.teneur;
        macrosByCode.set(row.alimCode, entry);
      }
      continue;
    }
    if (inCompo) buffer.push(line);
  }

  return macrosByCode;
}

async function main() {
  console.log('Reading food names...');
  const alimXml = readFileSync(ALIM_PATH, 'utf-8');
  const names = parseAlimNames(alimXml);
  console.log(`Found ${names.length} foods.`);

  console.log('Reading nutrient composition (this streams a 69MB file, may take a bit)...');
  const macrosByCode = await readMacrosByAlimCode();
  console.log(`Found macros for ${macrosByCode.size} foods.`);

  const BATCH_SIZE = 20;
  let imported = 0;

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ alimCode, nameFr }) => {
        const macros = macrosByCode.get(alimCode);
        if (!macros) return;
        await prisma.food.upsert({
          where: { ciqualCode: alimCode },
          create: {
            ciqualCode: alimCode,
            name: nameFr,
            nameNormalized: normalizeFoodName(nameFr),
            kcalPer100g: macros.kcal ?? 0,
            proteinPer100g: macros.protein ?? 0,
            carbsPer100g: macros.carbs ?? 0,
            fatPer100g: macros.fat ?? 0,
          },
          update: {
            name: nameFr,
            nameNormalized: normalizeFoodName(nameFr),
            kcalPer100g: macros.kcal ?? 0,
            proteinPer100g: macros.protein ?? 0,
            carbsPer100g: macros.carbs ?? 0,
            fatPer100g: macros.fat ?? 0,
          },
        });
        imported++;
      })
    );
  }

  console.log(`Imported/updated ${imported} foods.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

import { describe, it, expect } from 'vitest';
import {
  parseTeneurValue,
  normalizeFoodName,
  parseAlimNames,
  parseCompoBlock,
} from '../lib/ciqualParser.js';

describe('parseTeneurValue', () => {
  it('parses a plain comma-decimal number', () => {
    expect(parseTeneurValue(' 59,7 ')).toBeCloseTo(59.7, 5);
  });

  it('parses a plain integer', () => {
    expect(parseTeneurValue(' 274 ')).toBe(274);
  });

  it('treats an HTML-entity "less than" trace marker as its numeric value', () => {
    expect(parseTeneurValue(' &lt; 0,05 ')).toBeCloseTo(0.05, 5);
  });

  it('treats a literal "<" trace marker as its numeric value', () => {
    expect(parseTeneurValue(' < 1 ')).toBeCloseTo(1, 5);
  });

  it('treats "traces" as 0', () => {
    expect(parseTeneurValue(' traces ')).toBe(0);
  });

  it('treats "-" (not determined) as 0', () => {
    expect(parseTeneurValue(' - ')).toBe(0);
  });
});

describe('normalizeFoodName', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeFoodName('Riz basmati, cuit, sans sel ajouté')).toBe(
      'riz basmati, cuit, sans sel ajoute'
    );
  });
});

describe('parseAlimNames', () => {
  const fixture = `<TABLE>
<ALIM>
<alim_code> 1000 </alim_code>
<alim_nom_fr> Riz basmati, cuit, sans sel ajouté </alim_nom_fr>
<alim_nom_eng> Rice, basmati, cooked, unsalted </alim_nom_eng>
</ALIM>
<ALIM>
<alim_code> 1001 </alim_code>
<alim_nom_fr> Poulet, blanc, cuit </alim_nom_fr>
<alim_nom_eng> Chicken, breast, cooked </alim_nom_eng>
</ALIM>
</TABLE>`;

  it('extracts alim_code + alim_nom_fr for every ALIM block', () => {
    const result = parseAlimNames(fixture);
    expect(result).toEqual([
      { alimCode: '1000', nameFr: 'Riz basmati, cuit, sans sel ajouté' },
      { alimCode: '1001', nameFr: 'Poulet, blanc, cuit' },
    ]);
  });
});

describe('parseCompoBlock', () => {
  it('extracts alim_code, const_code and the parsed teneur from a COMPO block', () => {
    const block = `
      <alim_code> 1000 </alim_code>
      <const_code> 328 </const_code>
      <teneur> 274 </teneur>
      <min missing="1" />
      <max missing="1" />
      <code_confiance>A</code_confiance>
      <source_code>1</source_code>
    `;
    expect(parseCompoBlock(block)).toEqual({ alimCode: '1000', constCode: '328', teneur: 274 });
  });

  it('returns null when a required field is missing', () => {
    const block = `<const_code> 328 </const_code><teneur> 274 </teneur>`;
    expect(parseCompoBlock(block)).toBeNull();
  });
});

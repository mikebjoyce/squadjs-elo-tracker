#!/usr/bin/env node
/**
 * elo-clans-audit.js
 *
 * Utility script to test and verify clan tag extraction and normalization logic.
 * Reads player names from a database export (e.g. tools/rebuilt.json) and
 * outputs a report of all detected clan groupings and orphaned names.
 *
 * Usage:
 *   node tools/elo-clans-audit.js [path/to/db.json]
 */

import { readFileSync, writeFileSync } from 'fs';

const BRACKET_PAIRS = [
  ['\\[', '\\]'], ['\\(', '\\)'], ['【', '】'], ['「', '」'], ['『', '』'], ['《', '》'],
  ['╔', '╗'], ['├', '┤'], ['↾', '↿'], ['╬', '╬'], ['✦', '✦'], ['⟦', '⟧'], ['╟', '╢'],
  ['\\|', '\\|'], ['=', '='], ['<', '>'], ['\\{', '\\}']
];

const NON_ASCII_MAP = {
  'ƒ': 'f', 'И': 'n', '丹': 'a', '匚': 'c', 'н': 'h', '尺': 'r', 'λ': 'a', 'ν': 'v', 'є': 'e',
  '†': 't', 'Ð': 'd', 'ø': 'o', 'ß': 'ss', 'ค': 'a', 'г': 'r', 'ς': 'c', 'ɦ': 'h', 'м': 'm',
  'я': 'r', 'ċ': 'c'
};

function extractRawPrefix(name) {
  // 1. Match 2+ space separator (common in Squad names) - prioritize this as it's very specific
  const spaceRegex = /^\s*(.{1,10}?)\s{2,}/;
  let match = name.match(spaceRegex);
  if (match) return match[1].trim();

  // 2. Match bracketed tags at the start (allow mismatched pairs like {TAG) or [TAG})
  const bracketRegex = /^\s*([\[\(【「『《╔├↾╬✦⟦╟|=<\{~\*].+?[\]\)】」』》╗┤↿╬✦⟧╢|=<~\*\}])/;
  match = name.match(bracketRegex);
  if (match) return match[1].trim();

  // 3. Match separator-based tags: TAG // Name, TAG | Name, TAG - Name, TAG : Name, TAG † Name, TAG ™ Name, TAG ✯ Name, TAG :( Name
  const sepRegex = /^\s*(.{1,10}?)\s*(?:\/\/|\||-|:|\:\(|\:\)|†|\u2020|™|✯|~|\*)\s+/;
  match = name.match(sepRegex);
  if (match) {
    return match[1].trim();
  }
  
  // 4. Match single trailing space for very short all-caps tags (e.g. "KM Lookout")
  // Only match 2-4 chars, all caps, followed by a single space, then a capital letter
  const shortTagRegex = /^\s*([A-Z0-9]{2,4})\s+[A-Z]/;
  match = name.match(shortTagRegex);
  if (match) return match[1].trim();

  return null;
}

function normalizeTag(raw) {
  if (!raw) return null;

  // Handle accents (e.g. Café -> Cafe)
  let norm = raw.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Replace gamer characters (e.g. 丹 -> a)
  for (const [key, val] of Object.entries(NON_ASCII_MAP)) {
    norm = norm.replace(new RegExp(key, 'gi'), val);
  }

  // Strip all non-alphanumeric and uppercase
  norm = norm.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return norm || null;
}

const args = process.argv.slice(2);
const dbPath = args[0] || 'tools/rebuilt.json';

// Ensure the db exists
let rawData;
try {
  rawData = JSON.parse(readFileSync(dbPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${dbPath}:`, e.message);
  process.exit(1);
}

const players = Array.isArray(rawData) ? rawData : rawData.players ?? Object.values(rawData);

const clanGroups = new Map();
let unassigned = [];

players.forEach(p => {
  const rawPrefix = extractRawPrefix(p.name);
  const normalized = normalizeTag(rawPrefix);

  if (normalized) {
    if (!clanGroups.has(normalized)) {
      clanGroups.set(normalized, []);
    }
    clanGroups.get(normalized).push({ name: p.name, rawPrefix });
  } else {
    // Collect some unassigned names to spot missed tags
    if (unassigned.length < 500) {
      unassigned.push(p.name);
    }
  }
});

// Sort groups by size
const sortedGroups = Array.from(clanGroups.entries())
  .filter(([_, members]) => members.length > 0)
  .sort((a, b) => b[1].length - a[1].length);

let output = '=== CLAN GROUPINGS (All) ===\n\n';

sortedGroups.forEach(([norm, members]) => {
  output += `[${norm}] - ${members.length} members\n`;
  // Show unique raw prefixes that mapped to this group
  const uniqueRaw = [...new Set(members.map(m => m.rawPrefix))];
  output += `  Raw Variations: ${uniqueRaw.join(', ')}\n`;
  // Show up to 5 member names as examples
  output += `  Examples: ${members.slice(0, 5).map(m => m.name).join(', ')}\n\n`;
});

output += '=== SAMPLE UNASSIGNED NAMES (First 200) ===\n';
output += unassigned.slice(0, 200).join('\n');

const outPath = 'tools/clan-audit.txt';
writeFileSync(outPath, output);
console.log(`Audit complete. Processed ${players.length} players.`);
console.log(`Found ${sortedGroups.length} unique clan groupings.`);
console.log(`Results saved to ${outPath}`);

#!/usr/bin/env node
// Deterministic synthetic vault generator for Pi Agent performance testing.
// Usage: node perf/tools/seed-test-vault.mjs <vault-dir>
//
// Generates a fixed corpus (seed 20260928) of Markdown notes with frontmatter,
// wiki links, tags, hub notes, and longform notes. Intended for the PATCH 0
// baseline and later benchmark runs. Existing files are not removed; generated
// note names are stable so re-running the script is idempotent.

import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node perf/tools/seed-test-vault.mjs <vault-dir>");
  process.exit(1);
}

const ROOT = path.resolve(target);
const SEED = 20260928;

function mulberry32(seed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];

const WORDS = (
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau " +
  "upsilon phi chi psi omega vault note link graph tag context search index cache stream event render " +
  "queue batch drain yield scheduler profiler metric latency budget frame chunk delta snapshot pipeline " +
  "backpressure coalesce retention compaction annotation thread session prompt tool call response"
).split(/\s+/);

const TOPICS = [
  "architecture",
  "performance",
  "rpc",
  "rendering",
  "context",
  "tooling",
  "release",
  "docs",
  "workflow",
  "testing"
];

function sentence() {
  const count = int(6, 16);
  const parts = [];
  for (let i = 0; i < count; i += 1) parts.push(pick(WORDS));
  const text = parts.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

function paragraph() {
  const count = int(3, 6);
  const sentences = [];
  for (let i = 0; i < count; i += 1) sentences.push(sentence());
  return sentences.join(" ");
}

function tagsFor(index) {
  const tags = [`topic-${pick(TOPICS)}`];
  if (index % 5 === 0) tags.push("review");
  if (index % 7 === 0) tags.push("draft");
  return tags;
}

function noteBody(index, total, linkPool) {
  const paragraphs = [paragraph(), paragraph()];
  if (index % 4 === 0) paragraphs.push(paragraph());
  const links = [];
  const linkCount = int(3, 8);
  for (let i = 0; i < linkCount; i += 1) {
    const target = pick(linkPool);
    links.push(`[[${target}]]`);
  }
  const linkLine = `Related: ${links.join(", ")}.`;
  const inlineTags = `#${pick(TOPICS)} #index${index % 16}`;
  return `${paragraphs.join("\n\n")}\n\n${linkLine}\n\n${inlineTags}\n`;
}

function frontmatter(title, tags) {
  return [
    "---",
    `title: ${title}`,
    `tags: [${tags.join(", ")}]`,
    `created: 2026-${String(int(1, 9)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
    "---",
    ""
  ].join("\n");
}

const notes = [];
const NOTE_COUNT = 350;
for (let i = 1; i <= NOTE_COUNT; i += 1) {
  const folder = `Notes/Area-${i % 8}`;
  const title = `note-${String(i).padStart(4, "0")}`;
  notes.push({ folder, title, kind: "regular" });
}
for (let i = 1; i <= 15; i += 1) {
  notes.push({ folder: "Hubs", title: `hub-${String(i).padStart(2, "0")}`, kind: "hub" });
}
for (let i = 1; i <= 8; i += 1) {
  notes.push({ folder: "Longform", title: `longform-${String(i).padStart(2, "0")}`, kind: "long" });
}
for (let i = 1; i <= 60; i += 1) {
  notes.push({ folder: "Daily", title: `2026-08-${String(i).padStart(2, "0")}`, kind: "daily" });
}

const regularPool = notes.filter((n) => n.kind === "regular").map((n) => n.title);
const allPool = notes.map((n) => n.title);

let written = 0;
let bytes = 0;

for (let i = 0; i < notes.length; i += 1) {
  const note = notes[i];
  const dir = path.join(ROOT, note.folder);
  fs.mkdirSync(dir, { recursive: true });
  let content;
  if (note.kind === "hub") {
    const linkCount = int(80, 150);
    const links = [];
    for (let j = 0; j < linkCount; j += 1) links.push(`[[${pick(allPool)}]]`);
    content =
      frontmatter(note.title, tagsFor(i)) +
      `# ${note.title}\n\n` +
      [paragraph(), paragraph(), paragraph()].join("\n\n") +
      `\n\n## Links\n\n${links.join(" ")}\n`;
  } else if (note.kind === "long") {
    const blocks = [];
    for (let j = 0; j < int(40, 60); j += 1) blocks.push(paragraph());
    content =
      frontmatter(note.title, tagsFor(i)) +
      `# ${note.title}\n\n` +
      blocks.join("\n\n") +
      `\n\nSource: [[${pick(regularPool)}]]\n`;
  } else if (note.kind === "daily") {
    content =
      frontmatter(note.title, tagsFor(i)) +
      `# ${note.title}\n\n` +
      `- ${sentence()}\n- ${sentence()}\n- ${sentence()}\n\n` +
      `Refs: [[${pick(regularPool)}]] [[${pick(regularPool)}]]\n`;
  } else {
    content = frontmatter(note.title, tagsFor(i)) + `# ${note.title}\n\n` + noteBody(i, NOTE_COUNT, regularPool);
  }
  const filePath = path.join(dir, `${note.title}.md`);
  fs.writeFileSync(filePath, content, "utf8");
  written += 1;
  bytes += Buffer.byteLength(content);
}

console.log(`Seeded ${written} notes into ${ROOT}`);
console.log(`Total Markdown bytes: ${bytes} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`);

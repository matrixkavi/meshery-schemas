#!/usr/bin/env node
/**
 * validate-schemas.js — Schema Design Validation
 *
 * DESCRIPTION:
 *   Validates that all v1beta1+ entity schemas follow the Dual-Schema Pattern:
 *
 *   Rule 1 — Entity schemas (<construct>.yaml) must have `additionalProperties: false`
 *             at the top level.
 *
 *   Rule 2 — POST/PUT requestBody schemas must not contain server-generated fields
 *             (id, created_at, updated_at, deleted_at) in their `required` array.
 *             This indicates the full entity schema is being used as a request body
 *             instead of a dedicated *Payload schema.
 *
 * USAGE:
 *   node build/validate-schemas.js          # exits 0 if clean, 1 if violations found
 *   node build/validate-schemas.js --warn   # always exits 0, only prints warnings
 *
 * DEPENDENCIES:
 *   js-yaml (already a project dependency)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const CONSTRUCTS_DIR = path.join(ROOT, "schemas", "constructs");

// Fields that are always server-generated and should never be required in write payloads.
const SERVER_GENERATED_FIELDS = new Set(["id", "created_at", "updated_at", "deleted_at"]);

// Only validate these versions (alpha schemas predate the pattern).
const VALIDATED_VERSIONS = ["v1beta1", "v1beta2-draft"];

const warnOnly = process.argv.includes("--warn");
const violations = [];

function warn(file, message) {
  violations.push({ file: path.relative(ROOT, file), message });
}

// ─── Rule 1: entity schemas must have additionalProperties: false ─────────────

function validateEntitySchema(filePath) {
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return; // unparseable — not our concern here
  }

  if (!doc || typeof doc !== "object") return;
  if (doc.type !== "object") return; // skip non-object schemas (enums, etc.)

  if (doc.additionalProperties !== false) {
    warn(
      filePath,
      `Missing \`additionalProperties: false\` at top level. ` +
        `Entity schemas must set this to prevent unknown fields in generated structs.`,
    );
  }
}

// ─── Rule 2: POST/PUT requestBody must not use the full entity schema ─────────

function resolveLocalRef(ref, components) {
  // Only handle local component refs: "#/components/schemas/Foo"
  const match = ref && ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return null;
  return components?.schemas?.[match[1]] ?? null;
}

function getRequiredFields(schema, components) {
  if (!schema) return [];
  // Follow a top-level $ref to a local component
  if (schema.$ref) {
    const resolved = resolveLocalRef(schema.$ref, components);
    return resolved ? getRequiredFields(resolved, components) : [];
  }
  return Array.isArray(schema.required) ? schema.required : [];
}

function validateApiSpec(filePath) {
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return;
  }

  if (!doc?.paths) return;
  const components = doc.components ?? {};

  for (const [routePath, pathItem] of Object.entries(doc.paths)) {
    for (const method of ["post", "put", "patch"]) {
      const op = pathItem[method];
      if (!op?.requestBody) continue;

      // Collect all content schemas for this requestBody
      const contentMap = op.requestBody.content ?? {};
      for (const [mediaType, mediaObj] of Object.entries(contentMap)) {
        if (!mediaObj?.schema) continue;

        const required = getRequiredFields(mediaObj.schema, components);
        const offending = required.filter((f) => SERVER_GENERATED_FIELDS.has(f));

        if (offending.length > 0) {
          const schemaRef = mediaObj.schema.$ref ?? "(inline)";
          warn(
            filePath,
            `${method.toUpperCase()} ${routePath} — requestBody schema ${schemaRef} ` +
              `has server-generated field(s) in \`required\`: [${offending.join(", ")}]. ` +
              `Use a dedicated *Payload schema that omits server-generated required fields. ` +
              `See AGENTS.md § "The Dual-Schema Pattern".`,
          );
        }
      }
    }
  }
}

// ─── Walk constructs directory ────────────────────────────────────────────────

function shouldValidateVersion(version) {
  return VALIDATED_VERSIONS.some((v) => version === v || version.startsWith(v));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const version = entry.name;
    if (!shouldValidateVersion(version)) continue;

    const versionDir = path.join(dir, version);

    for (const construct of fs.readdirSync(versionDir, { withFileTypes: true })) {
      if (!construct.isDirectory()) continue;

      const constructDir = path.join(versionDir, construct.name);

      // Rule 1: check all top-level *.yaml files (entity schemas, not api.yml)
      for (const file of fs.readdirSync(constructDir)) {
        if (
          file.endsWith(".yaml") &&
          file !== "api.yml" &&
          !file.includes("_template") &&
          !file.includes("_page")
        ) {
          validateEntitySchema(path.join(constructDir, file));
        }
      }

      // Rule 2: check api.yml for bad requestBody references
      const apiYml = path.join(constructDir, "api.yml");
      if (fs.existsSync(apiYml)) {
        validateApiSpec(apiYml);
      }
    }
  }
}

walk(CONSTRUCTS_DIR);

// ─── Report ───────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log("✓ validate-schemas: no violations found.");
  process.exit(0);
}

console.error(`\nvalidate-schemas: ${violations.length} violation(s) found:\n`);
for (const { file, message } of violations) {
  console.error(`  ${file}\n    → ${message}\n`);
}

if (warnOnly) {
  process.exit(0);
} else {
  process.exit(1);
}

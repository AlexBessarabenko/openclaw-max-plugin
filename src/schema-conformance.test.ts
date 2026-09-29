/**
 * Conformance with the published MAX Bot API schema snapshot
 * (src/__fixtures__/max-schema-<version>.yaml, refreshed by
 * `node scripts/update-schema.mjs`).
 *
 * The plugin's constants are checked against the schema so a MAX-side rename
 * or removal fails here before it fails live: update-type coverage, button
 * wire types and required fields, sender actions, attachment types and the
 * callback-answer shape.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { MAX_HANDLED_UPDATE_TYPES, MAX_IGNORED_UPDATE_TYPES } from "../index.js";
import { MaxButtonSchema } from "./keyboards.js";

type Schema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
  enum?: string[];
  allOf?: Schema[];
  discriminator?: { propertyName: string; mapping: Record<string, string> };
};
type OpenApi = {
  info: { version: string };
  components: { schemas: Record<string, Schema> };
};

const here = dirname(fileURLToPath(import.meta.url));
const schema = parse(
  readFileSync(join(here, "__fixtures__", "max-schema-0.0.33.yaml"), "utf8"),
) as OpenApi;
const schemas = schema.components.schemas;

function schemaByRef(ref: string): Schema {
  const name = ref.replace("#/components/schemas/", "");
  const found = schemas[name];
  if (!found) throw new Error(`schema ${name} not found in snapshot`);
  return found;
}

/** required fields of a discriminated subschema (Button allOfs the base). */
function requiredOf(sub: Schema): string[] {
  const fromAllOf = (sub.allOf ?? []).flatMap((part) =>
    part.$ref ? [] : (part.required ?? []),
  );
  return [...(sub.required ?? []), ...fromAllOf];
}

describe("MAX API schema conformance (0.0.33 snapshot)", () => {
  it("covers every update_type: handled or deliberately ignored", () => {
    const mapping = schemas.Update?.discriminator?.mapping ?? {};
    const schemaTypes = Object.keys(mapping).sort();
    const ours = [...MAX_HANDLED_UPDATE_TYPES, ...MAX_IGNORED_UPDATE_TYPES].sort();
    expect(ours).toEqual(schemaTypes);
  });

  it("sends only button types the schema defines, with required fields", () => {
    const mapping = schemas.Button?.discriminator?.mapping ?? {};
    const ours = MaxButtonSchema.options.map((option) => option.shape.type.value).sort();
    const schemaTypes = Object.keys(mapping).sort();
    // every wire type we can emit must exist in the schema
    for (const type of ours) expect(schemaTypes).toContain(type);
    // and the schema must not have grown a type we reject unknowingly
    expect(ours).toEqual(schemaTypes);

    // required fields per type match the schema (text comes from the base)
    const expectRequired = (type: string, fields: string[]) => {
      const sub = schemaByRef(mapping[type]);
      for (const field of fields) expect(requiredOf(sub)).toContain(field);
    };
    expectRequired("callback", ["payload"]);
    expectRequired("link", ["url"]);
    expectRequired("clipboard", ["payload"]);
    expectRequired("open_app", ["web_app"]);
    expectRequired("request_contact", []);
    expectRequired("request_geo_location", []);
    expectRequired("message", []);
  });

  it("uses only sender actions the schema enumerates", () => {
    const actions = schemas.SenderAction?.enum ?? [];
    for (const used of ["typing_on", "mark_seen"]) expect(actions).toContain(used);
  });

  it("handles only attachment types the schema defines", () => {
    const mapping = schemas.Attachment?.discriminator?.mapping ?? {};
    for (const used of ["image", "video", "audio", "file", "sticker", "inline_keyboard", "contact", "location", "share"]) {
      expect(Object.keys(mapping)).toContain(used);
    }
  });

  it("answers callbacks with the schema's CallbackAnswer shape", () => {
    const props = Object.keys(schemas.CallbackAnswer?.properties ?? {}).sort();
    expect(props).toEqual(["message", "notification"]);
  });

  it("reads platform transcription from the audio attachment field the schema declares", () => {
    const audio = schemas.AudioAttachment;
    expect(audio).toBeDefined();
    const partProps = (audio.allOf ?? []).flatMap((part) =>
      part.$ref ? [] : Object.keys(part.properties ?? {}),
    );
    expect(partProps).toContain("transcription");
  });
});

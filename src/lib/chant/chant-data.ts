// The one place the chant JSON is loaded for the app.
//
// Split out from chant.ts so that `npm test` can exercise the logic without
// resolving the "@/" alias, which Node does not know about.

import data from "@/data/chants/sri-rudram-saiveda.json";

import type { Chant } from "./chant.ts";

export const chant = data as Chant;

/**
 * The sections grouped into the works they belong to, in chanting order.
 *
 * Derived here rather than stored, because the JSON is generated and the
 * grouping is a reading of it rather than a fact about it. Sections without a
 * work fall into one bucket, which is what a single-anuvaka chant looks like.
 */
export function works(): { work: string; sections: Chant["anuvakas"] }[] {
  const out: { work: string; sections: Chant["anuvakas"] }[] = [];
  for (const section of chant.anuvakas) {
    const name = section.work ?? "";
    const last = out[out.length - 1];
    if (last && last.work === name) last.sections.push(section);
    else out.push({ work: name, sections: [section] });
  }
  return out;
}

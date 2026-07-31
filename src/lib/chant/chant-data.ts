// The one place the chant JSON is loaded for the app.
//
// Split out from chant.ts so that `npm test` can exercise the logic without
// resolving the "@/" alias, which Node does not know about.

import data from "@/data/chants/sri-rudram-namakam-anuvaka-1.json";

import type { Chant } from "./chant.ts";

export const chant = data as Chant;

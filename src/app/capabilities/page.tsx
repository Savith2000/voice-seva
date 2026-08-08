import type { Metadata } from "next";

import Capabilities from "@/components/Capabilities";

// What this browser can actually do, on the device holding it.
//
// This exists because the same optimisation has now been guessed at twice from
// the wrong machine. Everything here is read straight from the browser, loads
// no model, and is safe to leave reachable in production — it is a page you can
// open on the slow device and read out, which is faster and more honest than
// another round of inference about hardware nobody here can see.

export const metadata: Metadata = {
  title: "Device capabilities · Voice Seva",
  description: "What this browser can use to run the speech model.",
};

export default function CapabilitiesPage() {
  return <Capabilities />;
}

import type { Metadata } from "next";

import ChantingScreen from "@/components/ChantingScreen";

// The front door IS the app.
//
// A landing page used to live here, explaining what Voice Seva does with a
// button through to /chant. It read well and it was one click too many:
// somebody handed this link is holding a chant book, not evaluating a product,
// and the page they want is the one with the scripture on it.
//
// Everything the landing copy claimed — runs on this device, no account, no
// audio leaves the browser — is now said on the screen itself, in the colophon,
// where it sits next to the thing it describes instead of being a promise made
// on a previous page.

export const metadata: Metadata = {
  title: "Sri Rudram · Voice Seva",
  description:
    "Chant, and the script follows you. Runs entirely in the browser — no account, and no audio leaves the device.",
};

export default function Home() {
  return <ChantingScreen />;
}

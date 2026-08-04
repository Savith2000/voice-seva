import type { Metadata } from "next";

import ChantingScreen from "@/components/ChantingScreen";

export const metadata: Metadata = {
  title: "Sri Rudram · Voice Seva",
  description: "Chant, and the script follows you.",
};

export default function ChantPage() {
  return <ChantingScreen />;
}
